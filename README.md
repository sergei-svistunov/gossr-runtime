# gossr-runtime

TypeScript runtime for GoSSR live values and page calls.

## What this package does

It runs the browser side of a GoSSR page's live connection: one WebSocket per page that receives the values
the server renders, sends the values the page writes, and runs the page's calls. It also wires `ssr:bind`
inputs and reconnects when the connection drops.

Developers do not instantiate it directly. The GoSSR generator emits `__ssr_gen__.ts` next to the template of
every route with live values or page calls, which creates the typed `ssr` client; page code imports that.

## Versions

go-ssr 0.7.0 needs gossr-runtime 0.2.0, and gossr-runtime 0.2.0 needs go-ssr 0.7.0. Nothing checks the
pairing at run time: a mismatched pair fails in ways that are hard to read, so upgrade both together.

```bash
npm install gossr-runtime@^0.2.0
```

`tsconfig.json` needs `"moduleResolution": "bundler"` or `"nodenext"`, so the package's `exports` map is
honoured.

## How the generator wires this in

For a route at `/users/_userId_/info` with a live `lastSeen`, a client-writable `displayName` and a
`refreshLastSeen` call, the generator emits `internal/web/pages/users/_userId_/info/__ssr_gen__.ts`
(generated, do not edit):

```typescript
import { createSsrClient } from 'gossr-runtime';
import 'gossr-runtime/ssr-block.css';

export interface LastSeenOut {
  lastSeen: string;
  at: string;
}

export type ReadVars = {
  displayName: string;
  lastSeen: string;
}

export type WriteVars = {
  displayName: string;
}

export type Calls = {
  refreshLastSeen: { in: Record<string, never>; out: LastSeenOut };
}

export const ssr = createSsrClient<ReadVars, WriteVars, Calls>({
  wsUrl: typeof window !== 'undefined'
    ? window.location.pathname.replace(/\/$/, '') + '/__ws' + window.location.search
    : '',
  routeKey: '2b2f214e',
});
```

- `ReadVars` lists the route's reactive variables. Each is a `string`: the markup the server rendered.
- `WriteVars` lists the client-writable variables with their types.
- `Calls` lists the route's page calls with their argument and result types.
- `wsUrl` is the page's path followed by `/__ws`, with the page's query string; `routeKey` identifies the
  route on the connection.

`gossr-assets-webpack-plugin` bundles `__ssr_gen__.ts` into the route's chunk, so the connection opens on
every such page whether or not the route has an `index.ts`. `ssr-block.css` makes the wrapper elements the
server renders around live values (`<ssr-block>`) take no part in layout.

## API

```typescript
import { CallError } from 'gossr-runtime';
import { ssr } from './__ssr_gen__';

// The last markup received for the variable, or undefined
const html: string | undefined = ssr.get('lastSeen');

// Runs on the init and on every patch of the variable; returns an unsubscribe function
const unsub = ssr.on('lastSeen', (markup) => { /* side effects */ });
unsub();

// Writes a client-writable variable; fire and forget
ssr.set('displayName', 'Ada');

// Runs a page call and awaits its result
ssr.call('refreshLastSeen', {})
  .then((out) => { /* out: LastSeenOut */ })
  .catch((err) => {
    if (err instanceof CallError) { /* err.status, err.message */ }
  });

// Lifecycle hooks; each returns an unsubscribe function
ssr.onConnect(() => { /* connected or reconnected */ });
ssr.onDisconnect((code, reason) => { /* an open connection closed unexpectedly */ });
ssr.onConnectError((status) => { /* the upgrade was refused; status is 0 */ });
ssr.onError((varName, message) => { /* the server refused a write */ });
```

- `get` and `on` take a bare variable name and give the string as received: escaped **markup**, not decoded
  text. They read the variable's plain `{{ name }}` site; a variable without one has nothing to read. Never
  write the string into `innerHTML` unless you mean it as markup.
- `set` sends any JSON value. The accepted value comes back as a patch; a write made while the connection is
  down is dropped. A refused write calls `onError`, or logs a warning when no handler is registered.
- `onConnectError` always receives 0: browsers do not expose the status of a refused upgrade.

The package also exports `CallError`, `StatusReauth` (4000), the `SsrClient` and `Calls` types, the frame
types (`InitFrame`, `PatchFrame`, `WriteFrame`, `AckFrame`, `ErrFrame`, `CallFrame`, `ResultFrame`,
`FailFrame`, `ServerFrame`, `ClientFrame`), `createSsrClient` and `SsrRuntime`. `SsrRuntime.destroy()` removes
the runtime's `ssr:bind` listeners and leaves the shared connection, which closes when no runtime is left on
it; after it, `set` warns and `call` rejects with status 0.

## Live values in the DOM

The server escapes every live value with the same escapers as the first render and sends one markup string per
binding key. The runtime applies it to every element whose `data-ssr-bind` names that key:

- an element that is not a form control gets the string as its `innerHTML`;
- a form control (`input`, `textarea`, `select`) gets the entity-decoded text, decoded in an inert document
  where nothing loads or runs, as its value. A checkbox is checked by the text `true`; a radio button is
  checked when the text equals its own value, which is never rewritten;
- a text control that has focus is not overwritten while the user types; a checkbox or radio button is set
  whether or not it has focus.

## ssr:bind

The runtime wires every `input`, `select` and `textarea` with an `ssr:bind="name"` attribute whose
`data-ssr-route` names its route:

- text-like inputs and `textarea` send their value on `input`; `select`, checkboxes and radio buttons on
  `change`. A checkbox sends its checked state as a JSON boolean, any other control its value as a string;
- the element receives the value the server sends for the variable's plain `{{ name }}` site, as above: a
  focused text control is skipped, a focused checkbox or radio button is set. A page without such a site
  sends no echo;
- when the server refuses a write, bound elements go back to the last value it sent for that site. When it
  has sent none, they keep what the user entered.

When a page has one route, an `ssr:bind` element without `data-ssr-route` belongs to it.

A live value that re-renders a block replaces the elements inside it. The runtime wires the `ssr:bind`
elements of the new markup after each render, once each, with the same `data-ssr-route` rule; what the user
had typed into the replaced element, and its focus, are gone.

## Page calls

`ssr.call(name, args)` sends a call frame with a fresh id and resolves with the call's result, or rejects with
a `CallError`:

- a status the server sent (400, 401, 403, 404, 429, 500, 504, …) comes with the server's message, which is
  meant for the page;
- status 0, `The connection was lost.`, means the answer did not arrive: the socket closed first, or the
  connection is closed for good. The call may still have run on the server.

The runtime never retries a call. A call made before the connection opens, or while it is reconnecting or the
tab is hidden, waits; every waiting call is sent at once when the next socket opens, and the server answers
those over its limit of 4 at a time with 429. Calls already sent on a socket that closes reject with status 0,
including when the tab is hidden. After the tab is shown again, each refused reconnect rejects the calls
waiting at that moment, and once the connection is closed for good later calls reject at once.

Call ids count up for the page across reconnects. An answer to a call that was not sent on the socket that
delivered it is ignored with a warning.

## Connection lifecycle

| Event | What the runtime does |
|---|---|
| close 1000 | final; no `onDisconnect` |
| close 1001 | final; `onDisconnect` |
| close 4000 | `onDisconnect`; reconnects at once if the connection was open at least 30 seconds, else with back-off |
| close 1008 | logs a warning with the server's reason, `onDisconnect`, reconnects with back-off |
| any other close (1006, 1011, …) | `onDisconnect`, reconnects with back-off |
| tab hidden | closes the socket itself, without `onDisconnect`, and rejects the calls in flight |
| tab shown | reopens the connection; a refused upgrade then retries with back-off, and the third refused upgrade in a row is final |
| upgrade refused | final, unless it is a reopening after the tab was shown and fewer than 3 upgrades in a row were refused: `onConnectError(0)`, every waiting call rejects with status 0 and later calls reject at once |

The server closes every connection after 10 minutes with 4000, and the reconnect passes its checks again. It
closes with 1008 when a `Subscribe` refuses the session or when a route guard refuses a call (after that call's
fail frame); the reconnect that follows passes the guards again or is refused. A client that takes more than 10
seconds to accept a frame is disconnected without a close frame it can read (1006), and reconnects with
back-off.

Back-off starts at 1 second and doubles up to 30 seconds, with ±10% jitter; after 5 failed attempts in a row
each further one logs a warning. A valid init frame resets it.

A page opened in a hidden tab connects when the tab is first shown, and a refused upgrade then is final.

A socket that opens resets the count of refused upgrades.

A final refused upgrade — the first one, one after a drop, or the third in a row after the tab is shown again —
usually means the session has ended or the page's guards now refuse it. Reload the page in `onConnectError`, so the server can send the user to sign in:

```typescript
ssr.onConnectError(() => location.reload());
```

## Frames

The frames are an internal contract between this package and the go-ssr version it pairs with; go-ssr's
`docs/fe-be-contract.md` describes them. Every frame is a WebSocket text frame holding one JSON object with a
type field `t`: `init`, `patch`, `ack`, `err`, `result` and `fail` from the server; `write` and `call` from the
client. Binding values are markup strings; call arguments and results are JSON values. The runtime ignores
frames it cannot parse or does not know, with a warning.

## Security

Binding values in `init` and `patch` frames are markup the GoSSR server rendered with the same context escapers
as the page, so a value a user typed arrives escaped. The runtime puts that markup into `innerHTML` only for a
`data-ssr-bind` element that is not a form control; form controls get decoded text, never markup. A `{{$ }}`
site in a template is markup its author vouches for, on the first render and live alike.

`get()` and `on()` hand your code the same markup. Treat it as markup: put it into `innerHTML` only when you
mean to render it, and decode it before using it as text.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` writes `dist/`. The build target is ES2017, for all modern browsers.
