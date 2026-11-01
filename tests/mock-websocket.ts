/**
 * Hand-rolled WebSocket mock for vitest.
 * Replaces the global WebSocket with a controllable fake.
 */

export type MockWsEvent = 'open' | 'message' | 'error' | 'close';

export interface MockWebSocket {
  readyState: number;
  url: string;
  sentMessages: string[];
  // Trigger events from the "server" side
  serverOpen(): void;
  serverSend(data: string): void;
  serverError(): void;
  serverClose(code?: number, reason?: string): void;
}

// Keep track of all created instances so tests can grab the latest one
export const mockWsInstances: MockWebSocketImpl[] = [];

export class MockWebSocketImpl implements MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = MockWebSocketImpl.CONNECTING;
  readonly url: string;
  readonly sentMessages: string[] = [];
  /** Code and reason the client passed to close(), if it closed the socket itself. */
  clientClose: { code: number; reason: string } | null = null;
  /** When set, close() on an open socket only records; the test fires the close event. */
  deferClose = false;

  private listeners: Map<string, Set<(event: Event | MessageEvent | CloseEvent) => void>> = new Map();

  constructor(url: string) {
    this.url = url;
    mockWsInstances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: Event | MessageEvent | CloseEvent) => void
  ): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(
    type: string,
    listener: (event: Event | MessageEvent | CloseEvent) => void
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocketImpl.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sentMessages.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === MockWebSocketImpl.CLOSED) return;
    this.clientClose = { code, reason };
    if (this.readyState === MockWebSocketImpl.CONNECTING) {
      // Closing before the handshake completes fails the connection, as in browsers.
      this.serverError();
      this.serverClose(1006, '');
      return;
    }
    if (this.deferClose) {
      this.readyState = MockWebSocketImpl.CLOSING;
      return;
    }
    this.serverClose(code, reason);
  }

  // -------------------------------------------------------------------------
  // Server-side event triggers (called by test code)
  // -------------------------------------------------------------------------

  serverOpen(): void {
    this.readyState = MockWebSocketImpl.OPEN;
    this.dispatch('open', new Event('open'));
  }

  serverSend(data: string): void {
    const event = new MessageEvent('message', { data });
    this.dispatch('message', event);
  }

  serverError(): void {
    this.dispatch('error', new Event('error'));
  }

  serverClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocketImpl.CLOSED;
    const event = new CloseEvent('close', { code, reason, wasClean: code === 1000 });
    this.dispatch('close', event);
  }

  private dispatch(type: string, event: Event | MessageEvent | CloseEvent): void {
    const set = this.listeners.get(type);
    if (set) {
      set.forEach((listener) => listener(event));
    }
  }
}

/**
 * Installs the mock WebSocket globally and returns a teardown function.
 * Call the returned function in afterEach to restore the real WebSocket.
 */
export function installMockWebSocket(): () => void {
  const original = (globalThis as Record<string, unknown>).WebSocket;
  // Clear instances list before each test suite
  mockWsInstances.length = 0;
  (globalThis as Record<string, unknown>).WebSocket = MockWebSocketImpl;
  return () => {
    (globalThis as Record<string, unknown>).WebSocket = original;
    mockWsInstances.length = 0;
  };
}

/** Returns the most recently created MockWebSocketImpl instance. */
export function latestMockWs(): MockWebSocketImpl {
  const ws = mockWsInstances[mockWsInstances.length - 1];
  if (!ws) throw new Error('No MockWebSocket instance found');
  return ws;
}
