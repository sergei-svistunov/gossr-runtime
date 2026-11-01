/**
 * gossr-runtime — GoSSR reactive bindings TypeScript runtime
 *
 * Public exports. Developers import from './__ssr_gen__', which re-exports
 * a fully-typed 'ssr' object created by calling createSsrClient here.
 */

export type { SsrClient, Calls } from './types.js';
export { StatusReauth, CallError } from './protocol.js';
export type {
  InitFrame,
  PatchFrame,
  WriteFrame,
  AckFrame,
  ErrFrame,
  CallFrame,
  ResultFrame,
  FailFrame,
  ServerFrame,
  ClientFrame,
} from './protocol.js';
export { SsrRuntime, createSsrClient, getSharedConnectionRegistry } from './client.js';
export type { CreateSsrClientOptions } from './client.js';
