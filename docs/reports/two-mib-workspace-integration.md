# Saved-machine coordinator integration

Date: 2026-09-07. Status: storage/coordinator integration passed focused host
checks; application activation and final release qualification remain pending.

Triptych commits `f009f78` and `a9c8b58` add an explicit saved-machine adapter
to the existing workspace coordinator. The historical adapter retains its
receipt API. The new adapter uses validated authority tokens and receipts,
preserves sparse media positions and compares the complete saved candidate
before activating its prepared runtime.

The new coordinator retains only the first and latest pending checkpoint.
Management operations capture their baseline after that queue drains. Tests
cover stale ownership, failed publication, capture ordering and substitution
of otherwise valid saved media or profile metadata. Substitution rejection
preserves the running machine and disposes of the unused prepared candidate.

At integrated revision `569d51d`, the historical and new coordinator Node
suites passed together: 77 tests, zero skips. The rebuilt browser suite passed
155 tests in 3.6 minutes, including real IndexedDB promotion from a historical
checkpoint with backup, exact reopening and sparse A/P stale-receipt rejection.
The new Node suite is included in `check:wasm-browser-ui`.

```sh
node --test test/wasm/disk-workspace.node.mjs \
  test/wasm/saved-machine-workspace.node.mjs
npm run test:wasm-browser
```

These checks use runtime doubles for coordinator activation. They establish
storage and coordination behavior, not actual sixteen-drive guest execution,
peak browser memory or tool lifetimes. The previous complete repository check
covered the storage/native baseline; the newer integrated changes still require
a complete check and Linux CI before release.
