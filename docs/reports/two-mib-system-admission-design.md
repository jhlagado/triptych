# Two-MiB system construction and saved admission

Date: 2026-09-07. Status: design selected after two proposals and an independent
cross-review; implementation and executable qualification remain in progress.

Fresh installation requires verified release assets. Reopening a saved machine
requires a compatible identified bootstrap and exact preservation of its saved
bytes. These are separate operations under the
[two-MiB contract](../specifications/cpm-two-mib-v1.md).

## Selected interfaces

The Node builder constructs a private 16,384-byte system asset and a 256-byte
bootstrap for one configured count. Its descriptor binds the named resident
profile, count-derived layout, component offsets and hashes, exact Portable
CP/M release inputs, ATOM identity, Triptych source revision and raw/generated
machine-source hashes. Separate evidence retains the captured input bytes and
assembled labels for independent verification.

The browser fresh-install operation fetches and verifies only the selected
system and bootstrap. It validates the count/profile tuple, component slices,
DPH and ALV pointers and padding before returning a candidate. Response size
limits apply during reading, not only after allocating the complete body.

Saved admission captures the snapshot and descriptor before asynchronous work,
checks structural count/profile consistency and compares the exact saved
bootstrap digest with the available descriptor. It does not fetch installation
assets, compare saved residents with current releases or rewrite media. Missing
descriptors and incompatible bootstraps prevent execution while preserving
export and recovery access. No failure authorizes initialization over saved data.

New deployment metadata uses a separate optional `twoMibProfiles` collection.
Historical `diskProfiles` rows and their assets retain their existing meanings;
the current verifier requires exactly two historical rows. Historical releases
may omit the new collection. A newly qualified configurable-drive release must
contain all sixteen profiles, while runtime availability can be a subset with
explicit unavailable-profile reporting.

## Source capture and preservation

Machine templates must be captured from the builder's explicit repository root.
Generation, assembly and provenance hashing must use those same captured bytes.
Reading templates relative to a loaded module while reading release inputs from
another root could otherwise combine two different source trees. The descriptor
must also identify the generator actually executed and mark dirty source builds;
a Git revision alone does not identify uncommitted source bytes.

Fresh creation may install the full zero-padded system asset. Resident
reconfiguration replaces only A's bytes `[0, 6656)`, together with matching
bootstrap/count metadata. A's reserved tail `[6656, 16384)`, all filesystem
bytes, all other media and media identities remain unchanged. The preceding
complete machine must be retained before activating the replacement.

Odd/even profile pairs may share identical bootstrap and CCP/BDOS bytes. A saved
n03 machine consistently relabelled n04 can therefore be indistinguishable from
a genuine n04 machine with a guest-modified BIOS. The saved representation does
not establish historical installation identity, correct BIOS drive count or
bootability. Detecting every such relabelling would require a representation
change or restrictions on guest-modified residents. Fresh-install validation
still rejects inconsistent named inputs and neighboring BIOS/table substitutions.

## Alternatives and implementation gates

The selected proposal separates fresh-install verification from saved admission.
Fetching a fresh system bundle on every reopen would add network dependence
without establishing the history of modified saved residents. A separate
metadata collection and explicit release/generator provenance were adopted from
the other proposal. Two candidates were compared; one had prior coordinator
context. An independent reviewer challenged both, followed by the lead's source
and contract checks.

Implementation proceeds through these dependent gates:

1. Capture root-bound machine sources and verify all sixteen constructed tuples,
   including equal-byte neighboring profiles and substituted BIOS tables.
2. Implement bounded browser asset fetching and no-fetch saved admission, with
   owned-input mutation tests and no Node/ATOM browser dependencies.
3. Integrate private reconfiguration, backup/publication and runtime activation;
   compare every byte outside the permitted replacement interval.
4. Qualify complete tool lifetimes, existing recovery paths, Linux and the hosted
   release. Descriptor validation alone does not qualify those workflows.
