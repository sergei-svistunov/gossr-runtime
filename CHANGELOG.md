# Changelog

## 0.2.0

gossr-runtime 0.2.0 needs go-ssr 0.7.0, and go-ssr 0.7.0 needs gossr-runtime 0.2.0. Nothing checks the pairing
at run time: upgrade both together.

### Security

- A form control (`input`, `textarea`, `select`) gets the text of a live value, decoded in an inert document
  where nothing loads or runs, never markup. Only a `data-ssr-bind` element that is not a form control gets the
  value as `innerHTML`.
- A runtime wires only the `ssr:bind` elements whose `data-ssr-route` names its route. An element without the
  attribute belongs to the page's only runtime.

### Breaking

- A close with 1001 is final: `onDisconnect` runs and the runtime does not reconnect.
- An `ssr:bind` checkbox sends its checked state as a JSON boolean.

### Added

- Page calls: `ssr.call(name, args)` sends a call frame and resolves with the call's result, or rejects with a
  `CallError` carrying the server's status and message.
  - Status 0, `The connection was lost.`, means the answer did not arrive. Calls sent on a socket that closes
    reject with it, including a socket that a quick hide and show of the tab abandons.
  - A call made before the connection opens, or while it reconnects, waits and is sent when it opens.
  - Call ids count up per page across reconnects; an answer to a call not sent on that socket is ignored with a
    warning.
  - Calls are never retried.
- Exports: `CallError`, `StatusReauth`, the `Calls` type, and the `CallFrame`, `ResultFrame` and `FailFrame`
  types. `SsrClient` and `createSsrClient` take a third type parameter, `C`, the route's calls.
- Reconnect on 4000, which the server sends when a connection has lived 10 minutes: at once when the connection
  was open at least 30 seconds, else with back-off.
- Hidden tabs: the runtime closes the connection while the tab is hidden, rejecting the calls in flight and
  without `onDisconnect`, and reopens it when the tab is shown. A page opened in a hidden tab connects when first
  shown. A refused reopening retries with back-off, and each refusal rejects the calls waiting at that moment.
  Three refused upgrades in a row are final, as a refused first upgrade is: `onConnectError(0)` runs, waiting
  calls reject with status 0 and later calls at once. A socket that opens resets the count.
- `destroy()` removes the runtime's `ssr:bind` listeners; after it, `set()` warns and `call()` rejects with
  status 0.
- Two runtimes with the same route key on one page log a warning.
- `package-lock.json` is committed, and the package ships its MIT `LICENSE`.

### Fixed

- `get()` and `on()` take a variable's name and find its value under the route's key; before, they looked up the
  bare name, which never matched. They return the string as received.
- The echo of an `ssr:bind` value and the reset after a refused write set `checked` on checkboxes and radio
  buttons, and never rewrite a radio button's value. The echo sets a focused checkbox or radio button, and does
  not overwrite a text control that has focus.
- A refused write leaves an `ssr:bind` control as the user left it when no value was ever received for it;
  before, it was cleared.
- An `ssr:bind` element inside a block that a live value re-renders, including at the init frame, is wired
  after each render; before, the new element had no listeners and neither sent nor received values. Each
  value is applied to the page once, however many runtimes share the connection.
- The warning on a 1008 close logs the server's reason instead of "slow client".
- `npm run typecheck` passes: the default type of the writable variables no longer fails with TS2344.
- Frames that are not objects, init frames without bindings and binding values that are not strings are ignored
  with a warning.
