// The runtime warns when a bundle runs it more than once on a page. Each test
// starts from a fresh module registry and an unmarked page.

import { it, expect, vi, beforeEach, afterEach } from 'vitest';

function resetPage(): void {
  vi.resetModules();
  Reflect.deleteProperty(globalThis, Symbol.for('gossr-runtime'));
}

beforeEach(resetPage);

afterEach(() => {
  resetPage();
  vi.restoreAllMocks();
});

it('one copy on the page does not warn', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await import('../src/client.js');
  expect(warn).not.toHaveBeenCalled();
});

it('a second copy warns that each copy opens its own connection', async () => {
  await import('../src/client.js');
  vi.resetModules();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await import('../src/client.js');
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0][0]).toContain("runtimeChunk: 'single'");
});
