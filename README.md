# gossr-runtime

TypeScript runtime for GoSSR reactive bindings.

## What this package does

Manages the client-side WebSocket connection for GoSSR reactive routes. Developers do not import
this package directly. The GoSSR code generator emits `__ssr_gen__.ts` in each reactive route's
directory, which imports and instantiates the runtime automatically.

## How the generator wires this in

For a reactive route at `/dashboard`, the generator emits:

**`internal/web/pages/dashboard/__ssr_gen__.ts`** (generated, do not edit):
```typescript
import { createSsrClient } from 'gossr-runtime';

// R = full map of reactive variables, W = client-writable subset
export const ssr = createSsrClient<
  { count: number; threshold: number },
  { threshold: number }
>('/dashboard/__ws');
```

**`internal/web/pages/dashboard/index.ts`** (generated import prepended if file exists):
```typescript
import { ssr } from './__ssr_gen__';
// ... rest of developer-written code
```

The generated `__ssr_gen__.d.ts` provides fully-typed autocomplete for variable names.

## webpack alias setup

Add to your project's `webpack.config.js`:
```javascript
resolve: {
  alias: {
    'gossr-runtime': path.resolve(__dirname, 'path/to/go-ssr/pkg/runtime-ts/dist/index.js'),
  },
}
```

Or when used via `go install`, configure `webpack.config.js` to resolve from the module cache.

## Protocol (spec section 4)

All messages are WebSocket text frames containing a single JSON object.

| Frame | Direction | Shape |
|-------|-----------|-------|
| `init` | server -> client | `{ t: "init", bindings: { key: "html" } }` |
| `patch` | server -> client | `{ t: "patch", key: "varName", html: "..." }` |
| `write` | client -> server | `{ t: "write", var: "varName", value: "..." }` |
| `ack` | server -> client | `{ t: "ack", var: "varName" }` |
| `err` | server -> client | `{ t: "err", var: "varName", msg: "..." }` |

Values are always pre-rendered HTML strings (never typed JSON values). The server renders them
using the same Go template engine that produces the initial SSR page.

## Developer API (`SsrClient<R, W>`)

```typescript
// Imported from the generated file, not from gossr-runtime directly:
import { ssr } from './__ssr_gen__';

// Read last known rendered HTML for a variable
const html: string | undefined = ssr.get('count');

// Send a write to the server (fire-and-forget; ack arrives as a patch)
ssr.set('threshold', 50);

// Subscribe to server pushes for a variable; returns unsubscribe function
const unsub = ssr.on('count', (html) => { /* update custom UI */ });
unsub(); // clean up

// Lifecycle hooks
ssr.onConnect(() => { /* WS connected or reconnected */ });
ssr.onDisconnect((code, reason) => { /* WS closed unexpectedly */ });
ssr.onConnectError((status) => { /* WS upgrade rejected; status may be 0 */ });
ssr.onError((varName, message) => { /* server validation rejected a write */ });
```

## Reconnect behavior

On unexpected WS close (any code other than `1000`), the runtime reconnects automatically using
exponential back-off:
- Initial delay: 1 s
- Maximum delay: 30 s
- Jitter: +-10%

After reconnect, the server sends a fresh `init` snapshot so the DOM reflects current server state
without a page reload.

## Upgrade failure behavior

If the WS upgrade is rejected (HTTP non-101 response), the runtime:
1. Does NOT reconnect (retrying a `401` would be pointless without re-authentication).
2. Fires `onConnectError(0)` — the browser WebSocket API does not expose the HTTP status code for
   rejected upgrades; developers who need the status should check their auth state via a separate
   fetch call.
3. Logs `console.error('[gossr] WebSocket upgrade failed for: <url>')`.

## DOM update security note

Binding values received in `init` and `patch` frames are server-generated pre-rendered HTML strings
produced by the GoSSR template engine — the same engine that renders the initial SSR page. They
are set as element content using the DOM API. This is equivalent to SSR hydration and is intentional
framework behavior per spec section 3.3. These values are not user-supplied input.

## Running tests

```
cd pkg/runtime-ts
npm install
npm test
```

## Building

```
npm run build
```

Output goes to `dist/`. The build target is ES2017 (supports `async/await` natively; no need for
async/await downleveling). Browser compatibility: all modern browsers. IE11 is not supported.
