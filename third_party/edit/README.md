# Edit release input

`EDIT.COM` and `manifest.json` are the published assets from
[`jhlagado/edit` v0.1.1](https://github.com/jhlagado/edit/releases/tag/v0.1.1).
`PROVENANCE.json` pins the immutable source revision and artifact digest.

Triptych consumes this program as an application. It does not own or rebuild
the editor source. `tools/lib/edit-release.mjs` verifies these files before a
fresh release image is assembled.
