# Optional panel and action integration

This interface lets a preset or another extension display the existing summary
panel and invoke its manual action. Installing this change does not enable an
integration, change defaults, move a panel, migrate data or start another engine.
The normal extension settings page and floating window remain the default UI.

`window.MeowLargeSummary` is also available as the named ES module export
`integration` from `index.js`. Wait until `getState().ready` is true. Listen to
`meow-large-summary-state` on the Tavern window for subsequent changes, and read
the initial state when attaching a listener. Do not import a second copy under a
cache-busted URL: the installed extension owns initialization.

## State

`getState()` returns a frozen snapshot: `ready`, `enabled`, `autoEnabled`, `busy`,
`paused`, `stage`, `tokens`, `sourceVersion`, `capabilities` (1.6.0: `runManual.template`,
`compress`, `inputCap`; absent in older versions), and a short `message`. It contains no
settings object, credentials, chat identity, prompt or summary text. The event
`detail` has the same shape. `tokens: null` means no reliable count is available.

## Actions

- `await runManual()` uses the saved mode and template.
- `await runManual({ mode: 'incremental' | 'merged' })` chooses a mode for this run
  only; it does not save or alter the user's mode or settings drafts.
- `await runManual({ operation: 'compact' })` merges existing summaries only.
- `await runManual({ mode, template: '…' })` (1.6.0) uses the given template for
  this run only. It is not saved and does not alter the user's templates, mode or
  drafts. It goes through the same macro expansion, input checks, segmentation,
  save verification and hiding as a normal summary, and a resumed job keeps it.
  Only for ordinary summaries; an empty string or use with `compact`/`compress`
  throws `TypeError`.
- `await runManual({ operation: 'compress', target })` (1.6.0) compresses the
  existing summary to `target` tokens (default: the user's setting, minimum 500).
  The result is counted with the host tokenizer and compressed again if needed, at
  most three rounds. Like `compact`, it never changes message visibility.
- `await setEnabled(boolean)` uses the native switch, cancellation, archive
  activation and confirmed settings-save path. `true` means persistence was
  confirmed; archive cleanup/synchronization may still be busy. Turning off while
  busy is allowed, just like the native switch. A failed save returns `false` and
  retains the native error notice and runtime switch behavior.

Actions return `false` when not ready, disabled or busy, or when the native action
does not complete successfully. Invalid mode/operation/type throws `TypeError`.
All summary checks, locking, save verification and hiding remain in the native
engine. Rebuild, deletion and recovery continue through the original panel.

## Embedding

`mount(container)` accepts a connected HTML element in the Tavern document and
returns a boolean. It moves the **same** panel, including its listeners, current
tab, drafts and task controls. It temporarily suppresses the floating launcher
without saving a visibility preference. An already occupied panel refuses a
different container; mounting the same container is idempotent.

`unmount(container)` only releases that container's own mount. It returns the
panel to its original extension settings location and restores the user's
launcher preference. Removing the container automatically releases it too.
Unmounting does not disable the plugin, cancel tasks, save settings, clear drafts
or remove summary records. A preset must release its mount on navigation/unload
and remove its own state listener; it must not destroy the extension.

```js
const api = window.MeowLargeSummary;
const onState = event => renderStatus(event.detail);
window.addEventListener('meow-large-summary-state', onState);
renderStatus(api.getState());
if (api.getState().ready) api.mount(container);

// On leaving the host panel:
api.unmount(container);
window.removeEventListener('meow-large-summary-state', onState);
```

Embedding does not adopt records from a different plugin/preset namespace.
Integrators must resolve their own previous engine's lifecycle and ownership
before switching. Since 1.2.18, `window.MewoLargeSummary` remains an alias of the same API and
`mewo-large-summary-state` is still emitted for existing integrations. New code
should use the corrected names above and subscribe to only one event name.
No settings or summary records are migrated.
