/**
 * Behavioral tests for SsrRuntime (client.ts).
 *
 * Covers the required test scenarios from the frontend plan:
 * 1. init frame populates [data-ssr-bind] elements
 * 2. patch frame updates only the targeted span
 * 3. input[ssr:bind] input event fires write frame; ack silently consumed; err fires hook + resets
 * 4. select[ssr:bind] change event fires write frame
 * 5. textarea[ssr:bind] fires write frame
 * 6. Reconnect: unexpected close reconnects with back-off, new init applies
 * 7. Upgrade failure: onerror before onopen fires onConnectError once, no retry
 * 8. Close code 1000: no reconnect
 * 9. Close code 1008: reconnect starts AND slow-client console.warn is emitted
 * 10. ssr.get returns last known HTML string
 * 11. ssr.on fires on patch; unsubscribe removes it
 * 12. After 5 failed reconnects, console.warn with count is emitted
 * NEW (Round 4):
 * 13. Two reactive routes share one WS connection (multiplexing)
 * 14. Parent init + child init combined in one frame; both apply their own bindings
 * 15. ssr.set from child includes child's routeKey
 * 16. err{code:"unknown_route",routeKey:""} logs console.warn and does NOT invoke onError
 * NEW (Round 5):
 * 17. ssr.set sends numeric value as number (not string)
 * 18. ssr.set sends boolean value as boolean (not string)
 * 19. ssr.set sends object value as object literal (not stringified)
 * 20. err{code:"decode_error"} logs console.warn and does NOT invoke onError
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SsrRuntime, getSharedConnectionRegistry } from '../src/client.js';
import { installMockWebSocket, latestMockWs, mockWsInstances } from './mock-websocket.js';

let teardown: () => void;

beforeEach(() => {
  teardown = installMockWebSocket();
  document.body.innerHTML = '';
  // Clear shared connection registry between tests to prevent cross-test pollution.
  getSharedConnectionRegistry().clear();
});

afterEach(() => {
  teardown();
  vi.restoreAllMocks();
  vi.useRealTimers();
  // Ensure registry is cleared after each test.
  getSharedConnectionRegistry().clear();
});

// Helper: create a runtime and immediately open the WS connection
function makeRuntime(url = 'ws://localhost/__ws', routeKey = ''): SsrRuntime {
  const rt = new SsrRuntime(url, routeKey);
  latestMockWs().serverOpen();
  return rt;
}

// Helper: send an init frame to the latest WS (with routeKey field)
function sendInit(bindings: Record<string, string>, routeKey = ''): void {
  latestMockWs().serverSend(JSON.stringify({ t: 'init', routeKey, bindings }));
}

// Helper: send a patch frame (with routeKey field)
function sendPatch(key: string, html: string, routeKey = ''): void {
  latestMockWs().serverSend(JSON.stringify({ t: 'patch', routeKey, key, html }));
}

// ---------------------------------------------------------------------------
// Test 1: init frame populates [data-ssr-bind] elements
// ---------------------------------------------------------------------------

describe('init frame', () => {
  it('populates a single span with the binding HTML', () => {
    document.body.innerHTML = '<span data-ssr-bind="counter"></span>';
    const rt = makeRuntime();
    sendInit({ counter: '42' });
    expect(document.querySelector('[data-ssr-bind="counter"]')!.innerHTML).toBe('42');
    rt.destroy();
  });

  it('populates multiple spans with the same binding key', () => {
    document.body.innerHTML =
      '<span data-ssr-bind="counter"></span><span data-ssr-bind="counter"></span>';
    const rt = makeRuntime();
    sendInit({ counter: '7' });
    const spans = document.querySelectorAll('[data-ssr-bind="counter"]');
    expect(spans[0].innerHTML).toBe('7');
    expect(spans[1].innerHTML).toBe('7');
    rt.destroy();
  });

  it('populates multiple different binding keys', () => {
    document.body.innerHTML =
      '<span data-ssr-bind="count"></span><span data-ssr-bind="label"></span>';
    const rt = makeRuntime();
    sendInit({ count: '10', label: '<strong>hello</strong>' });
    expect(document.querySelector('[data-ssr-bind="count"]')!.innerHTML).toBe('10');
    expect(document.querySelector('[data-ssr-bind="label"]')!.innerHTML).toBe('<strong>hello</strong>');
    rt.destroy();
  });

  it('updates ssr.get() for all keys in the init frame', () => {
    const rt = makeRuntime();
    sendInit({ x: 'foo', y: 'bar' });
    expect(rt.get('x')).toBe('foo');
    expect(rt.get('y')).toBe('bar');
    rt.destroy();
  });

  it('fires ssr.on() listeners for each init binding', () => {
    const rt = makeRuntime();
    const xCb = vi.fn();
    rt.on('x', xCb);
    sendInit({ x: 'hello', y: 'world' });
    expect(xCb).toHaveBeenCalledOnce();
    expect(xCb).toHaveBeenCalledWith('hello');
    rt.destroy();
  });
});

// ---------------------------------------------------------------------------
// Test 2: patch frame updates only the targeted span
// ---------------------------------------------------------------------------

describe('patch frame', () => {
  it('updates only the span for the patched key', () => {
    document.body.innerHTML =
      '<span data-ssr-bind="a">old-a</span><span data-ssr-bind="b">old-b</span>';
    const rt = makeRuntime();
    sendInit({ a: 'old-a', b: 'old-b' });
    sendPatch('a', 'new-a');
    expect(document.querySelector('[data-ssr-bind="a"]')!.innerHTML).toBe('new-a');
    expect(document.querySelector('[data-ssr-bind="b"]')!.innerHTML).toBe('old-b');
    rt.destroy();
  });

  it('updates ssr.get() for the patched key only', () => {
    const rt = makeRuntime();
    sendInit({ a: 'init-a', b: 'init-b' });
    sendPatch('b', 'patched-b');
    expect(rt.get('a')).toBe('init-a');
    expect(rt.get('b')).toBe('patched-b');
    rt.destroy();
  });

  it('fires ssr.on() for the patched key only', () => {
    const rt = makeRuntime();
    const aCb = vi.fn();
    const bCb = vi.fn();
    rt.on('a', aCb);
    rt.on('b', bCb);
    sendInit({ a: 'a0', b: 'b0' });
    aCb.mockClear();
    bCb.mockClear();
    sendPatch('a', 'a1');
    expect(aCb).toHaveBeenCalledOnce();
    expect(aCb).toHaveBeenCalledWith('a1');
    expect(bCb).not.toHaveBeenCalled();
    rt.destroy();
  });
});

// ---------------------------------------------------------------------------
// Test 3: input[ssr:bind] fires write frame; ack consumed; err fires hook + resets
// ---------------------------------------------------------------------------

describe('input ssr:bind', () => {
  it('input event on text input sends a write frame with routeKey', () => {
    document.body.innerHTML = '<input ssr:bind="counter" type="number" />';
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.value = '42';
    input.dispatchEvent(new Event('input'));
    const ws = latestMockWs();
    expect(ws.sentMessages).toHaveLength(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    // ssr:bind wires input.value (a string); the write frame value is still a string here.
    expect(msg).toEqual({ t: 'write', routeKey: '3f7a', var: 'counter', value: '42' });
    rt.destroy();
  });

  it('ack frame is silently consumed (no callback fired)', () => {
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const errorCb = vi.fn();
    rt.onError(errorCb);
    latestMockWs().serverSend(JSON.stringify({ t: 'ack', routeKey: '3f7a', var: 'counter' }));
    expect(errorCb).not.toHaveBeenCalled();
    rt.destroy();
  });

  it('err frame fires onError callback', () => {
    document.body.innerHTML = '<input ssr:bind="counter" type="number" />';
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    sendInit({ counter: '10' });

    const errorCb = vi.fn();
    rt.onError(errorCb);

    latestMockWs().serverSend(JSON.stringify({
      t: 'err', routeKey: '3f7a', var: 'counter', msg: 'counter cannot be negative', code: 'validation_failed',
    }));

    expect(errorCb).toHaveBeenCalledOnce();
    expect(errorCb).toHaveBeenCalledWith('counter', 'counter cannot be negative');
    rt.destroy();
  });

  it('err frame resets bound input to last accepted value', () => {
    document.body.innerHTML = '<input ssr:bind="counter" type="number" />';
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    sendInit({ counter: '10' });

    const input = document.querySelector<HTMLInputElement>('input')!;
    input.value = '-1'; // user typed invalid value

    rt.onError(() => {}); // register handler to suppress default warn

    latestMockWs().serverSend(JSON.stringify({
      t: 'err', routeKey: '3f7a', var: 'counter', msg: 'negative', code: 'validation_failed',
    }));

    expect(input.value).toBe('10');
    rt.destroy();
  });

  it('default onError behavior logs to console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    latestMockWs().serverSend(JSON.stringify({
      t: 'err', routeKey: '3f7a', var: 'x', msg: 'oops', code: 'validation_failed',
    }));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"x"'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('oops'));
    rt.destroy();
  });
});

// ---------------------------------------------------------------------------
// Test 4: select[ssr:bind] fires write on change event
// ---------------------------------------------------------------------------

describe('select ssr:bind', () => {
  it('change event on select sends a write frame with routeKey', () => {
    document.body.innerHTML =
      '<select ssr:bind="mode"><option value="fast">fast</option><option value="slow">slow</option></select>';
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const select = document.querySelector<HTMLSelectElement>('select')!;
    select.value = 'slow';
    select.dispatchEvent(new Event('change'));
    const ws = latestMockWs();
    expect(ws.sentMessages).toHaveLength(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg).toEqual({ t: 'write', routeKey: '3f7a', var: 'mode', value: 'slow' });
    rt.destroy();
  });

  it('input event on select does not send a write frame (only change does)', () => {
    document.body.innerHTML = '<select ssr:bind="mode"><option value="x">x</option></select>';
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const select = document.querySelector<HTMLSelectElement>('select')!;
    select.dispatchEvent(new Event('input')); // wrong event for select
    expect(latestMockWs().sentMessages).toHaveLength(0);
    rt.destroy();
  });
});

// ---------------------------------------------------------------------------
// Test 5: textarea[ssr:bind] fires write on input event
// ---------------------------------------------------------------------------

describe('textarea ssr:bind', () => {
  it('input event on textarea sends a write frame with routeKey', () => {
    document.body.innerHTML = '<textarea ssr:bind="notes"></textarea>';
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = 'hello world';
    textarea.dispatchEvent(new Event('input'));
    const ws = latestMockWs();
    expect(ws.sentMessages).toHaveLength(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg).toEqual({ t: 'write', routeKey: '3f7a', var: 'notes', value: 'hello world' });
    rt.destroy();
  });
});

// ---------------------------------------------------------------------------
// Test 6: Reconnect after unexpected close
// ---------------------------------------------------------------------------

describe('reconnect', () => {
  it('reconnects after an unexpected WS close (non-1000 code)', () => {
    vi.useFakeTimers();
    const rt = new SsrRuntime('ws://localhost/__ws');
    const ws1 = latestMockWs();
    ws1.serverOpen();

    ws1.serverClose(1006, 'abnormal');
    vi.advanceTimersByTime(1200);

    expect(mockWsInstances).toHaveLength(2);
    const ws2 = latestMockWs();
    ws2.serverOpen();

    document.body.innerHTML = '<span data-ssr-bind="x"></span>';
    sendInit({ x: 'fresh' });
    expect(document.querySelector('[data-ssr-bind="x"]')!.innerHTML).toBe('fresh');

    rt.destroy();
  });

  it('fires onDisconnect when WS closes unexpectedly', () => {
    const rt = makeRuntime();
    const disconnectCb = vi.fn();
    rt.onDisconnect(disconnectCb);
    latestMockWs().serverClose(1006, 'gone');
    expect(disconnectCb).toHaveBeenCalledOnce();
    expect(disconnectCb).toHaveBeenCalledWith(1006, 'gone');
    rt.destroy();
  });

  it('fires onConnect after successful reconnect', () => {
    vi.useFakeTimers();
    const rt = new SsrRuntime('ws://localhost/__ws');
    const connectCb = vi.fn();
    rt.onConnect(connectCb);

    latestMockWs().serverOpen();
    expect(connectCb).toHaveBeenCalledTimes(1);

    latestMockWs().serverClose(1006, 'gone');
    vi.advanceTimersByTime(1200);

    latestMockWs().serverOpen();
    expect(connectCb).toHaveBeenCalledTimes(2);

    rt.destroy();
  });

  it('applies new init snapshot after reconnect (replaces stale values)', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span data-ssr-bind="counter"></span>';
    const rt = new SsrRuntime('ws://localhost/__ws');
    latestMockWs().serverOpen();
    sendInit({ counter: '1' });
    expect(document.querySelector('[data-ssr-bind="counter"]')!.innerHTML).toBe('1');

    latestMockWs().serverClose(1006, 'gone');
    vi.advanceTimersByTime(1200);
    latestMockWs().serverOpen();
    sendInit({ counter: '99' });
    expect(document.querySelector('[data-ssr-bind="counter"]')!.innerHTML).toBe('99');
    expect(rt.get('counter')).toBe('99');

    rt.destroy();
  });

  it('does not reconnect after close code 1000', () => {
    vi.useFakeTimers();
    const rt = new SsrRuntime('ws://localhost/__ws');
    latestMockWs().serverOpen();
    latestMockWs().serverClose(1000, 'normal');
    vi.advanceTimersByTime(5000);
    expect(mockWsInstances).toHaveLength(1);
    rt.destroy();
  });
});

// ---------------------------------------------------------------------------
// Test 7: Upgrade failure fires onConnectError once, no retry
// ---------------------------------------------------------------------------

describe('upgrade failure', () => {
  it('fires onConnectError once when onerror fires before onopen', () => {
    const rt = new SsrRuntime('ws://localhost/__ws');
    const errorCb = vi.fn();
    rt.onConnectError(errorCb);

    const ws = latestMockWs();
    ws.serverError();
    ws.serverClose(1006, 'upgrade failed');

    expect(errorCb).toHaveBeenCalledOnce();
    expect(errorCb).toHaveBeenCalledWith(0);

    rt.destroy();
  });

  it('does not attempt reconnect after upgrade failure', () => {
    vi.useFakeTimers();
    const rt = new SsrRuntime('ws://localhost/__ws');
    const ws = latestMockWs();
    ws.serverError();
    ws.serverClose(1006, 'upgrade failed');
    vi.advanceTimersByTime(10_000);
    expect(mockWsInstances).toHaveLength(1);
    rt.destroy();
  });

  it('logs console.error on upgrade failure', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rt = new SsrRuntime('ws://localhost/__ws');
    latestMockWs().serverError();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('upgrade failed'));
    rt.destroy();
  });

  it('does not fire onDisconnect for upgrade failure (no established connection)', () => {
    const rt = new SsrRuntime('ws://localhost/__ws');
    const disconnectCb = vi.fn();
    rt.onDisconnect(disconnectCb);
    latestMockWs().serverError();
    latestMockWs().serverClose(1006, 'gone');
    expect(disconnectCb).not.toHaveBeenCalled();
    rt.destroy();
  });
});

// ---------------------------------------------------------------------------
// Test 9: Unexpected close — reconnect path; 1008 slow-client warn restored
//
// Backend migrated to github.com/coder/websocket which CAN send close code 1008
// for slow-client disconnects. The client reinstates the 1008 detection branch.
// ---------------------------------------------------------------------------

describe('slow client disconnect (1008)', () => {
  it('logs console.warn with slow client message when WS closes with code 1008', () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = makeRuntime();
    latestMockWs().serverClose(1008, 'slow client');
    expect(warnSpy).toHaveBeenCalledWith('slow client (1008)');
    rt.destroy();
  });

  it('reconnects after 1008 close', () => {
    vi.useFakeTimers();
    const rt = makeRuntime();
    latestMockWs().serverClose(1008, 'slow client');
    vi.advanceTimersByTime(1200);
    expect(mockWsInstances).toHaveLength(2);
    rt.destroy();
  });

  it('does not emit slow-client warn for non-1008 unexpected closes (1006, 1011)', () => {
    vi.useFakeTimers();

    // code 1006 (abnormal closure)
    const warnSpy1006 = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt1 = makeRuntime();
    latestMockWs().serverClose(1006, 'abnormal');
    expect(warnSpy1006).not.toHaveBeenCalledWith('slow client (1008)');
    rt1.destroy();
    warnSpy1006.mockRestore();

    // code 1011 (internal server error)
    getSharedConnectionRegistry().clear();
    const warnSpy1011 = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt2 = makeRuntime();
    latestMockWs().serverClose(1011, 'internal error');
    expect(warnSpy1011).not.toHaveBeenCalledWith('slow client (1008)');
    rt2.destroy();
    warnSpy1011.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Test 10: ssr.get returns last known HTML string
// ---------------------------------------------------------------------------

describe('ssr.get', () => {
  it('returns undefined before any init/patch', () => {
    const rt = makeRuntime();
    expect(rt.get('x')).toBeUndefined();
    rt.destroy();
  });

  it('returns the HTML string from the last received value', () => {
    const rt = makeRuntime();
    sendInit({ x: 'first' });
    expect(rt.get('x')).toBe('first');
    sendPatch('x', 'second');
    expect(rt.get('x')).toBe('second');
    rt.destroy();
  });
});

// ---------------------------------------------------------------------------
// Test 11: ssr.on fires on patch; unsubscribe removes it
// ---------------------------------------------------------------------------

describe('ssr.on', () => {
  it('callback fires when a patch arrives for the subscribed key', () => {
    const rt = makeRuntime();
    const cb = vi.fn();
    rt.on('counter', cb);
    sendInit({ counter: 'init' });
    sendPatch('counter', 'updated');
    expect(cb).toHaveBeenCalledTimes(2); // once for init, once for patch
    expect(cb).toHaveBeenLastCalledWith('updated');
    rt.destroy();
  });

  it('unsubscribe function removes the callback', () => {
    const rt = makeRuntime();
    const cb = vi.fn();
    const unsub = rt.on('counter', cb);
    sendInit({ counter: '1' });
    unsub();
    sendPatch('counter', '2');
    expect(cb).toHaveBeenCalledTimes(1); // only from init, not from post-unsub patch
    rt.destroy();
  });

  it('multiple subscribers on the same key all fire', () => {
    const rt = makeRuntime();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    rt.on('x', cb1);
    rt.on('x', cb2);
    sendPatch('x', 'val');
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
    rt.destroy();
  });
});

// ---------------------------------------------------------------------------
// Test 12: After 5 failed reconnects, console.warn with count is emitted
// ---------------------------------------------------------------------------

describe('reconnect warning after 5 failures', () => {
  it('emits console.warn with attempt count after 5 consecutive failures', () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = new SsrRuntime('ws://localhost/__ws');

    for (let i = 0; i < 6; i++) {
      const ws = latestMockWs();
      ws.serverOpen();
      ws.serverClose(1006, 'gone');
      vi.advanceTimersByTime(35_000);
    }

    const warnCalls = warnSpy.mock.calls.filter(
      (args) => String(args[0]).includes('reconnect attempt')
    );
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);

    rt.destroy();
  });
});

// ---------------------------------------------------------------------------
// ssr.set
// ---------------------------------------------------------------------------

describe('ssr.set', () => {
  it('sends a write frame with numeric value as number (not string) and the baked routeKey', () => {
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    rt.set('counter', 42 as unknown as never);
    const ws = latestMockWs();
    expect(ws.sentMessages).toHaveLength(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg).toEqual({ t: 'write', routeKey: '3f7a', var: 'counter', value: 42 });
    rt.destroy();
  });

  it('sends boolean value as boolean (not string)', () => {
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    rt.set('flag', true as unknown as never);
    const msg = JSON.parse(latestMockWs().sentMessages[0]);
    expect(msg.value).toBe(true);
    expect(msg.routeKey).toBe('3f7a');
    rt.destroy();
  });

  it('silently drops write when WS is not open (reconnecting)', () => {
    vi.useFakeTimers();
    const rt = new SsrRuntime('ws://localhost/__ws', '3f7a');
    expect(() => {
      rt.set('x', 'val' as unknown as never);
    }).not.toThrow();
    rt.destroy();
  });
});

// ---------------------------------------------------------------------------
// destroy()
// ---------------------------------------------------------------------------

describe('destroy', () => {
  it('cancels pending reconnect timer', () => {
    vi.useFakeTimers();
    const rt = makeRuntime();
    latestMockWs().serverClose(1006, 'gone');
    rt.destroy();
    vi.advanceTimersByTime(5000);
    expect(mockWsInstances).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

describe('lifecycle hooks', () => {
  it('onConnect fires when WS opens', () => {
    const rt = new SsrRuntime('ws://localhost/__ws');
    const cb = vi.fn();
    rt.onConnect(cb);
    latestMockWs().serverOpen();
    expect(cb).toHaveBeenCalledOnce();
    rt.destroy();
  });

  it('onConnect unsubscribe removes the callback', () => {
    const rt = new SsrRuntime('ws://localhost/__ws');
    const cb = vi.fn();
    const unsub = rt.onConnect(cb);
    unsub();
    latestMockWs().serverOpen();
    expect(cb).not.toHaveBeenCalled();
    rt.destroy();
  });

  it('onDisconnect unsubscribe removes the callback', () => {
    const rt = makeRuntime();
    const cb = vi.fn();
    const unsub = rt.onDisconnect(cb);
    unsub();
    latestMockWs().serverClose(1006, 'gone');
    expect(cb).not.toHaveBeenCalled();
    rt.destroy();
  });
});

// ---------------------------------------------------------------------------
// Malformed messages
// ---------------------------------------------------------------------------

describe('malformed messages', () => {
  it('ignores unparseable JSON without throwing', () => {
    const rt = makeRuntime();
    expect(() => {
      latestMockWs().serverSend('not valid json');
    }).not.toThrow();
    rt.destroy();
  });

  it('ignores unknown frame type without throwing', () => {
    const rt = makeRuntime();
    expect(() => {
      latestMockWs().serverSend(JSON.stringify({ t: 'unknown_future_type', data: 'x' }));
    }).not.toThrow();
    rt.destroy();
  });
});

// ---------------------------------------------------------------------------
// Round 4 — WS multiplexing tests (NEW)
// ---------------------------------------------------------------------------

describe('WS multiplexing — two reactive routes share one connection', () => {
  it('two runtimes with different routeKeys on the same wsUrl open only ONE WebSocket', () => {
    // Parent route: routeKey '3f7a'
    const parentRt = new SsrRuntime('ws://localhost/__ws', '3f7a');
    // Child route: routeKey '9d1e' — same wsUrl
    const childRt = new SsrRuntime('ws://localhost/__ws', '9d1e');

    // Both runtimes attach to the same shared WS — only one WS instance should exist.
    expect(mockWsInstances).toHaveLength(1);

    parentRt.destroy();
    childRt.destroy();
  });

  it('both runtimes fire onConnect when the single shared WS opens', () => {
    const parentRt = new SsrRuntime('ws://localhost/__ws', '3f7a');
    const childRt = new SsrRuntime('ws://localhost/__ws', '9d1e');

    const parentConnect = vi.fn();
    const childConnect = vi.fn();
    parentRt.onConnect(parentConnect);
    childRt.onConnect(childConnect);

    // Open the single WS
    latestMockWs().serverOpen();

    expect(parentConnect).toHaveBeenCalledOnce();
    expect(childConnect).toHaveBeenCalledOnce();

    parentRt.destroy();
    childRt.destroy();
  });

  it('combined init frame: both runtimes apply their own bindings', () => {
    // HTML for both routes
    document.body.innerHTML =
      '<span data-ssr-bind="3f7a.count"></span>' +
      '<span data-ssr-bind="9d1e.count"></span>';

    const parentRt = new SsrRuntime('ws://localhost/__ws', '3f7a');
    const childRt = new SsrRuntime('ws://localhost/__ws', '9d1e');

    const ws = latestMockWs();
    ws.serverOpen();

    // Single combined init frame with bindings from both routes
    ws.serverSend(JSON.stringify({
      t: 'init',
      routeKey: '9d1e', // leaf route's key by convention
      bindings: {
        '3f7a.count': '5',
        '9d1e.count': '7',
      },
    }));

    // Both DOM sites must be updated
    expect(document.querySelector('[data-ssr-bind="3f7a.count"]')!.innerHTML).toBe('5');
    expect(document.querySelector('[data-ssr-bind="9d1e.count"]')!.innerHTML).toBe('7');

    // Both runtimes must have the values in their internal bindings map
    expect(parentRt.get('3f7a.count')).toBe('5');
    expect(childRt.get('9d1e.count')).toBe('7');

    parentRt.destroy();
    childRt.destroy();
  });

  it('ssr.set from child runtime sends write frame with child routeKey', () => {
    const parentRt = new SsrRuntime('ws://localhost/__ws', '3f7a');
    const childRt = new SsrRuntime('ws://localhost/__ws', '9d1e');

    const ws = latestMockWs();
    ws.serverOpen();

    // Child calls ssr.set with a number — value must be 42 (number), not '42' (string).
    childRt.set('count', 42 as unknown as never);

    expect(ws.sentMessages).toHaveLength(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg).toEqual({ t: 'write', routeKey: '9d1e', var: 'count', value: 42 });

    parentRt.destroy();
    childRt.destroy();
  });

  it('ssr.set from parent runtime sends write frame with parent routeKey', () => {
    const parentRt = new SsrRuntime('ws://localhost/__ws', '3f7a');
    const childRt = new SsrRuntime('ws://localhost/__ws', '9d1e');

    const ws = latestMockWs();
    ws.serverOpen();

    parentRt.set('count', 99 as unknown as never);

    expect(ws.sentMessages).toHaveLength(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg).toEqual({ t: 'write', routeKey: '3f7a', var: 'count', value: 99 });

    parentRt.destroy();
    childRt.destroy();
  });

  it('both runtimes fire onDisconnect when the shared WS closes', () => {
    const parentRt = new SsrRuntime('ws://localhost/__ws', '3f7a');
    const childRt = new SsrRuntime('ws://localhost/__ws', '9d1e');

    const ws = latestMockWs();
    ws.serverOpen();

    const parentDisconnect = vi.fn();
    const childDisconnect = vi.fn();
    parentRt.onDisconnect(parentDisconnect);
    childRt.onDisconnect(childDisconnect);

    ws.serverClose(1011, 'internal error');

    expect(parentDisconnect).toHaveBeenCalledOnce();
    expect(parentDisconnect).toHaveBeenCalledWith(1011, 'internal error');
    expect(childDisconnect).toHaveBeenCalledOnce();
    expect(childDisconnect).toHaveBeenCalledWith(1011, 'internal error');

    parentRt.destroy();
    childRt.destroy();
  });

  it('patch keyed by routeKey prefix updates only the matching DOM element', () => {
    document.body.innerHTML =
      '<span data-ssr-bind="3f7a.count"></span>' +
      '<span data-ssr-bind="9d1e.count"></span>';

    const parentRt = new SsrRuntime('ws://localhost/__ws', '3f7a');
    const childRt = new SsrRuntime('ws://localhost/__ws', '9d1e');

    const ws = latestMockWs();
    ws.serverOpen();

    ws.serverSend(JSON.stringify({ t: 'patch', routeKey: '3f7a', key: '3f7a.count', html: '100' }));

    expect(document.querySelector('[data-ssr-bind="3f7a.count"]')!.innerHTML).toBe('100');
    expect(document.querySelector('[data-ssr-bind="9d1e.count"]')!.innerHTML).toBe('');

    parentRt.destroy();
    childRt.destroy();
  });
});

// ---------------------------------------------------------------------------
// Round 4 — err{code:"unknown_route",routeKey:""} handling (NEW)
// ---------------------------------------------------------------------------

describe('unknown_route error handling', () => {
  it('err frame with code "unknown_route" and routeKey "" logs console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');

    latestMockWs().serverSend(JSON.stringify({
      t: 'err',
      routeKey: '',
      var: 'count',
      msg: 'route not found',
      code: 'unknown_route',
    }));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown_route'));
    rt.destroy();
  });

  it('err frame with code "unknown_route" and routeKey "" does NOT invoke onError', () => {
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const errorCb = vi.fn();
    rt.onError(errorCb);

    latestMockWs().serverSend(JSON.stringify({
      t: 'err',
      routeKey: '',
      var: 'count',
      msg: 'route not found',
      code: 'unknown_route',
    }));

    expect(errorCb).not.toHaveBeenCalled();
    rt.destroy();
  });

  it('err frame with code "validation_failed" DOES invoke onError normally', () => {
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const errorCb = vi.fn();
    rt.onError(errorCb);

    latestMockWs().serverSend(JSON.stringify({
      t: 'err',
      routeKey: '3f7a',
      var: 'count',
      msg: 'negative',
      code: 'validation_failed',
    }));

    expect(errorCb).toHaveBeenCalledOnce();
    expect(errorCb).toHaveBeenCalledWith('count', 'negative');
    rt.destroy();
  });
});

// ---------------------------------------------------------------------------
// Round 5 — any-type values (NEW)
// ---------------------------------------------------------------------------

describe('TestSsrSet_NumberValue', () => {
  it('ssr.set with a number sends value as JSON number, not string', () => {
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    rt.set('count', 42 as unknown as never);
    const msg = JSON.parse(latestMockWs().sentMessages[0]);
    expect(msg.value).toBe(42);
    expect(typeof msg.value).toBe('number');
    rt.destroy();
  });
});

describe('TestSsrSet_BoolValue', () => {
  it('ssr.set with a boolean sends value as JSON boolean, not string', () => {
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    rt.set('enabled', true as unknown as never);
    const msg = JSON.parse(latestMockWs().sentMessages[0]);
    expect(msg.value).toBe(true);
    expect(typeof msg.value).toBe('boolean');
    rt.destroy();
  });

  it('ssr.set with false sends value as JSON false', () => {
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    rt.set('enabled', false as unknown as never);
    const msg = JSON.parse(latestMockWs().sentMessages[0]);
    expect(msg.value).toBe(false);
    expect(typeof msg.value).toBe('boolean');
    rt.destroy();
  });
});

describe('TestSsrSet_StructValue', () => {
  it('ssr.set with an object sends value as object literal, not a stringified JSON string', () => {
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const profile = { name: 'Ann', age: 30 };
    rt.set('profile', profile as unknown as never);
    const msg = JSON.parse(latestMockWs().sentMessages[0]);
    // value must be the object itself, NOT a double-encoded string like '{"name":"Ann","age":30}'
    expect(msg.value).toEqual({ name: 'Ann', age: 30 });
    expect(typeof msg.value).toBe('object');
    rt.destroy();
  });

  it('ssr.set with an array sends value as JSON array', () => {
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    rt.set('items', [1, 2, 3] as unknown as never);
    const msg = JSON.parse(latestMockWs().sentMessages[0]);
    expect(msg.value).toEqual([1, 2, 3]);
    expect(Array.isArray(msg.value)).toBe(true);
    rt.destroy();
  });

  it('full write frame has correct shape with struct value', () => {
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    rt.set('profile', { name: 'Ann', age: 30 } as unknown as never);
    const msg = JSON.parse(latestMockWs().sentMessages[0]);
    expect(msg).toEqual({
      t: 'write',
      routeKey: '3f7a',
      var: 'profile',
      value: { name: 'Ann', age: 30 },
    });
    rt.destroy();
  });
});

describe('TestErr_DecodeError', () => {
  it('err frame with code "decode_error" logs console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');

    latestMockWs().serverSend(JSON.stringify({
      t: 'err',
      routeKey: '3f7a',
      var: 'profile',
      msg: 'JSON decode failed: cannot unmarshal string into Go value of type main.Profile',
      code: 'decode_error',
    }));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('decode_error'));
    rt.destroy();
  });

  it('err frame with code "decode_error" does NOT invoke onError callback', () => {
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const errorCb = vi.fn();
    rt.onError(errorCb);

    latestMockWs().serverSend(JSON.stringify({
      t: 'err',
      routeKey: '3f7a',
      var: 'profile',
      msg: 'JSON decode failed: cannot unmarshal string into Go value of type main.Profile',
      code: 'decode_error',
    }));

    expect(errorCb).not.toHaveBeenCalled();
    rt.destroy();
  });

  it('err frame with code "decode_error" does NOT reset bound input elements', () => {
    // Use type="text" so jsdom does not sanitize the value to '' for non-numeric input.
    document.body.innerHTML = '<input ssr:bind="counter" type="text" />';
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    sendInit({ counter: '10' });

    const input = document.querySelector<HTMLInputElement>('input')!;
    input.value = 'bad-json';

    latestMockWs().serverSend(JSON.stringify({
      t: 'err',
      routeKey: '3f7a',
      var: 'counter',
      msg: 'JSON decode failed',
      code: 'decode_error',
    }));

    // Input should NOT be reset to '10' — decode_error is swallowed silently (warn only).
    expect(input.value).toBe('bad-json');
    rt.destroy();
  });

  it('err frame with code "validation_failed" still invokes onError (decode_error path does not intercept it)', () => {
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const errorCb = vi.fn();
    rt.onError(errorCb);

    latestMockWs().serverSend(JSON.stringify({
      t: 'err',
      routeKey: '3f7a',
      var: 'count',
      msg: 'must be positive',
      code: 'validation_failed',
    }));

    expect(errorCb).toHaveBeenCalledOnce();
    rt.destroy();
  });
});
