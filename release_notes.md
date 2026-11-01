## v0.3.0 — the gate now stays on under sandbox modes

`SANDBOX_MANAGED_MODES` is empty. The old behaviour stepped aside in `read-only` and
`workspace-write`, reasoning that the sandbox already bounds the model. That covers *what*
the model can touch, not *how many times* it touches it — 40 edits inside a workspace-write
session are still 40 edits, and still worth a nudge before the 41st.

Nothing else changed: the counter, the three reminder tiers, and the `confirm` release all
behave as before. If you preferred the old stepping-aside behaviour, set
`SANDBOX_MANAGED_MODES` back to `['read-only', 'workspace-write']` in `lib/index.js`.

### Fixes

- The integration test imported from `'../../confirm-gate/lib/index.js'`, the old package
  name. Anyone running `npm test` got `ERR_MODULE_NOT_FOUND`. Now imports `'../lib/index.js'`.
  The three assertions that encoded the old sandbox-skip behaviour now expect the gate to
  fire.
- Mode detection reads the mode on each call instead of caching it, so switching permission
  modes mid-session follows immediately.

### Notes

- Package renamed to `@steelunion/dsh-confirm-gate`. The unscoped `dsh-confirm-gate` on npm
  stays at 0.2.1 and will not receive this release.
- 27 integration checks pass.

**Full changelog**: https://github.com/SteelUnion/dsh-confirm-gate/compare/v0.2.1...v0.3.0
