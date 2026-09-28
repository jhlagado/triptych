# Triptych file recipes v1

File recipes are the first file-oriented workspace contract for the browser
host. A recipe is a small HTTPS JSON document with a machine profile and one or
more named components. Each component lists CP/M filenames and immutable file
references (`url`, `bytes`, and lowercase SHA-256). The browser fetches the
recipe and selected files, verifies every byte, and only then constructs a
fresh two-MiB disk from the admitted Triptych resident system.

The shareable launch form is:

```text
https://jhlagado.github.io/triptych/?workspace=<encoded-recipe-url>&components=atom,edit,example
```

`components` is optional; when omitted, every component is selected. The first
release keeps the writable work disk on B and creates a persistent writable A
from the materialised file disk. A later reload reuses that A slot, while the
existing Restore A action returns to the recipe's verified materialisation.

## Boundary and checks

Recipe files are not a new CP/M filesystem format. `CpmDisk` creates the normal
Triptych two-MiB working geometry, the current profile's 16 KiB resident area
is copied into it, and the ordinary batch-import API installs the files. A
recipe cannot supply residents, bootstrap bytes or a machine implementation.

The loader bounds the JSON to 16 KiB, permits at most 32 components and 64
files, limits one file to 256 KiB and the complete selection to 1 MiB, requires
HTTPS URLs without credentials or fragments, uses anonymous fetches with
redirects rejected, verifies each declared length and SHA-256, rejects
conflicting CP/M names, and does not write browser storage. Storage and launch
ownership remain the existing direct-launch responsibilities.

For a file already present in a future base or selected component, matching
content is accepted once; different content is a hard collision. CP/M record
padding is not part of a recipe's declared byte count.

## Deliberate limits

The v1 contract has no account, server, registry authority, recursive provider
discovery, read-only image mounting, or automatic drive selection. The static
CP/M Recipes site publishes the first recipe and can download a locked subset
as JSON. Future providers may publish their own JSON and bundles; the Triptych
loader should gain those features only through a separately reviewed contract.
