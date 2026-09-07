# Edit release input

`EDIT.COM` and `manifest.json` are the verified Edit 0.2.0 assets downloaded
from the [successful Linux build](https://github.com/jhlagado/edit/actions/runs/34134268198)
of revision `dbbda081b58077c98b509625176739bd9c5608ec`.
Both files match the local native ATOM build byte for byte.
`PROVENANCE.json` records the source revision, artifact digest and CI comparison;
`release.provenance.json` binds the exact binary and manifest to that origin.

Triptych consumes this program as an application. It does not own or rebuild
the editor source. `tools/lib/edit-release.mjs` verifies these files before a
fresh release image is assembled. Existing saved media retain their contents.
