/**
 * Tests for wire-format types (protocol.ts).
 * Verifies that the TypeScript types correctly model the JSON shapes for the wire protocol.
 * All 5 frame types carry a routeKey field.
 */

import { describe, it, expect } from 'vitest';
import type {
  InitFrame,
  PatchFrame,
  WriteFrame,
  AckFrame,
  ErrFrame,
  ServerFrame,
} from '../src/protocol.js';

describe('protocol shapes match spec section 4', () => {
  it('InitFrame: t=init, routeKey, bindings is Record<string,string>', () => {
    const frame: InitFrame = {
      t: 'init',
      routeKey: '3f7a',
      bindings: {
        '3f7a.counter': '42',
        '3f7a.a1b2c3d4e5f60708': '<strong>hello</strong>',
        '9d1e.count': '7',
      },
    };
    expect(frame.t).toBe('init');
    expect(frame.routeKey).toBe('3f7a');
    expect(frame.bindings['3f7a.counter']).toBe('42');
    expect(frame.bindings['3f7a.a1b2c3d4e5f60708']).toBe('<strong>hello</strong>');
    expect(frame.bindings['9d1e.count']).toBe('7');
  });

  it('PatchFrame: t=patch, routeKey, key and html fields', () => {
    const frame: PatchFrame = {
      t: 'patch',
      routeKey: '3f7a',
      key: '3f7a.counter',
      html: '43',
    };
    expect(frame.t).toBe('patch');
    expect(frame.routeKey).toBe('3f7a');
    expect(frame.key).toBe('3f7a.counter');
    expect(frame.html).toBe('43');
  });

  it('WriteFrame: t=write, routeKey, var and value fields', () => {
    const frame: WriteFrame = {
      t: 'write',
      routeKey: '3f7a',
      var: 'counter',
      value: '42',
    };
    expect(frame.t).toBe('write');
    expect(frame.routeKey).toBe('3f7a');
    expect(frame.var).toBe('counter');
    expect(frame.value).toBe('42');
  });

  it('AckFrame: t=ack, routeKey, var field', () => {
    const frame: AckFrame = {
      t: 'ack',
      routeKey: '3f7a',
      var: 'counter',
    };
    expect(frame.t).toBe('ack');
    expect(frame.routeKey).toBe('3f7a');
    expect(frame.var).toBe('counter');
  });

  it('ErrFrame: t=err, routeKey, var, msg, and code fields', () => {
    const frame: ErrFrame = {
      t: 'err',
      routeKey: '3f7a',
      var: 'counter',
      msg: 'counter cannot be negative',
      code: 'validation_failed',
    };
    expect(frame.t).toBe('err');
    expect(frame.routeKey).toBe('3f7a');
    expect(frame.var).toBe('counter');
    expect(frame.msg).toBe('counter cannot be negative');
    expect(frame.code).toBe('validation_failed');
  });

  it('ErrFrame: unknown_route has empty routeKey', () => {
    const frame: ErrFrame = {
      t: 'err',
      routeKey: '',
      var: 'counter',
      msg: 'route not found',
      code: 'unknown_route',
    };
    expect(frame.routeKey).toBe('');
    expect(frame.code).toBe('unknown_route');
  });

  it('ServerFrame discriminated union covers all server-to-client types', () => {
    const frames: ServerFrame[] = [
      { t: 'init', routeKey: '3f7a', bindings: {} },
      { t: 'patch', routeKey: '3f7a', key: 'x', html: '1' },
      { t: 'ack', routeKey: '3f7a', var: 'x' },
      { t: 'err', routeKey: '3f7a', var: 'x', msg: 'bad', code: 'validation_failed' },
    ];
    expect(frames).toHaveLength(4);
  });

  it('WriteFrame can be serialised and deserialised as spec prescribes', () => {
    const frame: WriteFrame = { t: 'write', routeKey: '3f7a', var: 'counter', value: '99' };
    const json = JSON.stringify(frame);
    const parsed = JSON.parse(json) as WriteFrame;
    expect(parsed.t).toBe('write');
    expect(parsed.routeKey).toBe('3f7a');
    expect(parsed.var).toBe('counter');
    expect(parsed.value).toBe('99');
  });

  it('init bindings with fully-namespaced composite hash key is accepted', () => {
    // Composite expression hash: routeKey + "." + lowercase hex SHA-256 truncated to 16 chars (spec 3.9)
    const frame: InitFrame = {
      t: 'init',
      routeKey: '3f7a',
      bindings: {
        '3f7a.a1b2c3d4e5f60708': 'composite value',
      },
    };
    expect(typeof frame.bindings['3f7a.a1b2c3d4e5f60708']).toBe('string');
  });

  it('multi-route init frame carries bindings from multiple routeKeys', () => {
    // Spec section 4: single init frame may contain bindings from all reactive routes in the stack
    const frame: InitFrame = {
      t: 'init',
      routeKey: '9d1e', // leaf route key by convention
      bindings: {
        '3f7a.count': '5',       // parent route binding
        '9d1e.count': '7',       // child route binding
        '9d1e.f3a9c1b2e4d56789': '<li>item 1</li>', // child composite binding
      },
    };
    expect(frame.routeKey).toBe('9d1e');
    expect(Object.keys(frame.bindings)).toHaveLength(3);
    expect(frame.bindings['3f7a.count']).toBe('5');
    expect(frame.bindings['9d1e.count']).toBe('7');
  });
});
