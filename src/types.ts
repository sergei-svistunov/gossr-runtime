/**
 * Public TypeScript API for GoSSR reactive bindings.
 * This interface matches the design spec in office/design/reactive-bindings/typescript-api.md.
 */

/** The page calls of a route: each call's argument and result types. */
export type Calls = Record<string, { in: unknown; out: unknown }>;

/**
 * The reactive client object exposed to developers per reactive route.
 *
 * R — full map of readable reactive variables (keys are variable names, values are their TS types).
 * W — subset of R that is client-writable.
 * C — the route's page calls.
 *
 * Instantiated by the generated __ssr_gen__.ts, not by developers directly.
 */
export interface SsrClient<
  R extends Record<string, unknown>,
  W extends Partial<R> = Partial<Record<keyof R, never>>,
  C extends Calls = Record<string, never>
> {
  /**
   * Returns the last known rendered value for the binding.
   * The value is the pre-rendered HTML string from the most recent patch or init message.
   * Returns undefined if no value has been received yet.
   */
  get<K extends keyof R>(name: K): string | undefined;

  /**
   * Runs a page call of this route. A call made before the connection opens, or
   * while it reconnects, waits and is sent once it opens; calls that waited all
   * go out at once, and the server may refuse those over its in-flight limit
   * with 429.
   * Resolves with the call's result; rejects with a CallError carrying the fail
   * frame's status and message, or status 0 when the connection was lost before
   * the answer came, a reconnect it waited for was refused, or the connection is
   * closed for good.
   */
  call<K extends keyof C & string>(name: K, args: C[K]['in']): Promise<C[K]['out']>;

  /**
   * Sends a write frame to the server for a client-writable variable.
   * Fire-and-forget: the acknowledged new value arrives via a patch message.
   * TypeScript compile error if called on a variable not in W (the writable subset).
   */
  set<K extends keyof W>(name: K, value: W[K]): void;

  /**
   * Subscribes to init and patch messages for a specific variable.
   * The callback receives the new pre-rendered HTML string.
   * Returns an unsubscribe function.
   */
  on<K extends keyof R>(name: K, callback: (value: string) => void): () => void;

  /**
   * Registers a callback that fires when the WebSocket connection is (re-)established.
   * Returns an unsubscribe function.
   */
  onConnect(callback: () => void): () => void;

  /**
   * Registers a callback that fires when an established connection closes unexpectedly.
   * Not called for close code 1000, nor when the client pauses the connection
   * while the tab is hidden.
   * Returns an unsubscribe function.
   */
  onDisconnect(callback: (code: number, reason: string) => void): () => void;

  /**
   * Registers a callback that fires when the initial WS upgrade request is rejected.
   * status: the HTTP status code (0 if the browser did not expose it).
   * Not called for connections that were established and then closed — use onDisconnect for those.
   * Returns an unsubscribe function.
   */
  onConnectError(callback: (status: number) => void): () => void;

  /**
   * Registers a callback that fires when a write is rejected by the server (err frame).
   * Default behavior if no handler is registered: logs to console.warn.
   * Returns an unsubscribe function.
   */
  onError(callback: (varName: string, message: string) => void): () => void;

  /**
   * Stops the page's live connection for good, for every route on the page: the
   * connection closes and never reconnects, waiting and in-flight calls reject
   * with status 0, and every route's client stops as destroy() stops one. Fires
   * no callback. Safe to call from any route's onDisconnect or onConnectError:
   * the other routes still receive that event once.
   */
  stop(): void;
}
