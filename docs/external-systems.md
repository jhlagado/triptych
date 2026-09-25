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
  "workDisk": "copy-image",
  "workDrives": ["B", "C", "D"]
}
```

The descriptor is limited to 16 KiB. Images must be exactly 2 MiB and use a
currently admitted two-MiB profile with at least two drive slots. The image's
system area must match that profile's residents byte for byte. Triptych supplies
its own bootstrap and emulator; descriptors cannot supply browser code. A hash
checks downloaded content, not publisher authenticity. Fetches to the publisher
omit credentials, reject redirects and require browser CORS permission when
origins differ. GitHub Pages can host these files.

Each external image has a separate saved-disk namespace identified by its
SHA-256. Its database, writer locks and change notifications are separate from
the built-in demos and other external images. A is the immutable published
image. `copy-image` seeds a new personal B disk with the image's files and
zeroed system tracks; `blank` starts with an empty B disk. The optional
`workDrives` field selects persistent writable browser disks from B through D;
it defaults to `["B"]`, and any additional requested drives start blank. Thus a
four-drive program can start from one link with A mounted read-only and personal
work disks in B, C and D.

Without a drive selector, Triptych chooses a writable slot for every requested
work drive and records the selected slots in the URL. Bookmark that resulting
URL to reopen the same disks. An explicit `b=B1`, `c=C1` or `d=D1` through slot
8 reuses that disk without replacing existing data. If every slot for a drive
has an active writer, the first slot opens read-only. Existing writer locks
still apply.

Keep published version paths immutable. A new application version needs a new
image and descriptor, but no Triptych rebuild while its machine profile remains
compatible. Future incompatible resident profiles need explicit qualification.
