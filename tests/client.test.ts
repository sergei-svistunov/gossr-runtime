// Behavioural tests for SsrRuntime and its shared live connection.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SsrRuntime, getSharedConnectionRegistry } from '../src/client.js';
import { StatusReauth } from '../src/protocol.js';
import { installMockWebSocket, latestMockWs, mockWsInstances } from './mock-websocket.js';

let teardown: () => void;

function clearRegistry(): void {
  getSharedConnectionRegistry().forEach((conn) => conn.destroy());
  getSharedConnectionRegistry().clear();
}

beforeEach(() => {
  teardown = installMockWebSocket();
  document.body.innerHTML = '';
  // Clear shared connection registry between tests to prevent cross-test pollution.
  clearRegistry();
});

afterEach(() => {
  try {
    // Destroy leftover connections so they stop watching the tab.
    clearRegistry();
    Reflect.deleteProperty(document, 'visibilityState');
    Reflect.deleteProperty(document, 'hidden');
    teardown();
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
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

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
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

  it('populates a span with escaped markup as text', () => {
    document.body.innerHTML = '<span data-ssr-bind="label"></span>';
    const rt = makeRuntime();
    sendInit({ label: '&lt;strong&gt;hello&lt;/strong&gt;' });
    const span = document.querySelector('[data-ssr-bind="label"]')!;
    expect(span.textContent).toBe('<strong>hello</strong>');
    expect(span.querySelector('strong')).toBeNull();
    rt.destroy();
  });

  it('updates ssr.get() for all keys in the init frame', () => {
    const rt = makeRuntime();
    sendInit({ x: 'foo', y: 'bar' });
    expect(rt.get('x')).toBe('foo');
    expect(rt.get('y')).toBe('bar');
    rt.destroy();
  });

  it('updates ssr.get() with the string as received', () => {
    const rt = makeRuntime();
    sendInit({ x: '&lt;b&gt;foo&lt;/b&gt;' });
    expect(rt.get('x')).toBe('&lt;b&gt;foo&lt;/b&gt;');
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

  it('fires ssr.on() listeners with the string as received', () => {
    const rt = makeRuntime();
    const xCb = vi.fn();
    rt.on('x', xCb);
    sendInit({ x: '&lt;hello&gt;' });
    expect(xCb).toHaveBeenCalledWith('&lt;hello&gt;');
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

  it('updates only the span for the patched key with escaped markup', () => {
    document.body.innerHTML =
      '<span data-ssr-bind="a">old-a</span><span data-ssr-bind="b">old-b</span>';
    const rt = makeRuntime();
    sendPatch('a', '&lt;i&gt;new-a&lt;/i&gt;');
    expect(document.querySelector('[data-ssr-bind="a"]')!.textContent).toBe('<i>new-a</i>');
    expect(document.querySelector('[data-ssr-bind="a"] i')).toBeNull();
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

  it('a refused write leaves an input alone when no value was received for it', () => {
    document.body.innerHTML = '<input ssr:bind="counter" type="number" />';
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    sendInit({}, '3f7a');
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.value = '-1';
    rt.onError(() => {});
    latestMockWs().serverSend(JSON.stringify({
      t: 'err', routeKey: '3f7a', var: 'counter', msg: 'negative', code: 'validation_failed',
    }));
    expect(input.value).toBe('-1');
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

describe('checkbox and radio ssr:bind', () => {
  it('a checkbox sends its checked state as a boolean', () => {
    document.body.innerHTML = '<input ssr:bind="done" type="checkbox" />';
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const box = document.querySelector<HTMLInputElement>('input')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(latestMockWs().sentMessages.map((m) => JSON.parse(m))).toEqual([
      { t: 'write', routeKey: '3f7a', var: 'done', value: true },
      { t: 'write', routeKey: '3f7a', var: 'done', value: false },
    ]);
    rt.destroy();
  });

  it('a radio sends its value', () => {
    document.body.innerHTML = '<input ssr:bind="mode" type="radio" value="fast" />';
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const radio = document.querySelector<HTMLInputElement>('input')!;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    expect(JSON.parse(latestMockWs().sentMessages[0])).toEqual({ t: 'write', routeKey: '3f7a', var: 'mode', value: 'fast' });
    rt.destroy();
  });

  const radioGroup =
    '<input ssr:bind="mode" type="radio" name="m" value="fast" />' +
    '<input ssr:bind="mode" type="radio" name="m" value="slow" />';

  function radios(): { value: string; checked: boolean }[] {
    return Array.from(document.querySelectorAll<HTMLInputElement>('input')).map((r) => ({ value: r.value, checked: r.checked }));
  }

  function refuse(name: string): void {
    latestMockWs().serverSend(JSON.stringify({ t: 'err', routeKey: '3f7a', var: name, msg: 'no', code: 'validation_failed' }));
  }

  it('a patch checks the matching radio and keeps every radio value', () => {
    document.body.innerHTML = radioGroup;
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    sendPatch('3f7a.mode', 'slow', '3f7a');
    expect(radios()).toEqual([{ value: 'fast', checked: false }, { value: 'slow', checked: true }]);
    sendPatch('3f7a.mode', 'fast', '3f7a');
    expect(radios()).toEqual([{ value: 'fast', checked: true }, { value: 'slow', checked: false }]);
    rt.destroy();
  });

  it('a patch unticks and ticks a checkbox', () => {
    document.body.innerHTML = '<input ssr:bind="done" type="checkbox" checked />';
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const box = document.querySelector<HTMLInputElement>('input')!;
    sendPatch('3f7a.done', 'false', '3f7a');
    expect(box.checked).toBe(false);
    sendPatch('3f7a.done', 'true', '3f7a');
    expect(box.checked).toBe(true);
    expect(box.value).toBe('on');
    rt.destroy();
  });

  it('a refused write restores the radio and checkbox state by checked', () => {
    document.body.innerHTML = radioGroup + '<input ssr:bind="done" type="checkbox" />';
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    rt.onError(() => {});
    sendInit({ '3f7a.mode': 'fast', '3f7a.done': 'true' }, '3f7a');
    const [fast, slow, box] = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
    slow.checked = true;
    box.checked = false;
    refuse('mode');
    refuse('done');
    expect([fast.checked, slow.checked]).toEqual([true, false]);
    expect([fast.value, slow.value]).toEqual(['fast', 'slow']);
    expect(box.checked).toBe(true);
    expect(box.value).toBe('on');
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
    setVisibility('hidden');
    setVisibility('visible');
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
// Test 9: Unexpected close — reconnect path; a 1008 close logs its reason
//
// The server closes with 1008 for a slow client and for a refused page call.
// ---------------------------------------------------------------------------

describe('policy close (1008)', () => {
  it.each(['slow client', 'This page is not allowed.'])('logs the close reason: %s', (reason) => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = makeRuntime();
    latestMockWs().serverClose(1008, reason);
    expect(warnSpy).toHaveBeenCalledWith('[gossr] The server closed the connection (1008): ' + reason);
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

  it('does not emit the 1008 warn for other unexpected closes (1006, 1011)', () => {
    vi.useFakeTimers();

    // code 1006 (abnormal closure)
    const warnSpy1006 = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt1 = makeRuntime();
    latestMockWs().serverClose(1006, 'abnormal');
    expect(warnSpy1006).not.toHaveBeenCalledWith(expect.stringContaining('(1008)'));
    rt1.destroy();
    warnSpy1006.mockRestore();

    // code 1011 (internal server error)
    getSharedConnectionRegistry().clear();
    const warnSpy1011 = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt2 = makeRuntime();
    latestMockWs().serverClose(1011, 'internal error');
    expect(warnSpy1011).not.toHaveBeenCalledWith(expect.stringContaining('(1008)'));
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

  it('returns a patch value as received', () => {
    const rt = makeRuntime();
    sendPatch('x', '&amp;third');
    expect(rt.get('x')).toBe('&amp;third');
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

  it('callback receives a patch value as received', () => {
    const rt = makeRuntime();
    const cb = vi.fn();
    rt.on('counter', cb);
    sendPatch('counter', '&quot;7&quot;');
    expect(cb).toHaveBeenCalledWith('&quot;7&quot;');
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

  it('ignores an init frame whose bindings are not an object', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = makeRuntime();
    expect(() => {
      latestMockWs().serverSend(JSON.stringify({ t: 'init', routeKey: '', bindings: null }));
      latestMockWs().serverSend(JSON.stringify({ t: 'init', routeKey: '' }));
      latestMockWs().serverSend(JSON.stringify({ t: 'init', routeKey: '', bindings: 'x' }));
    }).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('init frame without bindings'));
    expect(rt.get('0')).toBeUndefined();
    rt.destroy();
  });

  it.each(['null', '5', '"x"'])('ignores a frame that is not an object: %s', (raw) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = makeRuntime();
    expect(() => latestMockWs().serverSend(raw)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith('[gossr] Received a frame that is not an object; ignoring.');
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

    // Each runtime reads its own route's value by the variable's name
    expect(parentRt.get('count')).toBe('5');
    expect(childRt.get('count')).toBe('7');

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

// ---------------------------------------------------------------------------
// Applying values
// ---------------------------------------------------------------------------

describe('applying values', () => {
  it('escaped value shows as text', () => {
    document.body.innerHTML = '<span data-ssr-bind="x"></span>';
    const rt = makeRuntime();
    sendInit({ x: '&lt;img src=x onerror=alert(1)&gt;' });
    sendPatch('x', '&lt;img src=x onerror=alert(1)&gt;');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('[data-ssr-bind="x"]')!.textContent).toBe('<img src=x onerror=alert(1)>');
    rt.destroy();
  });

  it('markup sets innerHTML', () => {
    document.body.innerHTML = '<span data-ssr-bind="x"></span>';
    const rt = makeRuntime();
    sendPatch('x', '<em>hi</em>');
    expect(document.querySelector('[data-ssr-bind="x"] em')!.textContent).toBe('hi');
    rt.destroy();
  });

  it('input gets the decoded text', () => {
    const value = '&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;';
    const decoded = '<b>x</b> & "y"';
    document.body.innerHTML = '<input type="text" data-ssr-bind="v"><input type="text" ssr:bind="v">';
    const inputs = document.querySelectorAll<HTMLInputElement>('input');
    const rt = makeRuntime();
    const cb = vi.fn();
    rt.on('v', cb);
    sendPatch('v', value);
    expect(inputs[0].value).toBe(decoded);
    expect(inputs[1].value).toBe(decoded);
    expect(rt.get('v')).toBe(value);
    expect(cb).toHaveBeenCalledWith(value);
    rt.destroy();
  });

  it('an err reset writes the decoded text into the input', () => {
    document.body.innerHTML = '<input ssr:bind="v" type="text" />';
    const input = document.querySelector('input')!;
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    rt.onError(() => {});
    sendInit({ v: '&lt;b&gt; &amp;' });
    input.value = 'typed';
    latestMockWs().serverSend(JSON.stringify({
      t: 'err', routeKey: '3f7a', var: 'v', msg: 'bad', code: 'validation_failed',
    }));
    expect(input.value).toBe('<b> &');
    rt.destroy();
  });

  it('decoding runs no markup', () => {
    const onMutation = vi.fn();
    const hit = vi.fn();
    (window as unknown as { hit: () => void }).hit = hit;
    document.body.innerHTML = '<input type="text" data-ssr-bind="v">';
    const input = document.querySelector('input')!;
    const rt = makeRuntime();
    const observer = new MutationObserver(onMutation);
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const count = document.getElementsByTagName('*').length;

    sendPatch('v', '&lt;img src=x onerror=hit()&gt;');
    sendPatch('v', '</textarea><img src=x onerror=hit()>');

    expect(input.value).toBe('</textarea><img src=x onerror=hit()>');
    expect(document.getElementsByTagName('*').length).toBe(count);
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    expect(onMutation).not.toHaveBeenCalled();
    expect(hit).not.toHaveBeenCalled();
    rt.destroy();
  });

  it('a checkbox gets checked from the decoded text', () => {
    document.body.innerHTML = '<input type="checkbox" data-ssr-bind="on">';
    const box = document.querySelector<HTMLInputElement>('input')!;
    const rt = makeRuntime();
    sendPatch('on', 'true');
    expect(box.checked).toBe(true);
    sendPatch('on', 'false');
    expect(box.checked).toBe(false);
    rt.destroy();
  });

  it('a radio is checked when the decoded text matches its value', () => {
    document.body.innerHTML =
      '<input type="radio" name="c" value="a&b" data-ssr-bind="c">' +
      '<input type="radio" name="c" value="b" data-ssr-bind="c" checked>';
    const inputs = document.querySelectorAll<HTMLInputElement>('input');
    const rt = makeRuntime();
    sendPatch('c', 'a&amp;b');
    expect(inputs[0].checked).toBe(true);
    expect(inputs[1].checked).toBe(false);
    rt.destroy();
  });

  it('a text input, textarea and select get the value', () => {
    document.body.innerHTML =
      '<input type="text" data-ssr-bind="v"><textarea data-ssr-bind="v"></textarea>' +
      '<select data-ssr-bind="v"><option value="a">a</option><option value="b">b</option></select>';
    const rt = makeRuntime();
    sendPatch('v', 'b');
    expect(document.querySelector('input')!.value).toBe('b');
    expect(document.querySelector('textarea')!.value).toBe('b');
    expect(document.querySelector('select')!.value).toBe('b');
    rt.destroy();
  });

  it('a focused text input keeps its value', () => {
    document.body.innerHTML = '<input type="text" data-ssr-bind="q"><input type="text" data-ssr-bind="q">';
    const inputs = document.querySelectorAll<HTMLInputElement>('input');
    const focused = inputs[0];
    const other = inputs[1];
    focused.value = 'typing';
    focused.focus();
    const rt = makeRuntime();
    sendPatch('q', 'server');
    expect(focused.value).toBe('typing');
    expect(other.value).toBe('server');
    rt.destroy();
  });

  it('a value that is not a string is ignored', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    document.body.innerHTML = '<span data-ssr-bind="x">old</span>';
    const rt = makeRuntime();
    const cb = vi.fn();
    rt.on('x', cb);
    latestMockWs().serverSend(JSON.stringify({ t: 'init', routeKey: '', bindings: { x: { html: '<b>' } } }));
    latestMockWs().serverSend(JSON.stringify({ t: 'patch', routeKey: '', key: 'x' }));
    latestMockWs().serverSend(JSON.stringify({ t: 'patch', routeKey: '', key: 'x', html: 1 }));
    expect(document.querySelector('[data-ssr-bind="x"]')!.innerHTML).toBe('old');
    expect(rt.get('x')).toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(3);
    rt.destroy();
  });
});

describe('first frame', () => {
  it('the first frame is not hello', () => {
    const rt = new SsrRuntime('ws://localhost/__ws', '3f7a');
    rt.onConnect(() => rt.set('x', 1 as unknown as never));
    latestMockWs().serverOpen();
    expect(latestMockWs().sentMessages.map((m) => JSON.parse(m))).toEqual([{ t: 'write', routeKey: '3f7a', var: 'x', value: 1 }]);
    rt.destroy();
  });
});

describe('close codes', () => {
  it('does not reconnect after close code 1001', () => {
    vi.useFakeTimers();
    const rt = makeRuntime();
    latestMockWs().serverClose(1001, 'going away');
    vi.advanceTimersByTime(60_000);
    expect(mockWsInstances).toHaveLength(1);
    rt.destroy();
  });

  it('close 4000 after 30 s open reconnects at once', () => {
    vi.useFakeTimers();
    const rt = makeRuntime();
    vi.advanceTimersByTime(30_000);
    latestMockWs().serverClose(StatusReauth, 'reauth');
    expect(mockWsInstances).toHaveLength(2);
    rt.destroy();
  });

  it('close 4000 right after open waits the back-off', () => {
    vi.useFakeTimers();
    const rt = makeRuntime();
    vi.advanceTimersByTime(29_000);
    latestMockWs().serverClose(StatusReauth, 'reauth');
    vi.advanceTimersByTime(800);
    expect(mockWsInstances).toHaveLength(1);
    vi.advanceTimersByTime(400);
    expect(mockWsInstances).toHaveLength(2);
    rt.destroy();
  });

  it('other closes keep the back-off', () => {
    vi.useFakeTimers();
    const rt = makeRuntime();
    latestMockWs().serverClose(1011, 'internal error');
    vi.advanceTimersByTime(800);
    expect(mockWsInstances).toHaveLength(1);
    vi.advanceTimersByTime(400);
    expect(mockWsInstances).toHaveLength(2);
    rt.destroy();
  });
});

// ---------------------------------------------------------------------------
// Hidden tab
// ---------------------------------------------------------------------------

describe('hidden tab', () => {
  it('hidden tab closes the connection and visible reopens it', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span data-ssr-bind="x"></span><span data-ssr-bind="y"></span>';
    const rt = makeRuntime();
    const disconnectCb = vi.fn();
    rt.onDisconnect(disconnectCb);
    sendInit({ x: 'one', y: '<b>a</b>' });
    const ws1 = latestMockWs();

    setVisibility('hidden');
    expect(ws1.clientClose).toEqual({ code: 1000, reason: expect.any(String) });
    expect(getSharedConnectionRegistry().get('ws://localhost/__ws')!.isPaused()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(mockWsInstances).toHaveLength(1);
    expect(disconnectCb).not.toHaveBeenCalled();

    setVisibility('visible');
    expect(mockWsInstances).toHaveLength(2);
    expect(getSharedConnectionRegistry().get('ws://localhost/__ws')!.isPaused()).toBe(false);
    latestMockWs().serverOpen();
    expect(latestMockWs().sentMessages).toHaveLength(0);
    sendInit({ x: 'two', y: '<b>b</b>' });
    expect(document.querySelector('[data-ssr-bind="x"]')!.textContent).toBe('two');
    expect(document.querySelector('[data-ssr-bind="y"]')!.innerHTML).toBe('<b>b</b>');
    expect(rt.get('x')).toBe('two');
    rt.destroy();
  });

  it('hidden tab cancels a pending reconnect and visible reconnects at once', () => {
    vi.useFakeTimers();
    const rt = makeRuntime();
    latestMockWs().serverClose(1006, 'gone');
    setVisibility('hidden');
    vi.advanceTimersByTime(60_000);
    expect(mockWsInstances).toHaveLength(1);
    setVisibility('visible');
    expect(mockWsInstances).toHaveLength(2);
    rt.destroy();
  });

  it('hidden tab while connecting does not report a refused upgrade', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rt = new SsrRuntime('ws://localhost/__ws');
    const connectErrorCb = vi.fn();
    rt.onConnectError(connectErrorCb);
    setVisibility('hidden');
    expect(latestMockWs().clientClose).not.toBeNull();
    expect(connectErrorCb).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    setVisibility('visible');
    expect(mockWsInstances).toHaveLength(2);
    rt.destroy();
  });

  it('a refused upgrade after the tab is shown again retries with the back-off', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rt = makeRuntime();
    const connectErrorCb = vi.fn();
    rt.onConnectError(connectErrorCb);
    setVisibility('hidden');
    setVisibility('visible');

    for (const wait of [1200, 2400]) {
      latestMockWs().serverError();
      latestMockWs().serverClose(1006, '');
      vi.advanceTimersByTime(wait);
    }
    expect(mockWsInstances).toHaveLength(4);
    latestMockWs().serverOpen();
    expect(latestMockWs().sentMessages).toHaveLength(0);
    expect(connectErrorCb).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    // Once a socket opened again, a refused upgrade is final as before.
    sendInit({});
    latestMockWs().serverClose(1006, 'gone');
    vi.advanceTimersByTime(1200);
    latestMockWs().serverError();
    latestMockWs().serverClose(1006, '');
    vi.advanceTimersByTime(60_000);
    expect(mockWsInstances).toHaveLength(5);
    expect(connectErrorCb).toHaveBeenCalledOnce();
    rt.destroy();
  });

  it('three refused upgrades in a row after the tab is shown again are final', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rt = makeRuntime();
    const connectErrorCb = vi.fn();
    rt.onConnectError(connectErrorCb);
    setVisibility('hidden');
    setVisibility('visible');

    for (const wait of [1200, 2400]) {
      latestMockWs().serverError();
      latestMockWs().serverClose(1006, '');
      vi.advanceTimersByTime(wait);
    }
    expect(connectErrorCb).not.toHaveBeenCalled();
    const waiting = rt.call('x' as never, null as never);
    latestMockWs().serverError();
    latestMockWs().serverClose(1006, '');
    await expect(waiting).rejects.toMatchObject({ status: 0 });
    await expect(rt.call('x' as never, null as never)).rejects.toMatchObject({ status: 0 });
    vi.advanceTimersByTime(60_000);
    expect(mockWsInstances).toHaveLength(4);
    expect(connectErrorCb).toHaveBeenCalledExactlyOnceWith(0);
    expect(errorSpy).toHaveBeenCalledOnce();
    rt.destroy();
  });

  it('an open socket resets the count of refused upgrades', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = makeRuntime();
    const connectErrorCb = vi.fn();
    rt.onConnectError(connectErrorCb);
    for (let round = 0; round < 2; round++) {
      setVisibility('hidden');
      setVisibility('visible');
      for (const wait of [1200, 2400]) {
        latestMockWs().serverError();
        latestMockWs().serverClose(1006, '');
        vi.advanceTimersByTime(wait);
      }
      latestMockWs().serverOpen();
      sendInit({});
    }
    expect(mockWsInstances).toHaveLength(7);
    expect(connectErrorCb).not.toHaveBeenCalled();
    rt.destroy();
  });

  it('a refused first upgrade in a tab hidden at load stays final', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const rt = new SsrRuntime('ws://localhost/__ws');
    const connectErrorCb = vi.fn();
    rt.onConnectError(connectErrorCb);
    setVisibility('visible');
    latestMockWs().serverError();
    latestMockWs().serverClose(1006, '');
    vi.advanceTimersByTime(60_000);
    expect(mockWsInstances).toHaveLength(1);
    expect(connectErrorCb).toHaveBeenCalledOnce();
    rt.destroy();
  });

  it('a server close 1000 while visible stays final', () => {
    vi.useFakeTimers();
    const rt = makeRuntime();
    latestMockWs().serverClose(1000, 'normal');
    setVisibility('hidden');
    setVisibility('visible');
    vi.advanceTimersByTime(60_000);
    expect(mockWsInstances).toHaveLength(1);
    rt.destroy();
  });

  it('a tab hidden at load connects when first shown', () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.body.innerHTML = '<span data-ssr-bind="x">ssr-x</span><span data-ssr-bind="y">ssr-y</span>';
    const rt = new SsrRuntime('ws://localhost/__ws');
    expect(mockWsInstances).toHaveLength(0);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    setVisibility('visible');
    expect(mockWsInstances).toHaveLength(1);
    latestMockWs().serverOpen();
    expect(latestMockWs().sentMessages).toHaveLength(0);
    sendInit({ x: 'live-x', y: '<b>live-y</b>' });
    expect(document.querySelector('[data-ssr-bind="x"]')!.textContent).toBe('live-x');
    expect(document.querySelector('[data-ssr-bind="y"]')!.innerHTML).toBe('<b>live-y</b>');
    rt.destroy();
  });

  it('destroy stops watching the tab', () => {
    const rt = makeRuntime();
    rt.destroy();
    setVisibility('hidden');
    setVisibility('visible');
    expect(mockWsInstances).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ssr:bind with two routes on one page
// ---------------------------------------------------------------------------

describe('ssr:bind with two routes on one page', () => {
  function twoRoutes(): { root: SsrRuntime; home: SsrRuntime; input: HTMLInputElement } {
    document.body.innerHTML = '<input ssr:bind="displayName" data-ssr-route="9d1e" type="text" />';
    const root = new SsrRuntime('ws://localhost/__ws', '3f7a');
    const home = new SsrRuntime('ws://localhost/__ws', '9d1e');
    latestMockWs().serverOpen();
    sendInit({ '3f7a.title': 'Home', '9d1e.displayName': '&lt;Bob&gt;' }, '9d1e');
    return { root, home, input: document.querySelector('input')! };
  }

  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('typing sends exactly one write, from the owner', () => {
    const { root, home, input } = twoRoutes();
    type(input, 'Alice');
    expect(latestMockWs().sentMessages.map((m) => JSON.parse(m))).toEqual([
      { t: 'write', routeKey: '9d1e', var: 'displayName', value: 'Alice' },
    ]);
    root.destroy();
    home.destroy();
  });

  it('after an ack the input keeps the typed value', () => {
    const { root, home, input } = twoRoutes();
    root.onError(() => {});
    type(input, 'Alice');
    // The server acks the owner's write and refuses any other route's.
    for (const m of latestMockWs().sentMessages) {
      const { routeKey, var: name } = JSON.parse(m);
      latestMockWs().serverSend(JSON.stringify(routeKey === '9d1e'
        ? { t: 'ack', routeKey, var: name }
        : { t: 'err', routeKey, var: name, msg: 'unknown variable', code: 'validation_failed' }));
    }
    expect(input.value).toBe('Alice');
    root.destroy();
    home.destroy();
  });

  it("after an err from the owner the input resets to the owner's last value", () => {
    const { root, home, input } = twoRoutes();
    home.onError(() => {});
    type(input, 'Alice');
    latestMockWs().serverSend(JSON.stringify({
      t: 'err', routeKey: '9d1e', var: 'displayName', msg: 'too short', code: 'validation_failed',
    }));
    expect(input.value).toBe('<Bob>');
    root.destroy();
    home.destroy();
  });

  it('an err about a variable the route does not own leaves the input alone', () => {
    const { root, home, input } = twoRoutes();
    const rootErrors = vi.fn();
    root.onError(rootErrors);
    type(input, 'Alice');
    latestMockWs().serverSend(JSON.stringify({
      t: 'err', routeKey: '3f7a', var: 'displayName', msg: 'unknown variable', code: 'validation_failed',
    }));
    expect(input.value).toBe('Alice');
    expect(rootErrors).toHaveBeenCalledWith('displayName', 'unknown variable');
    root.destroy();
    home.destroy();
  });

  it('same-named variables in two routes: each input writes to its own route', () => {
    document.body.innerHTML =
      '<input id="r" ssr:bind="name" data-ssr-route="3f7a" type="text" />' +
      '<input id="h" ssr:bind="name" data-ssr-route="9d1e" type="text" />';
    const root = new SsrRuntime('ws://localhost/__ws', '3f7a');
    const home = new SsrRuntime('ws://localhost/__ws', '9d1e');
    const ws = latestMockWs();
    ws.serverOpen();
    sendInit({ '3f7a.name': 'R', '9d1e.name': 'H' });
    const r = document.querySelector<HTMLInputElement>('#r')!;
    const h = document.querySelector<HTMLInputElement>('#h')!;
    expect(r.value).toBe('R');
    expect(h.value).toBe('H');

    type(r, 'r1');
    type(h, 'h1');
    expect(ws.sentMessages.map((m) => JSON.parse(m))).toEqual([
      { t: 'write', routeKey: '3f7a', var: 'name', value: 'r1' },
      { t: 'write', routeKey: '9d1e', var: 'name', value: 'h1' },
    ]);

    root.onError(() => {});
    ws.serverSend(JSON.stringify({ t: 'err', routeKey: '3f7a', var: 'name', msg: 'bad', code: 'validation_failed' }));
    expect(r.value).toBe('R');
    expect(h.value).toBe('h1');
    root.destroy();
    home.destroy();
  });

  it('a variable the route never renders on its own is written by its owner', () => {
    document.body.innerHTML = '<input ssr:bind="note" data-ssr-route="9d1e" type="text" />';
    const root = new SsrRuntime('ws://localhost/__ws', '3f7a');
    const home = new SsrRuntime('ws://localhost/__ws', '9d1e');
    latestMockWs().serverOpen();
    sendInit({ '3f7a.title': 'Home', '9d1e.a1b2c3d4e5f60708': 'x' });
    type(document.querySelector('input')!, 'hello');
    expect(latestMockWs().sentMessages.map((m) => JSON.parse(m))).toEqual([
      { t: 'write', routeKey: '9d1e', var: 'note', value: 'hello' },
    ]);
    root.destroy();
    home.destroy();
  });

  it('an unmarked input on a page with two routes is claimed by neither', () => {
    document.body.innerHTML = '<input ssr:bind="displayName" type="text" />';
    const root = new SsrRuntime('ws://localhost/__ws', '3f7a');
    const home = new SsrRuntime('ws://localhost/__ws', '9d1e');
    const ws = latestMockWs();
    ws.serverOpen();
    sendInit({ '3f7a.displayName': 'A', '9d1e.displayName': 'B' });
    const input = document.querySelector('input')!;
    expect(input.value).toBe('');
    type(input, 'Alice');
    expect(ws.sentMessages).toHaveLength(0);
    home.onError(() => {});
    ws.serverSend(JSON.stringify({ t: 'err', routeKey: '9d1e', var: 'displayName', msg: 'bad', code: 'validation_failed' }));
    expect(input.value).toBe('Alice');
    root.destroy();
    home.destroy();
  });

  it("a patch of the owner's variable updates the input", () => {
    const { root, home, input } = twoRoutes();
    sendPatch('9d1e.displayName', 'Carol &amp; Dave', '9d1e');
    expect(input.value).toBe('Carol & Dave');
    root.destroy();
    home.destroy();
  });
});

// ---------------------------------------------------------------------------
// Runtime registration, destroy and ssr:bind edge cases
// ---------------------------------------------------------------------------

describe('get and on with variable names', () => {
  it("a route reads its own variables by name", () => {
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const cb = vi.fn();
    rt.on('count', cb);
    sendInit({ '3f7a.count': '5', '9d1e.count': '7' }, '9d1e');
    expect(rt.get('count')).toBe('5');
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith('5');
    sendPatch('9d1e.count', '8', '9d1e');
    sendPatch('3f7a.count', '6', '3f7a');
    expect(rt.get('count')).toBe('6');
    expect(cb).toHaveBeenLastCalledWith('6');
    expect(cb).toHaveBeenCalledTimes(2);
    rt.destroy();
  });

  it('a route with a route key does not read bare keys', () => {
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const cb = vi.fn();
    rt.on('count', cb);
    sendInit({ count: '5' });
    expect(rt.get('count')).toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
    rt.destroy();
  });
});

describe('destroy', () => {
  function twoRuntimes(): { root: SsrRuntime; home: SsrRuntime; input: HTMLInputElement } {
    document.body.innerHTML = '<input ssr:bind="name" data-ssr-route="9d1e" type="text" />';
    const root = new SsrRuntime('ws://localhost/__ws', '3f7a');
    const home = new SsrRuntime('ws://localhost/__ws', '9d1e');
    latestMockWs().serverOpen();
    return { root, home, input: document.querySelector('input')! };
  }

  it('removes the ssr:bind listeners', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, home, input } = twoRuntimes();
    home.destroy();
    input.value = 'Alice';
    input.dispatchEvent(new Event('input'));
    expect(latestMockWs().sentMessages).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
    root.destroy();
  });

  it('set after destroy sends nothing and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, home } = twoRuntimes();
    home.destroy();
    home.set('name' as never, 'Alice' as never);
    expect(latestMockWs().sentMessages).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('destroyed'));
    root.destroy();
  });
});

describe('ssr:bind input marked with a route no runtime has', () => {
  it.each([[['3f7a']], [['3f7a', '9d1e']]])('runtimes %j leave it alone', (routeKeys) => {
    document.body.innerHTML = '<input ssr:bind="name" data-ssr-route="dead" type="text" value="v" />';
    const runtimes = routeKeys.map((k) => new SsrRuntime('ws://localhost/__ws', k));
    runtimes.forEach((rt) => rt.onError(() => {}));
    const ws = latestMockWs();
    ws.serverOpen();
    const input = document.querySelector('input')!;
    sendInit(Object.fromEntries(routeKeys.map((k) => [k + '.name', 'init'])));
    routeKeys.forEach((k) => sendPatch(k + '.name', 'patch', k));
    expect(input.value).toBe('v');

    input.value = 'typed';
    input.dispatchEvent(new Event('input'));
    expect(ws.sentMessages).toHaveLength(0);
    routeKeys.forEach((k) => ws.serverSend(JSON.stringify({
      t: 'err', routeKey: k, var: 'name', msg: 'bad', code: 'validation_failed',
    })));
    expect(input.value).toBe('typed');
    runtimes.forEach((rt) => rt.destroy());
  });
});

describe('two runtimes with the same route key', () => {
  it('both stay registered, count as two and are warned about', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    document.body.innerHTML = '<input ssr:bind="name" type="text" />';
    const a = new SsrRuntime('ws://localhost/__ws');
    const b = new SsrRuntime('ws://localhost/__ws');
    expect(warnSpy).toHaveBeenCalledWith('[gossr] Two runtimes on this page share the route key "".');
    const aConnect = vi.fn();
    const bConnect = vi.fn();
    a.onConnect(aConnect);
    b.onConnect(bConnect);
    const ws = latestMockWs();
    ws.serverOpen();
    expect(aConnect).toHaveBeenCalledOnce();
    expect(bConnect).toHaveBeenCalledOnce();

    const input = document.querySelector('input')!;
    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    expect(ws.sentMessages).toHaveLength(0);

    a.destroy();
    expect(ws.clientClose).toBeNull();
    input.value = 'y';
    input.dispatchEvent(new Event('input'));
    expect(ws.sentMessages.map((m) => JSON.parse(m))).toEqual([{ t: 'write', routeKey: '', var: 'name', value: 'y' }]);
    b.destroy();
  });
});

describe('ssr:bind echo', () => {
  it('leaves a focused input as it is', () => {
    document.body.innerHTML = '<input ssr:bind="name" data-ssr-route="3f7a" type="text" />';
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const input = document.querySelector('input')!;
    input.focus();
    input.value = 'Ali';
    sendPatch('3f7a.name', 'Bob', '3f7a');
    expect(input.value).toBe('Ali');
    input.blur();
    sendPatch('3f7a.name', 'Carol', '3f7a');
    expect(input.value).toBe('Carol');
    rt.destroy();
  });

  it('sets a focused checkbox and radio by checked', () => {
    document.body.innerHTML =
      '<input ssr:bind="done" data-ssr-route="3f7a" type="checkbox" />' +
      '<input ssr:bind="mode" data-ssr-route="3f7a" type="radio" name="m" value="fast" />';
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const [box, radio] = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
    box.focus();
    sendPatch('3f7a.done', 'true', '3f7a');
    expect(box.checked).toBe(true);
    radio.focus();
    sendPatch('3f7a.mode', 'fast', '3f7a');
    expect(radio.checked).toBe(true);
    expect(radio.value).toBe('fast');
    rt.destroy();
  });
});

describe('ssr:bind inside a block rendered live', () => {
  function writes(): unknown[] {
    return latestMockWs().sentMessages.map((m) => JSON.parse(m));
  }

  function type(value: string): void {
    const input = document.querySelector('input')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('wires the controls of each new render once and echoes into them', () => {
    document.body.innerHTML = '<ssr-block data-ssr-bind="3f7a.b1"><input ssr:bind="name" type="text" /></ssr-block>';
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    const inner = '<span data-ssr-bind="3f7a.b2"></span>';
    sendInit({ '3f7a.b1': inner, '3f7a.b2': '<input ssr:bind="name" type="text" />' }, '3f7a');
    type('Ann');
    sendPatch('3f7a.b1', '<input ssr:bind="name" type="text" />', '3f7a');
    type('Bob');
    expect(writes()).toEqual([
      { t: 'write', routeKey: '3f7a', var: 'name', value: 'Ann' },
      { t: 'write', routeKey: '3f7a', var: 'name', value: 'Bob' },
    ]);
    sendPatch('3f7a.name', 'Carol', '3f7a');
    expect(document.querySelector('input')!.value).toBe('Carol');
    rt.destroy();
  });

  it('keeps the route that owns a control', () => {
    document.body.innerHTML = '<ssr-block data-ssr-bind="3f7a.b1"></ssr-block>';
    const root = new SsrRuntime('ws://localhost/__ws', '3f7a');
    const home = new SsrRuntime('ws://localhost/__ws', '9d1e');
    latestMockWs().serverOpen();
    sendPatch('3f7a.b1', '<input ssr:bind="displayName" data-ssr-route="9d1e" type="text" />', '3f7a');
    type('Alice');
    sendPatch('3f7a.b1', '<input ssr:bind="displayName" type="text" />', '3f7a');
    type('Bob');
    expect(writes()).toEqual([{ t: 'write', routeKey: '9d1e', var: 'displayName', value: 'Alice' }]);
    root.destroy();
    home.destroy();
  });

  it('stops wiring after destroy', () => {
    document.body.innerHTML = '<ssr-block data-ssr-bind="b"></ssr-block>';
    const other = new SsrRuntime('ws://localhost/__ws', '9d1e');
    const rt = makeRuntime('ws://localhost/__ws', '3f7a');
    rt.destroy();
    sendPatch('b', '<input ssr:bind="name" data-ssr-route="3f7a" type="text" />');
    type('Ann');
    expect(writes()).toEqual([]);
    other.destroy();
  });
});

describe('unchanged markup', () => {
  it('an init equal to the page leaves the block and its focus in place', () => {
    document.body.innerHTML = '<ssr-block data-ssr-bind="k"><a href="/next">Next</a></ssr-block>';
    const link = document.querySelector('a')!;
    link.focus();
    const rt = makeRuntime();
    sendInit({ k: '<a href="/next">Next</a>' });
    expect(document.querySelector('a')).toBe(link);
    expect(document.activeElement).toBe(link);
    rt.destroy();
  });

  it('an init equal to the page keeps what the user opened before it', () => {
    document.body.innerHTML = '<ssr-block data-ssr-bind="k"><details><summary>More</summary></details></ssr-block>';
    const rt = makeRuntime();
    document.querySelector('details')!.open = true;
    sendInit({ k: '<details><summary>More</summary></details>' });
    expect(document.querySelector('details')!.open).toBe(true);
    rt.destroy();
  });

  it('changed markup replaces the block', () => {
    document.body.innerHTML = '<ssr-block data-ssr-bind="k"><a href="/next">Next</a></ssr-block>';
    const link = document.querySelector('a')!;
    const rt = makeRuntime();
    sendInit({ k: '<a href="/next">Later</a>' });
    expect(document.querySelector('a')).not.toBe(link);
    expect(document.querySelector('a')!.textContent).toBe('Later');
    rt.destroy();
  });

  it('a patch or a reconnect init with the markup last applied does nothing', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<ssr-block data-ssr-bind="k"></ssr-block>';
    const rt = makeRuntime();
    const markup = '<details><summary>More</summary></details>';
    sendInit({ k: markup });
    const details = document.querySelector('details')!;
    details.open = true;
    sendPatch('k', markup);
    latestMockWs().serverClose(1006, '');
    vi.advanceTimersByTime(2000);
    latestMockWs().serverOpen();
    sendInit({ k: markup });
    expect(document.querySelector('details')).toBe(details);
    expect(details.open).toBe(true);
    rt.destroy();
  });
});

describe('focus in a replaced block', () => {
  const block = '<ssr-block data-ssr-bind="k"><p>3 open</p><nav><a href="/a">All</a><a href="/o">Open (3)</a></nav></ssr-block>';

  it('moves to the element at the same place in the new markup', () => {
    document.body.innerHTML = block;
    const old = document.querySelectorAll('a')[1];
    old.focus();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const rt = makeRuntime();
    sendInit({ k: '<p>4 open</p><nav><a href="/a">All</a><a href="/o">Open (4)</a></nav>' });
    expect(document.activeElement).not.toBe(old);
    expect(document.activeElement!.textContent).toBe('Open (4)');
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    rt.destroy();
  });

  it('stays where it was when it was outside the block', () => {
    document.body.innerHTML = '<button>Save</button>' + block;
    const button = document.querySelector('button')!;
    button.focus();
    const rt = makeRuntime();
    sendInit({ k: '<p>4 open</p><nav><a href="/a">All</a><a href="/o">Open (4)</a></nav>' });
    expect(document.activeElement).toBe(button);
    rt.destroy();
  });

  it.each([
    ['is gone', '<p>0 open</p><nav><a href="/a">All</a></nav>'],
    ['cannot take focus', '<p>0 open</p><nav><a href="/a">All</a><span>Open (0)</span></nav>'],
  ])('is left alone when the element at its place %s', (_, markup) => {
    document.body.innerHTML = block;
    document.querySelectorAll('a')[1].focus();
    const rt = makeRuntime();
    sendInit({ k: markup });
    expect(document.activeElement).toBe(document.body);
    rt.destroy();
  });
});

describe('stop', () => {
  type Client = SsrRuntime<Record<string, unknown>, Record<string, never>, { ping: { in: object; out: unknown } }>;

  function client(routeKey: string): Client {
    return new SsrRuntime('ws://localhost/__ws', routeKey);
  }

  function twoClients(): { root: Client; home: Client } {
    return { root: client('3f7a'), home: client('9d1e') };
  }

  it('ends the connection for every client on it for good', async () => {
    vi.useFakeTimers();
    const { root, home } = twoClients();
    const ws = latestMockWs();
    ws.serverOpen();
    const callback = vi.fn();
    [root, home].forEach((c) => { c.onDisconnect(callback); c.onConnectError(callback); });
    const call = root.call('ping', {});
    home.stop();
    expect(ws.clientClose).toEqual({ code: 1000, reason: 'stopped' });
    await expect(call).rejects.toMatchObject({ status: 0 });
    await expect(root.call('ping', {})).rejects.toMatchObject({ status: 0 });
    setVisibility('hidden');
    setVisibility('visible');
    vi.advanceTimersByTime(60_000);
    expect(mockWsInstances).toHaveLength(1);
    expect(callback).not.toHaveBeenCalled();
    root.destroy();
    expect(getSharedConnectionRegistry().size).toBe(1);
  });

  it('a stop in one client\'s onDisconnect lets every client hear the close once and stops the reconnect', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, home } = twoClients();
    const rootCb = vi.fn(() => root.stop());
    const homeCb = vi.fn();
    root.onDisconnect(rootCb);
    home.onDisconnect(homeCb);
    latestMockWs().serverOpen();
    latestMockWs().serverClose(1008, 'refused');
    vi.advanceTimersByTime(60_000);
    expect(rootCb.mock.calls).toEqual([[1008, 'refused']]);
    expect(homeCb.mock.calls).toEqual([[1008, 'refused']]);
    expect(mockWsInstances).toHaveLength(1);
  });

  it('a stop in one client\'s onConnectError lets every client hear the refusal once', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { root, home } = twoClients();
    const rootCb = vi.fn(() => root.stop());
    const homeCb = vi.fn();
    root.onConnectError(rootCb);
    home.onConnectError(homeCb);
    latestMockWs().serverError();
    latestMockWs().serverClose(1006, '');
    expect(rootCb.mock.calls).toEqual([[0]]);
    expect(homeCb.mock.calls).toEqual([[0]]);
  });

  it('a client created after stop opens nothing', async () => {
    const { home } = twoClients();
    home.stop();
    const late = client('5c2b');
    expect(mockWsInstances).toHaveLength(1);
    await expect(late.call('ping', {})).rejects.toMatchObject({ status: 0 });
  });
});
