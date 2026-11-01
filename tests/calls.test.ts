// Behavioural tests for page calls over the shared live connection.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SsrRuntime, createSsrClient, getSharedConnectionRegistry } from '../src/client.js';
import { CallError, StatusReauth } from '../src/protocol.js';
import { installMockWebSocket, latestMockWs, mockWsInstances } from './mock-websocket.js';

const url = 'ws://localhost/__ws';
let teardown: () => void;

function clearRegistry(): void {
  getSharedConnectionRegistry().forEach((conn) => conn.destroy());
  getSharedConnectionRegistry().clear();
}

beforeEach(() => {
  teardown = installMockWebSocket();
  document.body.innerHTML = '';
  clearRegistry();
});

afterEach(() => {
  clearRegistry();
  Reflect.deleteProperty(document, 'visibilityState');
  teardown();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Calls = {
  star: { in: { starred: boolean }; out: { title: string } };
  ping: { in: Record<string, never>; out: string };
};

function runtime(routeKey = '3f7a'): SsrRuntime<Record<string, unknown>, Record<string, never>, Calls> {
  return new SsrRuntime<Record<string, unknown>, Record<string, never>, Calls>(url, routeKey);
}

function sent(ws = latestMockWs()): unknown[] {
  return ws.sentMessages.map((m) => JSON.parse(m));
}

function answer(frame: object, ws = latestMockWs()): void {
  ws.serverSend(JSON.stringify(frame));
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

// Tracks whether a promise settled, without leaving a rejection unhandled.
function track<T>(p: Promise<T>): { settled: () => boolean } {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  return { settled: () => done };
}

const lost = { status: 0, message: 'The connection was lost.' };

describe('page calls', () => {
  it('call resolves with the result frame value', async () => {
    const rt = runtime();
    latestMockWs().serverOpen();
    const p = rt.call('star', { starred: true });
    expect(sent()).toEqual([{ t: 'call', id: 1, routeKey: '3f7a', name: 'star', args: { starred: true } }]);
    answer({ t: 'result', id: 1, value: { title: 'Note' } });
    await expect(p).resolves.toEqual({ title: 'Note' });
  });

  it('call rejects with CallError on a fail frame', async () => {
    const rt = runtime();
    latestMockWs().serverOpen();
    const p = rt.call('star', { starred: true });
    answer({ t: 'fail', id: 1, status: 404, msg: 'This call is not on this page.' });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CallError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ status: 404, message: 'This call is not on this page.' });
  });

  it('call made before open is sent after open', async () => {
    const rt = runtime();
    const connected = vi.fn(() => expect(sent()).toHaveLength(1));
    rt.onConnect(connected);
    const p = rt.call('star', { starred: false });
    expect(latestMockWs().sentMessages).toHaveLength(0);
    latestMockWs().serverOpen();
    expect(connected).toHaveBeenCalledOnce();
    expect(sent()).toEqual([{ t: 'call', id: 1, routeKey: '3f7a', name: 'star', args: { starred: false } }]);
    answer({ t: 'result', id: 1, value: { title: 'A' } });
    await expect(p).resolves.toEqual({ title: 'A' });
  });

  it('in-flight call rejects with status 0 when the connection drops', async () => {
    vi.useFakeTimers();
    const rt = runtime();
    const ws1 = latestMockWs();
    ws1.serverOpen();
    const p = rt.call('star', { starred: true });
    ws1.serverClose(1006, '');
    await expect(p).rejects.toMatchObject(lost);

    // A call during the reconnect waits; the lost one is not sent again; ids keep counting.
    const q = rt.call('ping', {});
    vi.advanceTimersByTime(1200);
    expect(mockWsInstances).toHaveLength(2);
    latestMockWs().serverOpen();
    expect(sent()).toEqual([{ t: 'call', id: 2, routeKey: '3f7a', name: 'ping', args: {} }]);
    answer({ t: 'result', id: 2, value: 'pong' });
    await expect(q).resolves.toBe('pong');
  });

  it.each([
    ['a close 1000', (ws: ReturnType<typeof latestMockWs>) => ws.serverClose(1000, '')],
    ['a close 1001', (ws: ReturnType<typeof latestMockWs>) => ws.serverClose(1001, '')],
  ])('calls after a final close reject at once: %s', async (_, close) => {
    vi.useFakeTimers();
    const rt = runtime();
    const ws = latestMockWs();
    ws.serverOpen();
    const inFlight = rt.call('star', { starred: true });
    close(ws);
    await expect(inFlight).rejects.toMatchObject(lost);
    await expect(rt.call('ping', {})).rejects.toMatchObject(lost);
    vi.advanceTimersByTime(60_000);
    expect(mockWsInstances).toHaveLength(1);
    expect(ws.sentMessages).toHaveLength(1);
  });

  it('calls after a refused upgrade reject at once, waiting ones too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rt = runtime();
    const waiting = rt.call('star', { starred: true });
    latestMockWs().serverError();
    latestMockWs().serverClose(1006, '');
    await expect(waiting).rejects.toMatchObject(lost);
    await expect(rt.call('ping', {})).rejects.toMatchObject(lost);
  });

  it('a close 1002 is not final: a waiting call is sent after the reconnect', async () => {
    vi.useFakeTimers();
    const rt = runtime();
    latestMockWs().serverOpen();
    latestMockWs().serverClose(1002, '');
    const p = rt.call('ping', {});
    vi.advanceTimersByTime(1200);
    latestMockWs().serverOpen();
    expect(sent()).toEqual([{ t: 'call', id: 1, routeKey: '3f7a', name: 'ping', args: {} }]);
    answer({ t: 'result', id: 1, value: 'pong' });
    await expect(p).resolves.toBe('pong');
  });

  it('a close 4000 rejects sent calls and sends waiting ones after the reconnect', async () => {
    vi.useFakeTimers();
    const rt = runtime();
    latestMockWs().serverOpen();
    vi.advanceTimersByTime(30_000);
    const inFlight = rt.call('star', { starred: true });
    latestMockWs().serverClose(StatusReauth, 'reauth');
    await expect(inFlight).rejects.toMatchObject(lost);
    const waiting = rt.call('ping', {});
    expect(mockWsInstances).toHaveLength(2);
    latestMockWs().serverOpen();
    expect(sent()).toEqual([{ t: 'call', id: 2, routeKey: '3f7a', name: 'ping', args: {} }]);
    answer({ t: 'result', id: 2, value: 'pong' });
    await expect(waiting).resolves.toBe('pong');
  });

  it('calls from two routes share the connection and get their own answers', async () => {
    const root = runtime('3f7a');
    const home = runtime('9d1e');
    latestMockWs().serverOpen();
    const a = root.call('ping', {});
    const b = home.call('star', { starred: true });
    expect(mockWsInstances).toHaveLength(1);
    expect(sent()).toEqual([
      { t: 'call', id: 1, routeKey: '3f7a', name: 'ping', args: {} },
      { t: 'call', id: 2, routeKey: '9d1e', name: 'star', args: { starred: true } },
    ]);
    answer({ t: 'result', id: 2, value: { title: 'home' } });
    answer({ t: 'fail', id: 1, status: 403, msg: 'no' });
    await expect(b).resolves.toEqual({ title: 'home' });
    await expect(a).rejects.toMatchObject({ status: 403, message: 'no' });
  });
});

describe('page calls while the tab is hidden', () => {
  it('a call made while hidden waits until the tab is shown and the socket reopens', async () => {
    const rt = runtime();
    latestMockWs().serverOpen();
    setVisibility('hidden');
    const p = rt.call('ping', {});
    const state = track(p);
    await Promise.resolve();
    expect(state.settled()).toBe(false);
    setVisibility('visible');
    expect(mockWsInstances).toHaveLength(2);
    expect(latestMockWs().sentMessages).toHaveLength(0);
    latestMockWs().serverOpen();
    expect(sent()).toEqual([{ t: 'call', id: 1, routeKey: '3f7a', name: 'ping', args: {} }]);
    answer({ t: 'result', id: 1, value: 'pong' });
    await expect(p).resolves.toBe('pong');
  });

  it('a call waiting when the tab is hidden is sent after it is shown', async () => {
    const rt = runtime();
    const p = rt.call('ping', {});
    setVisibility('hidden');
    expect(latestMockWs().clientClose).not.toBeNull();
    setVisibility('visible');
    latestMockWs().serverOpen();
    expect(sent()).toEqual([{ t: 'call', id: 1, routeKey: '3f7a', name: 'ping', args: {} }]);
    answer({ t: 'result', id: 1, value: 'pong' });
    await expect(p).resolves.toBe('pong');
  });

  it('a call already sent when the tab is hidden rejects with status 0', async () => {
    const rt = runtime();
    latestMockWs().serverOpen();
    const p = rt.call('ping', {});
    setVisibility('hidden');
    await expect(p).rejects.toMatchObject(lost);
  });

  it('a call sent before a quick hide and show rejects with status 0 once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = runtime();
    const ws1 = latestMockWs();
    ws1.serverOpen();
    ws1.deferClose = true;
    const rejected = vi.fn();
    rt.call('ping', {}).catch(rejected);
    setVisibility('hidden');
    setVisibility('visible');
    expect(mockWsInstances).toHaveLength(2);
    ws1.serverClose(1000, 'hidden');
    answer({ t: 'result', id: 1, value: 'late' }, ws1);
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledOnce();
    expect(rejected.mock.calls[0][0]).toMatchObject(lost);
  });

  it('after the tab is shown, a refused upgrade rejects the calls waiting then', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = runtime();
    latestMockWs().serverOpen();
    setVisibility('hidden');
    setVisibility('visible');
    const rejected = vi.fn();
    rt.call('ping', {}).catch(rejected);
    latestMockWs().serverError();
    latestMockWs().serverClose(1006, '');
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledOnce();
    expect(rejected.mock.calls[0][0]).toMatchObject(lost);

    const later = rt.call('star', { starred: true });
    const state = track(later);
    await Promise.resolve();
    expect(state.settled()).toBe(false);
    vi.advanceTimersByTime(1200);
    expect(mockWsInstances).toHaveLength(3);
    latestMockWs().serverOpen();
    expect(sent()).toEqual([{ t: 'call', id: 2, routeKey: '3f7a', name: 'star', args: { starred: true } }]);
    answer({ t: 'result', id: 2, value: { title: 'T' } });
    await expect(later).resolves.toEqual({ title: 'T' });
  });
});

describe('page call answers that are not ours', () => {
  it('a result for an unknown id is ignored with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = runtime();
    latestMockWs().serverOpen();
    const p = rt.call('ping', {});
    const state = track(p);
    answer({ t: 'result', id: 7, value: 'x' });
    answer({ t: 'fail', id: 8, status: 500, msg: 'x' });
    await Promise.resolve();
    expect(state.settled()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    answer({ t: 'result', id: 1, value: 'pong' });
    await expect(p).resolves.toBe('pong');
  });

  it('a result for a call that is still waiting is ignored with a warning', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = runtime();
    latestMockWs().serverOpen();
    latestMockWs().serverClose(1006, '');
    const p = rt.call('ping', {});
    const state = track(p);
    answer({ t: 'result', id: 1, value: 'early' });
    await Promise.resolve();
    expect(state.settled()).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1200);
    latestMockWs().serverOpen();
    answer({ t: 'result', id: 1, value: 'pong' });
    await expect(p).resolves.toBe('pong');
  });

  it('an answer on an earlier connection is ignored with a warning', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = runtime();
    const ws1 = latestMockWs();
    ws1.serverOpen();
    ws1.serverClose(1006, '');
    const p = rt.call('ping', {});
    const state = track(p);
    vi.advanceTimersByTime(1200);
    const ws2 = latestMockWs();
    ws2.serverOpen();
    expect(sent(ws2)).toEqual([{ t: 'call', id: 1, routeKey: '3f7a', name: 'ping', args: {} }]);

    answer({ t: 'result', id: 1, value: 'stale' }, ws1);
    await Promise.resolve();
    expect(state.settled()).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    answer({ t: 'result', id: 1, value: 'pong' }, ws2);
    await expect(p).resolves.toBe('pong');
  });

  it('a fail message reaches only the CallError', async () => {
    document.body.innerHTML = '<p id="out">before</p>';
    const rt = runtime();
    const errors = vi.fn();
    rt.onError(errors);
    latestMockWs().serverOpen();
    const p = rt.call('ping', {});
    const markup = '<img src=x id="evil">';
    answer({ t: 'fail', id: 1, status: 400, msg: markup });
    await expect(p).rejects.toMatchObject({ status: 400, message: markup });
    expect(document.body.innerHTML).toBe('<p id="out">before</p>');
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('page calls and destroy', () => {
  it('a call after destroy rejects with status 0 and sends nothing', async () => {
    const root = runtime('3f7a');
    const home = runtime('9d1e');
    latestMockWs().serverOpen();
    home.destroy();
    await expect(home.call('ping', {})).rejects.toMatchObject(lost);
    expect(latestMockWs().sentMessages).toHaveLength(0);
    root.destroy();
  });

  it('destroying the last runtime rejects its calls', async () => {
    const rt = runtime();
    const waiting = rt.call('ping', {});
    latestMockWs().serverOpen();
    const inFlight = rt.call('ping', {});
    rt.destroy();
    await expect(waiting).rejects.toMatchObject(lost);
    await expect(inFlight).rejects.toMatchObject(lost);
  });
});

describe('page call types', () => {
  it('createSsrClient types call names, arguments and results', async () => {
    const ssr = createSsrClient<Record<string, unknown>, Record<string, never>, Calls>({ wsUrl: url, routeKey: '3f7a' });
    latestMockWs().serverOpen();
    const p: Promise<{ title: string }> = ssr.call('star', { starred: true });
    // @ts-expect-error unknown call name
    void ssr.call('nope', {}).catch(() => {});
    // @ts-expect-error wrong argument type
    void ssr.call('star', { starred: 'yes' }).catch(() => {});
    // @ts-expect-error the result is { title: string }
    const q: Promise<number> = ssr.call('star', { starred: true });
    void q.catch(() => {});
    answer({ t: 'result', id: 1, value: { title: 'T' } });
    await expect(p).resolves.toEqual({ title: 'T' });
  });

  it('a client without calls accepts no call name', () => {
    const ssr = createSsrClient({ wsUrl: url, routeKey: '3f7a' });
    // @ts-expect-error no calls are declared
    void ssr.call('star', { starred: true }).catch(() => {});
  });
});
