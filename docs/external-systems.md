# Published system images

A project can host a versioned CP/M image independently of Triptych. Link to:

```text
https://jhlagado.github.io/triptych/?system=ENCODED_DESCRIPTOR_URL
```

The browser boots directly. No library import or setup confirmation is required.
The publisher supplies an HTTPS JSON descriptor and a same-directory image:

```json
{
  "schema": "triptych-external-system-v1",
  "name": "Example system",
  "instruction": "Type B: to use the work disk",
  "profile": "triptych-cpu-v0.1-2m-n04",
  "image": {
    "asset": "system.img",
    "bytes": 2097152,
    "sha256": "64 lowercase hexadecimal characters"
  },
  "workDisk": "copy-image"
}
```

The descriptor is limited to 16 KiB. Images must be exactly 2 MiB and use a
currently admitted two-MiB profile with at least two drive slots. The image's
system area must match that profile's residents byte for byte. Triptych supplies
its own bootstrap and emulator; descriptors cannot supply browser code. A hash
checks downloaded content, not publisher authenticity. Fetches to the publisher
omit credentials, reject redirects and require browser CORS permission when
origins differ. GitHub Pages can host these files.

A is the immutable published image. `copy-image` seeds a new personal B disk
with the image's files and zeroed system tracks; `blank` starts with an empty
data disk. With no `b` parameter, the existing direct-launch system selects a
free B slot and records it in the URL. Bookmark that resulting URL to reopen
the same disk. An explicit `b=B1` through `b=B8` reuses the selected slot without
replacing existing data. If all eight slots are occupied, select an existing
slot explicitly or manage the saved disks. Existing writer locks still apply.

Keep published version paths immutable. A new application version needs a new
image and descriptor, but no Triptych rebuild while its machine profile remains
compatible. Future incompatible resident profiles need explicit qualification.
