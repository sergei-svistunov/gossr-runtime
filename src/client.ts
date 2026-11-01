/**
 * GoSSR reactive-bindings runtime client.
 *
 * Manages WebSocket connections to reactive route /__ws endpoints.
 * Handles the full message lifecycle: init, patch, write, ack, err, and page
 * calls (call, result, fail).
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
 */

import { CallError, StatusReauth } from './protocol.js';
import type { CallFrame, FailFrame, ResultFrame, ServerFrame, WriteFrame } from './protocol.js';
import type { Calls, SsrClient } from './types.js';

// ---------------------------------------------------------------------------
// CSS.escape polyfill for environments that lack it (e.g. old jsdom versions)
// GoSSR binding keys are a route key and a local key joined by ".", where the
// local key is a variable name (Go identifier) or a lowercase hex hash, so they
// hold [a-zA-Z0-9_.]. Escaping keeps the selector valid for any other key.
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
// A 4000 close reconnects at once only after the connection was open this long;
// sooner, it waits the back-off, so a server that answers 4000 at once cannot loop.
const REAUTH_MIN_OPEN_MS = 30_000;
// After the tab is shown again, this many refused upgrades in a row are final.
const RESUME_MAX_REFUSALS = 3;

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
type BindingCallback = (value: string) => void;

// Handlers registered per SsrRuntime into the shared connection
interface RuntimeHandlers {
  onMessage(frame: ServerFrame): void;
  // Elements whose markup a frame replaced, after onMessage.
  onReplaced(elements: Element[]): void;
  onConnect(): void;
  onDisconnect(code: number, reason: string): void;
  onConnectError(status: number): void;
  // The connection was stopped for good.
  onStop(): void;
}

interface Registration {
  key: string;
  handlers: RuntimeHandlers;
}

// A page call that has no answer yet. gen is the generation of the socket it
// was sent on, or 0 while it waits for a socket to open.
interface PendingCall {
  gen: number;
  resolve(value: unknown): void;
  reject(err: CallError): void;
}

function connectionLost(): CallError {
  return new CallError(0, 'The connection was lost.');
}

// An inert document: markup parsed in it is never loaded or run.
let inert: Document | null = null;

function inertDocument(): Document {
  if (!inert) inert = document.implementation.createHTMLDocument('');
  return inert;
}

// A textarea of the inert document: markup set on it is read as text and
// entities are decoded.
let decoder: HTMLTextAreaElement | null = null;

function decodeText(markup: string): string {
  if (typeof document === 'undefined') return markup;
  if (!decoder) decoder = inertDocument().createElement('textarea');
  decoder.innerHTML = markup;
  return decoder.value;
}

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function isFormControl(el: Element): el is FormControl {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

// The markup the runtime last applied to an element, and an element's markup as
// the page had it before the runtime applied any. A block and the keys inside it
// are compared independently, so a patch to an inner key leaves the block's
// record stale; that is safe because the server renders a block and the keys
// inside it from one state, and sends an inner key's change with or after the
// block's own patch.
const appliedMarkup = new WeakMap<Element, string>();
const pageMarkup = new WeakMap<Element, string>();

// Records the markup of the page's live elements, as the server rendered it.
function rememberPageMarkup(): void {
  document.querySelectorAll('[data-ssr-bind]').forEach((el) => {
    if (!isFormControl(el) && !pageMarkup.has(el)) pageMarkup.set(el, el.innerHTML);
  });
}

// Reports whether el already holds markup: the markup last applied to it, or,
// before any, the page's markup for it, compared as the element serializes it.
function holds(el: Element, markup: string): boolean {
  const applied = appliedMarkup.get(el);
  if (applied !== undefined) return applied === markup;
  const probe = inertDocument().createElement(el.localName);
  probe.innerHTML = markup;
  return probe.innerHTML === (pageMarkup.get(el) ?? el.innerHTML);
}

function isChoice(el: Element): el is HTMLInputElement {
  return el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
}

// Sets a control's state from the decoded text of a value: a checkbox is checked
// by "true", a radio by its own value (never rewritten), any other control gets
// the text as its value.
function applyToControl(el: FormControl, markup: string): void {
  const text = decodeText(markup);
  if (!isChoice(el)) {
    el.value = text;
    return;
  }
  el.checked = el.type === 'checkbox' ? text === 'true' : text === el.value;
}

// The child-element indexes that lead from root down to node, or null when node
// is not inside root.
function pathFrom(root: Element, node: Element | null): number[] | null {
  if (!node || node === root || !root.contains(node)) return null;
  const path: number[] = [];
  for (let n: Element = node; n !== root; n = n.parentElement!) {
    path.unshift(Array.prototype.indexOf.call(n.parentElement!.children, n));
  }
  return path;
}

// Replaces el's markup. Focus inside el moves to the element at the same place
// in the new markup; a browser ignores focus() on an element that cannot take
// it, so focus is then left where the replacement put it.
function replaceMarkup(el: Element, markup: string): void {
  const path = pathFrom(el, document.activeElement);
  el.innerHTML = markup;
  if (!path) return;
  let target: Element | undefined = el;
  for (const i of path) target = target?.children[i];
  if (target instanceof HTMLElement || target instanceof SVGElement) target.focus({ preventScroll: true });
}

// The value is markup the server escaped. A form control gets its decoded text
// as state (a text control not while it has focus); any other element gets the
// markup unless it already holds it, and is returned when it got it.
function applyToElement(el: Element, markup: string): Element | null {
  if (isFormControl(el)) {
    if (isChoice(el) || el !== document.activeElement) applyToControl(el, markup);
    return null;
  }
  const unchanged = holds(el, markup);
  appliedMarkup.set(el, markup);
  if (unchanged) return null;
  replaceMarkup(el, markup);
  return el;
}

// Applies values to the elements of their binding keys and returns the elements
// whose markup was replaced.
function applyToDocument(values: [string, unknown][]): Element[] {
  const replaced: Element[] = [];
  if (typeof document === 'undefined') return replaced;
  for (const [key, html] of values) {
    if (typeof html !== 'string') continue;
    document.querySelectorAll('[data-ssr-bind="' + cssEscape(key) + '"]').forEach((el) => {
      const block = applyToElement(el, html);
      if (block) replaced.push(block);
    });
  }
  return replaced;
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
//   - init/patch: applied to the document once, then broadcast to ALL
//     registered handlers, which store the values and notify their listeners,
//     then to their onReplaced with the elements whose markup was replaced.
//   - err with code "unknown_route" and routeKey "": logged with console.warn,
//     NOT dispatched to any handler (internal protocol error, not validation feedback).
//   - err with a specific routeKey: dispatched only to the handler registered
//     for that routeKey.
//   - ack: dispatched only to the handler registered for that routeKey.
//   - result/fail: settle the page call with that id, if it was sent on the
//     socket that delivered the frame; any other is ignored with a warning.
//
// Connect, disconnect and connect-error events reach every runtime registered
// when the event happened, even when a handler stops the connection first.
// ---------------------------------------------------------------------------

class SharedWSConnection {
  private ws: WebSocket | null = null;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  // Stopped for good by stop(): every runtime on it, and any registered later, is stopped.
  private stopped = false;
  private everOpened = false;
  // Some socket of this connection has opened.
  private hasOpened = false;
  // A refused upgrade waits the back-off instead of going final: set when the
  // tab is shown again after an open connection, cleared when a socket opens
  // or when RESUME_MAX_REFUSALS upgrades in a row are refused.
  private retryRefusedUpgrade = false;
  // Upgrades refused in a row since a socket last opened.
  private refusals = 0;
  private openedAt = 0;
  // Closed by us while the tab is hidden; reopened when it is shown again.
  private paused = false;
  // Closed for good: by the server (1000, 1001) or by a refused upgrade (after
  // the tab is shown again, by RESUME_MAX_REFUSALS of them in a row).
  private finished = false;
  // Counts the sockets of this connection; the current socket has this number.
  private generation = 0;

  private readonly runtimes = new Set<Registration>();

  private nextCallId = 1;
  private readonly calls = new Map<number, PendingCall>();
  private readonly waitingCalls: CallFrame[] = [];

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.pause();
    } else {
      this.resume();
    }
  };

  constructor(private readonly wsUrl: string) {
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', rememberPageMarkup, { once: true });
      } else {
        rememberPageMarkup();
      }
      document.addEventListener('visibilitychange', this.onVisibilityChange);
      if (document.visibilityState === 'hidden') {
        // Opened in a hidden tab: connect when it is first shown.
        this.paused = true;
        return;
      }
    }
    this.connect();
  }

  /** Number of runtimes registered on this connection. */
  runtimeCount(): number {
    return this.runtimes.size;
  }

  /** Reports whether the connection is closed because the tab is hidden. */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Register a runtime's handlers under its routeKey. An empty routeKey (legacy
   * single-route usage) registers under a stable key. On a stopped connection
   * the runtime is stopped at once.
   */
  register(routeKey: string, handlers: RuntimeHandlers): Registration {
    const key = routeKey || '__legacy__';
    if (this.stopped) {
      handlers.onStop();
      return { key, handlers };
    }
    for (const r of this.runtimes) {
      if (r.key === key) {
        console.warn('[gossr] Two runtimes on this page share the route key "' + routeKey + '".');
        break;
      }
    }
    const registration = { key, handlers };
    this.runtimes.add(registration);
    return registration;
  }

  /** Unregister a runtime's handlers. If no handlers remain, destroy the connection. */
  unregister(registration: Registration): void {
    this.runtimes.delete(registration);
    if (this.runtimes.size === 0) {
      this.destroy();
      sharedConnections.delete(this.wsUrl);
    }
  }

  private forEachHandlers(fn: (h: RuntimeHandlers) => void): void {
    this.runtimes.forEach((r) => fn(r.handlers));
  }

  // Runs fn for every runtime registered now, even one an earlier call stops.
  private notifyAll(fn: (h: RuntimeHandlers) => void): void {
    [...this.runtimes].forEach((r) => fn(r.handlers));
  }

  private forEachHandlersOf(key: string, fn: (h: RuntimeHandlers) => void): void {
    this.runtimes.forEach((r) => {
      if (r.key === key) fn(r.handlers);
    });
  }

  /** Send a frame over the shared WS. */
  sendFrame(frame: WriteFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
    // If disconnected (reconnect in progress), the write is silently dropped.
    // This matches fire-and-forget semantics (spec section 3.5).
  }

  /**
   * Runs a page call. It is sent at once on an open socket, else when the next
   * socket opens; it rejects at once when the connection is closed for good.
   */
  call(routeKey: string, name: string, args: unknown): Promise<unknown> {
    if (this.destroyed || this.finished) return Promise.reject(connectionLost());
    const frame: CallFrame = { t: 'call', id: this.nextCallId++, routeKey, name, args: args ?? null };
    return new Promise((resolve, reject) => {
      this.calls.set(frame.id, { gen: 0, resolve, reject });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendCall(this.ws, this.generation, frame);
      } else {
        this.waitingCalls.push(frame);
      }
    });
  }

  // gen is the generation of ws.
  private sendCall(ws: WebSocket, gen: number, frame: CallFrame): void {
    const pending = this.calls.get(frame.id);
    if (!pending) return;
    ws.send(JSON.stringify(frame));
    pending.gen = gen;
  }

  private settleCall(frame: ResultFrame | FailFrame, gen: number): void {
    const pending = this.calls.get(frame.id);
    if (!pending || pending.gen !== gen) {
      console.warn('[gossr] Ignoring a ' + frame.t + ' frame for a call this connection did not send.');
      return;
    }
    this.calls.delete(frame.id);
    if (frame.t === 'result') {
      pending.resolve(frame.value);
    } else {
      pending.reject(new CallError(frame.status, frame.msg));
    }
  }

  // Rejects the calls in flight on a socket that closed; waiting calls stay.
  private rejectSentCalls(): void {
    this.calls.forEach((pending, id) => {
      if (pending.gen === 0) return;
      this.calls.delete(id);
      pending.reject(connectionLost());
    });
  }

  // Rejects the calls waiting for a socket; calls made later wait for the next one.
  private rejectWaitingCalls(): void {
    this.waitingCalls.splice(0).forEach((frame) => {
      const pending = this.calls.get(frame.id);
      if (!pending) return;
      this.calls.delete(frame.id);
      pending.reject(connectionLost());
    });
  }

  private rejectAllCalls(): void {
    const calls = [...this.calls.values()];
    this.calls.clear();
    this.waitingCalls.length = 0;
    calls.forEach((pending) => pending.reject(connectionLost()));
  }

  private finish(): void {
    this.finished = true;
    this.rejectAllCalls();
  }

  // Closes for good after a refused upgrade.
  private refuse(): void {
    this.finish();
    console.error('[gossr] WebSocket upgrade failed for: ' + this.wsUrl);
    this.notifyAll((h) => h.onConnectError(0));
  }

  private connect(): void {
    if (this.destroyed) return;

    // A socket abandoned before its close event can no longer answer its calls.
    if (this.ws) this.rejectSentCalls();
    this.everOpened = false;
    const gen = ++this.generation;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (ws !== this.ws) return;
      this.everOpened = true;
      this.hasOpened = true;
      this.retryRefusedUpgrade = false;
      this.refusals = 0;
      this.openedAt = Date.now();
      this.waitingCalls.splice(0).forEach((frame) => this.sendCall(ws, gen, frame));
      this.notifyAll((h) => h.onConnect());
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      this.handleMessage(event.data as string, gen, ws === this.ws);
    });

    ws.addEventListener('error', () => {
      if (ws !== this.ws || this.paused || this.retryRefusedUpgrade) return;
      // Do not reconnect: cannot distinguish 4xx from 5xx at the WebSocket API level.
      if (!this.everOpened) this.refuse();
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.rejectSentCalls();

      // Our own 1000 from pause(): not the server's final close.
      if (this.paused) return;

      const { code, reason } = event;

      if (!this.everOpened) {
        if (this.retryRefusedUpgrade) {
          if (++this.refusals >= RESUME_MAX_REFUSALS) {
            this.retryRefusedUpgrade = false;
            this.refuse();
            return;
          }
          this.rejectWaitingCalls();
          this.scheduleReconnect();
          return;
        }
        // Upgrade failure: already handled in onerror. Do not reconnect.
        this.finish();
        return;
      }

      if (code === 1000) {
        // Normal closure (page navigated away or explicit destroy). No reconnect.
        this.finish();
        return;
      }

      if (code === 1008) {
        console.warn('[gossr] The server closed the connection (1008): ' + reason);
      }

      if (code === 1001) {
        this.finish();
        this.notifyAll((h) => h.onDisconnect(code, reason));
        return;
      }

      this.notifyAll((h) => h.onDisconnect(code, reason));
      if (code === StatusReauth && Date.now() - this.openedAt >= REAUTH_MIN_OPEN_MS) {
        this.connect();
        return;
      }
      this.scheduleReconnect();
    });
  }

  private pause(): void {
    if (this.destroyed || this.finished || this.paused) return;
    this.paused = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close(1000, 'hidden');
    this.rejectSentCalls();
  }

  private resume(): void {
    if (this.destroyed || this.finished || !this.paused) return;
    this.paused = false;
    this.retryCount = 0;
    this.retryRefusedUpgrade = this.hasOpened;
    this.connect();
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

  // gen is the generation of the socket that delivered the frame; live reports
  // whether it is still the current socket.
  private handleMessage(raw: string, gen: number, live: boolean): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      if (live) console.warn('[gossr] Received unparseable WebSocket message; ignoring.');
      return;
    }
    if (typeof frame !== 'object' || frame === null) {
      if (live) console.warn('[gossr] Received a frame that is not an object; ignoring.');
      return;
    }

    if (frame.t === 'result' || frame.t === 'fail') {
      this.settleCall(frame, gen);
      return;
    }
    if (!live) return;

    switch (frame.t) {
      case 'init':
        if (typeof frame.bindings !== 'object' || frame.bindings === null) {
          console.warn('[gossr] Received init frame without bindings; ignoring.');
          return;
        }
        // Reset retry counter when a valid init is received — connection fully established.
        this.retryCount = 0;
        this.applyValues(frame, Object.entries(frame.bindings));
        break;

      case 'patch':
        this.applyValues(frame, [[frame.key, frame.html]]);
        break;

      case 'ack':
        // Route to the handler owning the acknowledged write's routeKey.
        this.forEachHandlersOf(frame.routeKey, (h) => h.onMessage(frame));
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
        this.forEachHandlersOf(frame.routeKey, (h) => h.onMessage(frame));
        break;

      default:
        console.warn('[gossr] Unknown frame type received; ignoring.');
    }
  }

  private applyValues(frame: ServerFrame, values: [string, unknown][]): void {
    const replaced = applyToDocument(values);
    this.forEachHandlers((h) => h.onMessage(frame));
    if (replaced.length > 0) this.forEachHandlers((h) => h.onReplaced(replaced));
  }

  /**
   * Closes the connection for good and stops every runtime on it. It stays in
   * the registry, so a runtime created for its URL later is stopped too.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.destroy('stopped');
    const runtimes = [...this.runtimes];
    this.runtimes.clear();
    runtimes.forEach((r) => r.handlers.onStop());
  }

  destroy(reason = 'destroyed'): void {
    this.destroyed = true;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, reason);
    this.rejectAllCalls();
  }
}

// ---------------------------------------------------------------------------
// Module-level registry of shared connections, keyed by wsUrl.
// Exported for test access via getSharedConnectionRegistry().
// ---------------------------------------------------------------------------

const sharedConnections = new Map<string, SharedWSConnection>();

// The registry is per copy of this module: a bundle that runs it more than once
// on a page, one webpack runtime per entry, opens one connection per copy.
const pageMark = Symbol.for('gossr-runtime');
const pageGlobal = globalThis as Record<symbol, unknown>;
if (pageGlobal[pageMark]) {
  console.warn(
    '[gossr] gossr-runtime runs more than once on this page, so each copy opens its own live connection. ' +
      "Bundle the page's entries with one webpack runtime: optimization.runtimeChunk: 'single'.",
  );
}
pageGlobal[pageMark] = true;

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
  W extends Partial<R> = Partial<Record<keyof R, never>>,
  C extends Calls = Record<string, never>
> implements SsrClient<R, W, C> {
  // Last known value per binding key (full namespaced key: routeKey.localKey)
  private readonly bindings = new Map<string, string>();

  // Per-key subscribers (full namespaced key)
  private readonly listeners = new Map<string, Set<BindingCallback>>();

  // Lifecycle hook registries
  private readonly connectCbs = new Set<ConnectCallback>();
  private readonly disconnectCbs = new Set<DisconnectCallback>();
  private readonly connectErrorCbs = new Set<ConnectErrorCallback>();
  private readonly errorCbs = new Set<ErrorCallback>();

  private destroyed = false;
  // Aborted by destroy() to remove this runtime's DOM listeners.
  private readonly domListeners = new AbortController();
  // The ssr:bind controls this runtime has wired.
  private readonly wired = new WeakSet<Element>();
  private readonly sharedConn: SharedWSConnection;
  private readonly registration: Registration;

  constructor(
    private readonly wsUrl: string,
    private readonly routeKey: string = '',
  ) {
    // Get or create the shared connection for this wsUrl
    this.sharedConn = getOrCreateSharedConnection(wsUrl);

    this.registration = this.sharedConn.register(routeKey, {
      onMessage: (frame) => this.handleFrame(frame),
      onReplaced: (elements) => elements.forEach((el) => {
        if (!this.destroyed && el.isConnected) this.wireSsrBindElements(el);
      }),
      onConnect: () => this.fireConnect(),
      onDisconnect: (code, reason) => this.fireDisconnect(code, reason),
      onConnectError: (status) => this.fireConnectError(status),
      onStop: () => this.close(),
    });

    // Wire ssr:bind elements after DOM is ready
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.wireSsrBindElements(), {
          signal: this.domListeners.signal,
        });
      } else {
        this.wireSsrBindElements();
      }
    }
  }

  // -------------------------------------------------------------------------
  // SsrClient public API
  // -------------------------------------------------------------------------

  get<K extends keyof R>(name: K): string | undefined {
    return this.bindings.get(this.bindingKeyOf(name as string));
  }

  set<K extends keyof W>(name: K, value: W[K]): void {
    if (this.destroyed) {
      console.warn('[gossr] Ignoring set("' + String(name) + '") on a stopped or destroyed runtime.');
      return;
    }
    const frame: WriteFrame = {
      t: 'write',
      routeKey: this.routeKey,
      var: name as string,
      value,
    };
    this.sharedConn.sendFrame(frame);
  }

  call<K extends keyof C & string>(name: K, args: C[K]['in']): Promise<C[K]['out']> {
    if (this.destroyed) return Promise.reject(connectionLost());
    return this.sharedConn.call(this.routeKey, name, args) as Promise<C[K]['out']>;
  }

  on<K extends keyof R>(name: K, callback: (value: string) => void): () => void {
    const key = this.bindingKeyOf(name as string);
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
   * Permanently close the runtime: removes its ssr:bind listeners and leaves the
   * shared connection, which closes when no runtime is left on it.
   * Not part of the SsrClient interface.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.close();
    this.sharedConn.unregister(this.registration);
  }

  stop(): void {
    this.sharedConn.stop();
  }

  private close(): void {
    this.destroyed = true;
    this.domListeners.abort();
  }

  // -------------------------------------------------------------------------
  // Frame handling (called by SharedWSConnection)
  // -------------------------------------------------------------------------

  private handleFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case 'init':
        // The shared connection has applied the values to the document; each
        // runtime stores all of them, keyed by full namespaced key.
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

  private applyBinding(key: string, html: unknown): void {
    if (typeof html !== 'string') {
      console.warn('[gossr] Binding "' + key + '" has a value that is not a string; ignoring.');
      return;
    }
    this.bindings.set(key, html);

    // Notify per-key subscribers (ssr.on handlers).
    // For ssr.on, developers use short variable names (e.g. "counter").
    // We also notify listeners on the full namespaced key for completeness.
    const subscribers = this.listeners.get(key);
    if (subscribers) {
      subscribers.forEach((cb) => cb(html));
    }
  }

  private handleErr(varName: string, message: string): void {
    // Reset bound inputs to the last accepted value; with none known, leave them as they are.
    if (typeof document !== 'undefined') {
      // The bare key covers a server that sends keys without the route prefix.
      const lastValue = this.bindings.get(this.bindingKeyOf(varName)) ?? this.bindings.get(varName);
      if (lastValue !== undefined) this.resetBoundElements(varName, lastValue);
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
    document.querySelectorAll<FormControl>('input, select, textarea').forEach((el) => {
      if (el.getAttribute('ssr:bind') === varName && this.claimsInput(el)) {
        applyToControl(el, value);
      }
    });
  }

  // -------------------------------------------------------------------------
  // ssr:bind auto-wiring (spec section 3.5)
  // -------------------------------------------------------------------------

  /** The namespaced binding key under which the server sends this route's variable. */
  private bindingKeyOf(varName: string): string {
    return this.routeKey ? this.routeKey + '.' + varName : varName;
  }

  /**
   * Reports whether an ssr:bind input belongs to this route: its data-ssr-route
   * names this route, or it has none and this is the only route on the page.
   */
  private claimsInput(el: Element): boolean {
    const route = el.getAttribute('data-ssr-route');
    if (route !== null) return route === this.routeKey;
    return this.sharedConn.runtimeCount() === 1;
  }

  /**
   * Discovers the [ssr:bind] elements in root and wires each one not yet wired
   * bidirectionally:
   *  - element change/input event -> sends write frame to server
   *  - server patch -> updates element .value
   *
   * Called for the document after DOMContentLoaded (or immediately if DOM is
   * already ready), and for each element whose markup a frame replaced. The echo
   * of a control wired inside such an element stops once it leaves the document.
   */
  private wireSsrBindElements(root?: Element): void {
    if (typeof document === 'undefined') return;

    // Use getAttribute-based iteration instead of a CSS [ssr\:bind] selector.
    // The colon in the attribute name is a CSS namespace separator, which causes
    // querySelectorAll('[ssr\\:bind]') to return 0 elements in jsdom and may also
    // fail in certain browser CSS parser implementations.
    (root ?? document).querySelectorAll<FormControl>('input, select, textarea').forEach((el) => {
      const varName = el.getAttribute('ssr:bind');
      if (!varName || this.wired.has(el)) return;
      this.wired.add(el);

      const tag = el.tagName.toLowerCase();
      const event = this.chooseBindEvent(el, tag);

      // element -> server: fire write frame on user interaction
      el.addEventListener(event, () => {
        if (!this.claimsInput(el)) return;
        const value = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
        this.set(varName as keyof W, value as W[keyof W]);
      }, { signal: this.domListeners.signal });

      // server -> element: apply a patch for this route's variable, but not to a
      // text control while it has focus
      const off = this.on(varName as keyof R, (value: string) => {
        if (root && !el.isConnected) {
          off();
          return;
        }
        if (!this.claimsInput(el)) return;
        if (isChoice(el) || el !== document.activeElement) applyToControl(el, value);
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
  W extends Partial<R> = Partial<Record<keyof R, never>>,
  C extends Calls = Record<string, never>
>(options: CreateSsrClientOptions | string): SsrClient<R, W, C> {
  // Accept legacy string argument for backward compatibility during migration.
  if (typeof options === 'string') {
    return new SsrRuntime<R, W, C>(options, '');
  }
  return new SsrRuntime<R, W, C>(options.wsUrl, options.routeKey);
}
