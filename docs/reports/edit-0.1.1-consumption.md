# Edit 0.1.1 release input

2026-09-05. Triptych's fresh image builders now select standalone Edit
`v0.1.1` at `2427501773e8d158d556631b8a4ba1cb972fcb4a`.

The 3,107-byte executable has SHA-256
`73265438a4f2df9a3f507f1bdcd49c48ebabe46cbcdb96e58dc0ee39f8b6a905`.
It fixes overflow of visual columns on long tab-expanded lines. The editor's
47,104-byte text capacity and measured 24-byte maximum stack use are unchanged.

The [Linux CI run](https://github.com/jhlagado/edit/actions/runs/33933433991)
passed the complete editor proof and uploaded the executable and manifest.
Those exact outputs were published as
[`v0.1.1`](https://github.com/jhlagado/edit/releases/tag/v0.1.1), downloaded
again and byte-compared against the CI artifacts. The repair also passed
independent review and the complete local macOS editor check.

The Triptych input verifier checks executable identity, version, ATOM revision,
load/entry addresses and source provenance. The installer test uses a fresh
blank disk and checks record padding and preservation of the input buffer.
The retained historical disk remains unchanged; it is no longer used to
assert that the current released editor equals its old editor bytes.

This update applies to newly built browser disks and newly prepared native
images. The native working-disk path only updates resident system records;
it does not replace saved applications. Browser persistence also remains
separate from the bundled release input. Existing saved disks therefore do
not automatically receive the editor update.

The combined Triptych `npm run check` passed on macOS with AZM imports blocked:
241 Vitest tests, seven real-browser tests, both native PTY exit paths and the
Rust checks/builds. Browser acceptance built the current image and exercised
Edit, NUC, execution, persistence and reopening with this released editor.
The older headless scenario runner still uses the frozen fixture and is not
evidence of v0.1.1 execution.

The new generic release-input verifier separately passes 45 focused tests and
independent review. Its closed provenance includes the raw upstream manifest
digest. Component-specific manifest and placement validation, and a populated
distribution lock, remain the next integration step.

The full pinned OS/application distribution is still pending. This release
input does not establish physical ESP32 or mobile-keyboard qualification.
