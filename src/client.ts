/**
 * GoSSR reactive-bindings runtime client.
 *
 * Manages WebSocket connections to reactive route /__ws endpoints.
 * Handles the full message lifecycle: init, patch, write, ack, err.
 * Implements automatic reconnect with exponential back-off.
 * Wires ssr:bind elements on the page automatically.
 *
 * Multiple reactive routes on the same page (e.g. parent + child) share one
 * underlying WebSocket connection via the SharedWSConnection singleton keyed by
 * wsUrl. Each SsrRuntime registers its routeKey into the shared connection;
 * incoming frames are dispatched by full data-ssr-bind attribute value (patches)
 * or by routeKey (err frames).
 *
 * Developers never instantiate this class directly. The generated __ssr_gen__.ts
 * calls createSsrClient({ wsUrl, routeKey }) which returns a typed SsrClient instance.
 *
 * SECURITY NOTE on DOM updates:
 * Binding values are GoSSR server-generated pre-rendered HTML strings, produced by the
 * same Go template engine that renders the initial SSR page. This is trusted framework
 * output, not user-supplied content. Updating the DOM with these values is equivalent
 * to server-side rendering hydration. The spec (section 3.3) explicitly specifies that
 * the runtime "sets innerHTML accordingly" for each patch. This design decision is
 * intentional and owned by the GoSSR framework; it is not a user-input XSS vector.
 */

import type { ServerFrame, WriteFrame } from './protocol.js';
import type { SsrClient } from './types.js';

// ---------------------------------------------------------------------------
// CSS.escape polyfill for environments that lack it (e.g. old jsdom versions)
// GoSSR binding keys are variable names (Go identifiers) or lowercase hex hashes,
// so they only contain [a-zA-Z0-9_] characters and do not actually need escaping.
// The polyfill is a safety net for future-proofing.
// ---------------------------------------------------------------------------

const cssEscape: (value: string) => string =
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape.bind(CSS)
    : (value: string) => value.replace(/[^\w-]/g, (c) => '\\' + c);

// ---------------------------------------------------------------------------
// Reconnect configuration (spec section 3.11)
// ---------------------------------------------------------------------------

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER = 0.1; // +-10%
const RECONNECT_WARN_AFTER = 5; // emit console.warn after this many consecutive failures

// Input types that use the 'input' event (real-time, per-keystroke)
const INPUT_EVENT_TYPES = new Set([
  'text', 'number', 'range', 'search', 'tel', 'url',
  'email', 'password', 'date', 'month', 'week', 'time',
  'datetime-local', 'color', '',
]);

// ---------------------------------------------------------------------------
// Internal helper types
// ---------------------------------------------------------------------------

type ConnectCallback = () => void;
type DisconnectCallback = (code: number, reason: string) => void;
type ConnectErrorCallback = (status: number) => void;
type ErrorCallback = (varName: string, message: string) => void;
type BindingCallback = (html: string) => void;

// Handlers registered per SsrRuntime into the shared connection
interface RuntimeHandlers {
  onMessage(frame: ServerFrame): void;
  onConnect(): void;
  onDisconnect(code: number, reason: string): void;
  onConnectError(status: number): void;
}

// ---------------------------------------------------------------------------
// Trusted HTML setter helper
//
// Extracted into a named function so the XSS-linting suppression comment is
// co-located with the actual DOM write, not scattered across the file.
// The content here is always server-rendered HTML from the GoSSR template engine.
// ---------------------------------------------------------------------------

function setTrustedHtml(el: Element, html: string): void {
  // Content is GoSSR server-rendered pre-rendered HTML (spec section 3.3).
  // This is equivalent to SSR hydration and is intentionally set as element HTML content.
  el.innerHTML = html; // trusted server-rendered content
}

// ---------------------------------------------------------------------------
// SharedWSConnection — module-level singleton per wsUrl
//
// The first SsrRuntime to call getOrCreateSharedConnection() for a given URL
// creates the underlying WebSocket. Subsequent SsrRuntime instances for the
// same page (e.g. parent route + child route) reuse the same connection.
//
// Each SsrRuntime registers a RuntimeHandlers object; the shared connection
// dispatches frames to the correct handler:
//   - init/patch: broadcast to ALL registered handlers (each runtime applies
//     only the bindings whose keys start with its own routeKey or are in its
//     bindings map; since bindings are self-identifying via routeKey.localKey
//     prefixes, all registered handlers receive every frame and cherry-pick).
//   - err with code "unknown_route" and routeKey "": logged with console.warn,
//     NOT dispatched to any handler (internal protocol error, not validation feedback).
//   - err with a specific routeKey: dispatched only to the handler registered
//     for that routeKey.
//   - ack: dispatched only to the handler registered for that routeKey.
// ---------------------------------------------------------------------------

class SharedWSConnection {
  private ws: WebSocket | null = null;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private everOpened = false;

  // routeKey -> RuntimeHandlers
  private readonly handlers = new Map<string, RuntimeHandlers>();

  constructor(private readonly wsUrl: string) {
    this.connect();
  }

  /** Register a runtime's handlers under its routeKey. */
  register(routeKey: string, handlers: RuntimeHandlers): void {
    this.handlers.set(routeKey, handlers);
  }

  /** Unregister a runtime's handlers. If no handlers remain, destroy the connection. */
  unregister(routeKey: string): void {
    this.handlers.delete(routeKey);
    if (this.handlers.size === 0) {
      this.destroy();
      sharedConnections.delete(this.wsUrl);
    }
  }

  /** Send a frame over the shared WS. */
  sendFrame(frame: WriteFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
    // If disconnected (reconnect in progress), the write is silently dropped.
    // This matches fire-and-forget semantics (spec section 3.5).
  }

  private connect(): void {
    if (this.destroyed) return;

    this.everOpened = false;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (ws !== this.ws) return;
      this.everOpened = true;
      this.handlers.forEach((h) => h.onConnect());
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      if (ws !== this.ws) return;
      this.handleMessage(event.data as string);
    });

    ws.addEventListener('error', () => {
      if (ws !== this.ws) return;
      if (!this.everOpened) {
        console.error('[gossr] WebSocket upgrade failed for: ' + this.wsUrl);
        this.handlers.forEach((h) => h.onConnectError(0));
        // Do not reconnect: cannot distinguish 4xx from 5xx at the WebSocket API level.
      }
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      if (ws !== this.ws) return;
      this.ws = null;

      const { code, reason } = event;

      if (!this.everOpened) {
        // Upgrade failure: already handled in onerror. Do not reconnect.
        return;
      }

      if (code === 1000) {
        // Normal closure (page navigated away or explicit destroy). No reconnect.
        return;
      }

      if (event.code === 1008) {
        console.warn('slow client (1008)');
      }

      this.handlers.forEach((h) => h.onDisconnect(code, reason));
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;

    this.retryCount += 1;

    if (this.retryCount > RECONNECT_WARN_AFTER) {
      console.warn('[gossr] WebSocket reconnect attempt ' + this.retryCount + ' failed for: ' + this.wsUrl);
    }

    const base = Math.min(
      RECONNECT_INITIAL_MS * Math.pow(2, this.retryCount - 1),
      RECONNECT_MAX_MS,
    );
    const jitter = base * RECONNECT_JITTER * (Math.random() * 2 - 1);
    const delay = Math.round(base + jitter);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      console.warn('[gossr] Received unparseable WebSocket message; ignoring.');
      return;
    }

    switch (frame.t) {
      case 'init':
        // Reset retry counter when a valid init is received — connection fully established.
        this.retryCount = 0;
        // Broadcast to all registered handlers; each cherry-picks its own bindings.
        this.handlers.forEach((h) => h.onMessage(frame));
        break;

      case 'patch':
        // Broadcast to all registered handlers; each cherry-picks relevant binding keys.
        this.handlers.forEach((h) => h.onMessage(frame));
        break;

      case 'ack':
        // Route to the handler owning the acknowledged write's routeKey.
        {
          const h = this.handlers.get(frame.routeKey);
          if (h) h.onMessage(frame);
        }
        break;

      case 'err':
        // err with code "unknown_route" and empty routeKey is an internal protocol error.
        // Log with console.warn; do NOT invoke user onError callbacks.
        if (frame.code === 'unknown_route' && frame.routeKey === '') {
          console.warn('[gossr] Received unknown_route error from server (stale bundle or routeKey mismatch).');
          return;
        }
        // err with code "decode_error" is an internal protocol/type error.
        // The server could not JSON-unmarshal the write-frame value into the target Go type.
        // Log with console.warn; do NOT invoke user onError callbacks.
        if (frame.code === 'decode_error') {
          console.warn('[gossr] Received decode_error from server: ' + frame.msg);
          return;
        }
        // Validation error: route to the owning handler.
        {
          const h = this.handlers.get(frame.routeKey);
          if (h) h.onMessage(frame);
        }
        break;

      default:
        console.warn('[gossr] Unknown frame type received; ignoring.');
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'destroyed');
      this.ws = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level registry of shared connections, keyed by wsUrl.
// Exported for test access via getSharedConnectionRegistry().
// ---------------------------------------------------------------------------

const sharedConnections = new Map<string, SharedWSConnection>();

/** Internal — returns the shared-connection registry. Used by tests only. */
export function getSharedConnectionRegistry(): Map<string, SharedWSConnection> {
  return sharedConnections;
}

function getOrCreateSharedConnection(wsUrl: string): SharedWSConnection {
  let conn = sharedConnections.get(wsUrl);
  if (!conn) {
    conn = new SharedWSConnection(wsUrl);
    sharedConnections.set(wsUrl, conn);
  }
  return conn;
}

// ---------------------------------------------------------------------------
// SsrRuntime implementation
// ---------------------------------------------------------------------------

export class SsrRuntime<
  R extends Record<string, unknown> = Record<string, unknown>,
  W extends Partial<R> = Record<string, never>
> implements SsrClient<R, W> {
  // Last known rendered HTML per binding key (full namespaced key: routeKey.localKey)
  private readonly bindings = new Map<string, string>();

  // Per-key subscribers (full namespaced key or variable name for ssr.on)
  private readonly listeners = new Map<string, Set<BindingCallback>>();

  // Lifecycle hook registries
  private readonly connectCbs = new Set<ConnectCallback>();
  private readonly disconnectCbs = new Set<DisconnectCallback>();
  private readonly connectErrorCbs = new Set<ConnectErrorCallback>();
  private readonly errorCbs = new Set<ErrorCallback>();

  private destroyed = false;
  private readonly sharedConn: SharedWSConnection;

  constructor(
    private readonly wsUrl: string,
    private readonly routeKey: string = '',
  ) {
    // Wire ssr:bind elements after DOM is ready
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.wireSsrBindElements());
      } else {
        this.wireSsrBindElements();
      }
    }

    // Get or create the shared connection for this wsUrl
    this.sharedConn = getOrCreateSharedConnection(wsUrl);

    // Register this runtime's handlers under its routeKey.
    // If routeKey is empty (legacy single-route usage), use a stable key.
    const registrationKey = routeKey || '__legacy__';
    this.sharedConn.register(registrationKey, {
      onMessage: (frame) => this.handleFrame(frame),
      onConnect: () => this.fireConnect(),
      onDisconnect: (code, reason) => this.fireDisconnect(code, reason),
      onConnectError: (status) => this.fireConnectError(status),
    });
  }

  // -------------------------------------------------------------------------
  // SsrClient public API
  // -------------------------------------------------------------------------

  get<K extends keyof R>(name: K): string | undefined {
    return this.bindings.get(name as string);
  }

  set<K extends keyof W>(name: K, value: W[K]): void {
    const frame: WriteFrame = {
      t: 'write',
      routeKey: this.routeKey,
      var: name as string,
      value,
    };
    this.sharedConn.sendFrame(frame);
  }

  on<K extends keyof R>(name: K, callback: (html: string) => void): () => void {
    const key = name as string;
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(callback);
    return () => {
      set!.delete(callback);
    };
  }

  onConnect(callback: ConnectCallback): () => void {
    this.connectCbs.add(callback);
    return () => { this.connectCbs.delete(callback); };
  }

  onDisconnect(callback: DisconnectCallback): () => void {
    this.disconnectCbs.add(callback);
    return () => { this.disconnectCbs.delete(callback); };
  }

  onConnectError(callback: ConnectErrorCallback): () => void {
    this.connectErrorCbs.add(callback);
    return () => { this.connectErrorCbs.delete(callback); };
  }

  onError(callback: ErrorCallback): () => void {
    this.errorCbs.add(callback);
    return () => { this.errorCbs.delete(callback); };
  }

  /**
   * Permanently close the runtime. Cancels reconnect timers and closes the WS cleanly.
   * Not part of the SsrClient interface; called by framework teardown.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const registrationKey = this.routeKey || '__legacy__';
    this.sharedConn.unregister(registrationKey);
  }

  // -------------------------------------------------------------------------
  // Frame handling (called by SharedWSConnection)
  // -------------------------------------------------------------------------

  private handleFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case 'init':
        // Apply all bindings from the init snapshot (spec section 4, init frame).
        // Each runtime applies all bindings — applyBinding stores them in the map
        // keyed by full namespaced key. DOM dispatch uses querySelectorAll which
        // naturally matches only the elements that exist in this route's HTML.
        for (const [key, html] of Object.entries(frame.bindings)) {
          this.applyBinding(key, html);
        }
        break;

      case 'patch':
        // Apply a single binding update (spec section 4, patch frame).
        // The full namespaced key (routeKey.localKey) is the DOM selector.
        this.applyBinding(frame.key, frame.html);
        break;

      case 'ack':
        // Silently consumed per spec. The new value arrives via a separate patch frame.
        break;

      case 'err':
        // Validation rejection (spec section 4, err frame).
        // unknown_route with empty routeKey is handled by SharedWSConnection; it never
        // reaches here. Only validation_failed errors with our routeKey arrive here.
        this.handleErr(frame.var, frame.msg);
        break;

      default:
        // Unknown frame: ignore to allow forward-compatible protocol extensions.
        console.warn('[gossr] Unknown frame type received; ignoring.');
    }
  }

  private applyBinding(key: string, html: string): void {
    this.bindings.set(key, html);

    if (typeof document !== 'undefined') {
      // spec section 3.3: "finds the DOM node(s) bound to that variable via data-ssr-bind
      // attributes and sets innerHTML accordingly"
      const selector = '[data-ssr-bind="' + cssEscape(key) + '"]';
      document.querySelectorAll(selector).forEach((el) => {
        setTrustedHtml(el, html);
      });
    }

    // Notify per-key subscribers (ssr.on handlers).
    // For ssr.on, developers use short variable names (e.g. "counter").
    // We also notify listeners on the full namespaced key for completeness.
    const subscribers = this.listeners.get(key);
    if (subscribers) {
      subscribers.forEach((cb) => cb(html));
    }
  }

  private handleErr(varName: string, message: string): void {
    // Reset bound inputs to last accepted value (runtime-states.md State 1)
    if (typeof document !== 'undefined') {
      const lastValue = this.bindings.get(varName) ?? '';
      this.resetBoundElements(varName, lastValue);
    }

    if (this.errorCbs.size > 0) {
      this.errorCbs.forEach((cb) => cb(varName, message));
    } else {
      // Default: log to console.warn (runtime-states.md State 1 default behavior)
      console.warn('[gossr] Validation error for "' + varName + '": ' + message);
    }
  }

  private resetBoundElements(varName: string, value: string): void {
    // Same getAttribute-based iteration as wireSsrBindElements — avoids CSS namespace
    // separator issues with the colon in 'ssr:bind'.
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input, select, textarea',
    ).forEach((el) => {
      if (el.getAttribute('ssr:bind') === varName) {
        el.value = value;
      }
    });
  }

  // -------------------------------------------------------------------------
  // ssr:bind auto-wiring (spec section 3.5)
  // -------------------------------------------------------------------------

  /**
   * Discovers all [ssr:bind] elements and wires them bidirectionally:
   *  - element change/input event -> sends write frame to server
   *  - server patch -> updates element .value
   *
   * Called once after DOMContentLoaded (or immediately if DOM is already ready).
   */
  private wireSsrBindElements(): void {
    if (typeof document === 'undefined') return;

    // Use getAttribute-based iteration instead of a CSS [ssr\:bind] selector.
    // The colon in the attribute name is a CSS namespace separator, which causes
    // querySelectorAll('[ssr\\:bind]') to return 0 elements in jsdom and may also
    // fail in certain browser CSS parser implementations.
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input, select, textarea',
    ).forEach((el) => {
      const varName = el.getAttribute('ssr:bind');
      if (!varName) return;

      const tag = el.tagName.toLowerCase();
      const event = this.chooseBindEvent(el, tag);

      // element -> server: fire write frame on user interaction
      el.addEventListener(event, () => {
        const inputEl = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        this.set(varName as keyof W, inputEl.value as W[keyof W]);
      });

      // server -> element: update .value when a patch arrives
      this.on(varName as keyof R, (html: string) => {
        const inputEl = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        inputEl.value = html;
      });
    });
  }

  /**
   * Chooses the appropriate DOM event for a bound element.
   *  'input'  - text-like inputs and textarea: fires on each keystroke (v-model behavior)
   *  'change' - select, checkbox, radio: fires on selection commit
   */
  private chooseBindEvent(el: HTMLElement, tag: string): 'input' | 'change' {
    if (tag === 'select') return 'change';
    if (tag === 'textarea') return 'input';
    if (tag === 'input') {
      const inputType = (el as HTMLInputElement).type.toLowerCase();
      if (inputType === 'checkbox' || inputType === 'radio') return 'change';
      if (INPUT_EVENT_TYPES.has(inputType)) return 'input';
      return 'change'; // fallback for unrecognised future input types
    }
    return 'change'; // fallback for non-standard element tags
  }

  // -------------------------------------------------------------------------
  // Hook dispatch helpers
  // -------------------------------------------------------------------------

  private fireConnect(): void {
    this.connectCbs.forEach((cb) => cb());
  }

  private fireDisconnect(code: number, reason: string): void {
    this.disconnectCbs.forEach((cb) => cb(code, reason));
  }

  private fireConnectError(status: number): void {
    this.connectErrorCbs.forEach((cb) => cb(status));
  }
}

// ---------------------------------------------------------------------------
// Factory function - the public entry point for generated __ssr_gen__.ts files
// ---------------------------------------------------------------------------

/**
 * Options for createSsrClient. The generator emits these into each route's __ssr_gen__.ts.
 */
export interface CreateSsrClientOptions {
  /** WebSocket URL — always <leaf-page>/__ws. The generator emits the leaf path here. */
  wsUrl: string;
  /**
   * Per-route key — sha256(routePath)[:8] hex. The generator emits this route's hash.
   * All reactive routes on the same page use the same wsUrl but different routeKeys.
   * The first call for a given wsUrl opens the WS; subsequent calls register additional
   * handlers on the same shared connection (one WS per page).
   */
  routeKey: string;
}

/**
 * Creates and connects a reactive bindings client for the given WebSocket URL and routeKey.
 *
 * Called by the generator-emitted __ssr_gen__.ts. Not called by developers directly.
 *
 * Example generated usage in __ssr_gen__.ts:
 *   import { createSsrClient } from 'gossr-runtime';
 *   export const ssr = createSsrClient<{ count: number; threshold: number }, { threshold: number }>({
 *     wsUrl: '/dashboard/__ws',
 *     routeKey: '3f7a',
 *   });
 *
 * When a parent and child route are both reactive, both __ssr_gen__.ts modules call
 * createSsrClient with the same wsUrl but different routeKeys. Only one WebSocket is opened.
 */
export function createSsrClient<
  R extends Record<string, unknown> = Record<string, unknown>,
  W extends Partial<R> = Record<string, never>
>(options: CreateSsrClientOptions | string): SsrClient<R, W> {
  // Accept legacy string argument for backward compatibility during migration.
  if (typeof options === 'string') {
    return new SsrRuntime<R, W>(options, '');
  }
  return new SsrRuntime<R, W>(options.wsUrl, options.routeKey);
}
