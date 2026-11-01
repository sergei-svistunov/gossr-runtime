/**
 * Wire-format types for the GoSSR reactive bindings WebSocket protocol.
 * Mirrors spec section 4 exactly.
 *
 * All messages are WebSocket text frames containing a single UTF-8 JSON object.
 * Binding values are always pre-rendered HTML strings; page call arguments and
 * results are JSON values.
 */

/** Close code with which the server asks the client to reconnect at once. */
export const StatusReauth = 4000;

/** Sent by server once after WS connection is accepted. Contains current rendered values. */
export interface InitFrame {
  t: 'init';
  /**
   * 8-hex route path hash of the sending route (leaf route for multi-route init).
   * Always emitted; used for diagnostic logging and routing context.
   */
  routeKey: string;
  /** Map of fully-namespaced binding key (routeKey.localKey) to pre-rendered HTML string for all reactive bindings. */
  bindings: Record<string, string>;
}

/** Sent by server on each state change. Contains the new rendered value for one binding. */
export interface PatchFrame {
  t: 'patch';
  /**
   * 8-hex route path hash of the route whose variable changed.
   * Informational; the full `data-ssr-bind` attribute value is the DOM selector.
   */
  routeKey: string;
  /** Fully-namespaced binding key (routeKey.localKey, variable name or expression hash). */
  key: string;
  /** New pre-rendered HTML string value. */
  html: string;
}

/** Sent by client when ssr.set() or ssr:bind fires. */
export interface WriteFrame {
  t: 'write';
  /**
   * 8-hex route path hash identifying which route's variable is being written.
   * Baked into the per-route TS stub by the generator; the developer never sets this.
   */
  routeKey: string;
  /** Variable name (not a binding key hash; only named variables are client-writable). */
  var: string;
  /**
   * JSON-encoded value of any shape. JSON.stringify(frame) encodes this field correctly
   * for all JSON-serializable types: number, string, boolean, object, array.
   * The server JSON-unmarshals the value into the declared Go type T.
   */
  value: unknown;
}

/**
 * Sent by server after a successful validated write.
 * The patch carrying the new value is a separate message; ack confirms the write was accepted.
 */
export interface AckFrame {
  t: 'ack';
  /** 8-hex route path hash of the route whose write was acknowledged. */
  routeKey: string;
  /** Variable name that was successfully written. */
  var: string;
}

/** Sent by server when a write fails validation or routing fails. */
export interface ErrFrame {
  t: 'err';
  /**
   * 8-hex route path hash of the route that rejected the write.
   * Empty string ("") if the routeKey in the write frame was unrecognized (code: "unknown_route").
   */
  routeKey: string;
  /** Variable name whose write was rejected. */
  var: string;
  /** Human-readable error string from ValidateName on the server. */
  msg: string;
  /**
   * Machine-readable error code.
   * "validation_failed" — Validate* returned an error.
   * "unknown_route" — routeKey not found in the page's reactive stack.
   * "decode_error" — server could not JSON-unmarshal the write frame value into the target Go type.
   *   This is an internal protocol/type error; the client runtime logs it and does NOT invoke ssr.onError.
   */
  code: string;
}

/** Sent by client to run a page call. Ids count up per connection. */
export interface CallFrame {
  t: 'call';
  id: number;
  /** 8-hex route path hash of the route that declares the call. */
  routeKey: string;
  name: string;
  args: unknown;
}

/** Sent by server when a page call returns. */
export interface ResultFrame {
  t: 'result';
  id: number;
  value: unknown;
}

/** Sent by server when a page call fails. */
export interface FailFrame {
  t: 'fail';
  id: number;
  status: number;
  msg: string;
}

/**
 * The error a page call rejects with: the status and message of a fail frame,
 * or status 0 when the connection was lost before the answer came.
 */
export class CallError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CallError';
    this.status = status;
  }
}

/** Union of all server-to-client frames. */
export type ServerFrame = InitFrame | PatchFrame | AckFrame | ErrFrame | ResultFrame | FailFrame;

/** Union of all client-to-server frames. */
export type ClientFrame = WriteFrame | CallFrame;
