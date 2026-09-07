import assert from "node:assert/strict";
import { buildTwoMibSystem } from "./two-mib-system.mjs";

/** Proof-only adapter from captured assembly evidence to the instruction
 * observer's regions. It neither relocates code nor patches application bytes.
 */
export async function buildTwoMibLifetimeSystem(root, distribution, count) {
  const built = await buildTwoMibSystem(root, count, {
    allowDirty: distribution.manifest.triptych.dirty,
  });
  const { descriptor, evidence } = built;
  assert.equal(
    descriptor.machine.revision,
    distribution.manifest.triptych.revision,
    "one source revision for tools and machine",
  );
  const { packageIntegrity: _integrity, ...atom } = descriptor.atom;
  assert.deepEqual(atom, distribution.manifest.atom, "one ATOM identity");
  const { ccp, bdos } = evidence.residents;
  const { bios } = evidence.machine;
  const range = (start, end) => {
    assert(start >= bios.base && end > start && end <= bios.base + 1024);
    return {
      start,
      end,
      bytes: bios.bytes.slice(start - bios.base, end - bios.base),
    };
  };
  const immutable = [
    range(bios.base, bios.labels.BOOTREC),
    range(bios.labels.DPBLOCK, bios.labels.DIRBUF),
  ];
  if (bios.labels.COMMONND < bios.labels.DPHEADS)
    immutable.push(range(bios.labels.COMMONND, bios.labels.DPHEADS));
  for (let drive = 0; drive < count; drive++) {
    // BDOS writes the first eight DPH bytes as scratch. Only its four pointer
    // words are immutable; guarding the entire DPH would reject valid CP/M.
    const start = bios.labels.DPHEADS + drive * 16;
    immutable.push(range(start + 8, start + 16));
  }
  if (bios.labels.DPHEND < bios.base + 1024)
    immutable.push(range(bios.labels.DPHEND, bios.base + 1024));
  const components = distribution.manifest.components
    .filter(({ id }) => ["atom", "nucleus", "edit"].includes(id))
    .map((component) => {
      assert(component.bytes > 0 && component.bytes <= ccp.base - 256);
      return {
        name: component.install.name,
        bytes: component.bytes,
        sha256: component.sha256,
      };
    });
  assert.deepEqual(
    components.map(({ name }) => name),
    ["ATOM.COM", "NUC.COM", "EDIT.COM"],
  );
  return {
    bytes: built.system,
    bootstrap: built.bootstrap,
    components,
    profile: descriptor,
    resident: {
      ccpBase: ccp.base,
      ccpBytes: ccp.bytes,
      ccpStackTop: ccp.labels.STKTOP,
      ccpWritableStart: ccp.labels.CMDFCB,
      ccpStackGuardStart: ccp.labels.STKGUARD,
      ccpStackGuardEnd: ccp.labels.STKGUEND,
      bdosBase: bdos.base,
      bdosBytes: bdos.bytes,
      bdosWritableStart: bdos.labels.OLDSP,
      bdosStackBase: bdos.labels.STKBASE,
      bdosStackTop: bdos.labels.STKTOP,
      biosBase: bios.base,
      biosImmutableRanges: immutable,
      allocationGuards: Array.from(
        { length: count },
        (_, drive) => descriptor.layout.allocationBase + drive * 128 + 127,
      ),
      unusedAllocationStart: descriptor.layout.allocationBase + count * 128,
    },
  };
}
