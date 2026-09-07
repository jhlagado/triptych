import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, it } from "vitest";
import {
  assemblePreparedTwoMibProfile,
  assembleTwoMibProfile,
  prepareTwoMibSources,
  prepareTwoMibSourcesFromBodies,
} from "../../tools/lib/cpm-two-mib-profile.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const temporaries = [];
afterEach(async () => {
  for (const path of temporaries.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function bodies() {
  const [bios, bootstrap] = await Promise.all([
    readFile(join(repositoryRoot, "system/cpm/bios-2m.asm")),
    readFile(join(repositoryRoot, "roms/cpu/bootstrap-2m.asm")),
  ]);
  return { bios, bootstrap };
}

async function alternateRoot() {
  const root = await mkdtemp(join(tmpdir(), "triptych-source-root-"));
  temporaries.push(root);
  const original = await bodies();
  // Changes to fixture padding distinguish the actual assembly input without
  // changing origins, routines, tables or executable behavior. No tracked
  // assembly source is edited by these tests.
  const bios = original.bios
    .toString("utf8")
    .replace("BIOSBASE+$300-$,0", "BIOSBASE+$300-$,$5A");
  const bootstrap = original.bootstrap
    .toString("utf8")
    .replace("$0100-$,0", "$0100-$,$A7");
  for (const [relative, source] of [
    ["system/cpm/bios-2m.asm", bios],
    ["roms/cpu/bootstrap-2m.asm", bootstrap],
  ]) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
  }
  return root;
}

describe("captured two-MiB machine sources", () => {
  it("honors an explicit alternate repository root and records exact raw/prepared provenance", async () => {
    const root = await alternateRoot();
    const prepared = await prepareTwoMibSources(2, { repositoryRoot: root });
    assert.equal(prepared.repositoryRoot, root);
    for (const [key, source] of [
      ["bios", prepared.biosSource],
      ["bootstrap", prepared.bootstrapSource],
    ]) {
      const raw = await readFile(prepared.sourcePaths[key]);
      assert.deepEqual(prepared.rawSources[key], raw);
      assert.deepEqual(prepared.sourceProvenance[key], {
        path: prepared.sourcePaths[key],
        rawByteLength: raw.byteLength,
        rawSha256: hash(raw),
        preparedByteLength: Buffer.byteLength(source, "utf8"),
        preparedSha256: hash(Buffer.from(source, "utf8")),
      });
      assert(prepared.sourcePaths[key].startsWith(root + "/"));
    }
    const assembled = await assembleTwoMibProfile(2, { repositoryRoot: root });
    assert.deepEqual(
      assembled.bios.bytes.slice(723, 768),
      new Uint8Array(45).fill(0x5a),
    );
    assert.deepEqual(
      assembled.bootstrap.bytes.slice(124),
      new Uint8Array(132).fill(0xa7),
    );
  });

  it("uses captured strings and bytes after files are removed and caller buffers change during assembly", async () => {
    const root = await alternateRoot();
    const prepared = await prepareTwoMibSources(16, { repositoryRoot: root });
    const expectedRaw = {
      bios: Buffer.from(prepared.rawSources.bios),
      bootstrap: Buffer.from(prepared.rawSources.bootstrap),
    };
    const expectedSources = [prepared.biosSource, prepared.bootstrapSource];
    // Remove the complete source location before assembly begins. A hidden
    // reread or module-relative fallback cannot pass the padding observations.
    await rm(root, { recursive: true });
    const pending = assemblePreparedTwoMibProfile(prepared);
    prepared.rawSources.bios.fill(0);
    prepared.rawSources.bootstrap.fill(0);
    const assembled = await pending;
    assert.deepEqual(assembled.rawSources, expectedRaw);
    assert.deepEqual(
      [assembled.biosSource, assembled.bootstrapSource],
      expectedSources,
    );
    assert.deepEqual(assembled.sourceProvenance, prepared.sourceProvenance);
    assert.deepEqual(
      assembled.bios.bytes.slice(723, 768),
      new Uint8Array(45).fill(0x5a),
    );
    assert.deepEqual(
      assembled.bootstrap.bytes.slice(124),
      new Uint8Array(132).fill(0xa7),
    );
    assert.equal(
      assembled.bios.labels.DPHEND,
      assembled.profile.dphBase + 16 * 16,
    );
  });

  it("pure preparation copies offset byte views and hashes raw bytes rather than decoded text", async () => {
    const original = await bodies();
    const raw = Buffer.concat([
      Buffer.from([0x99, 0x88]),
      original.bios,
      Buffer.from("\r\n; raw byte: "),
      Buffer.from([0xff]),
      Buffer.from([0x77]),
    ]);
    const view = new Uint8Array(
      raw.buffer,
      raw.byteOffset + 2,
      raw.byteLength - 3,
    );
    const expected = Buffer.from(view);
    const prepared = prepareTwoMibSourcesFromBodies(
      4,
      { bios: view, bootstrap: original.bootstrap },
      { repositoryRoot: "/nonexistent-captured-source-root" },
    );
    raw.fill(0);
    original.bootstrap.fill(0);
    assert.deepEqual(prepared.rawSources.bios, expected);
    assert.equal(prepared.sourceProvenance.bios.rawSha256, hash(expected));
    assert.notEqual(
      prepared.sourceProvenance.bios.rawSha256,
      hash(expected.toString("utf8")),
    );
    assert(prepared.biosSource.includes("\r\n; raw byte: �"));
    assert.equal(
      prepared.sourceProvenance.bios.preparedSha256,
      hash(prepared.biosSource),
    );
  });

  it("rejects shared backing buffers instead of racing their source capture", async () => {
    const original = await bodies();
    const shared = new Uint8Array(new SharedArrayBuffer(8));
    const foreignShared = runInNewContext("new SharedArrayBuffer(8)");
    for (const sharedBody of [
      shared,
      Buffer.from(shared.buffer),
      Buffer.from(foreignShared),
    ])
      assert.throws(
        () =>
          prepareTwoMibSourcesFromBodies(2, {
            bios: sharedBody,
            bootstrap: original.bootstrap,
          }),
        /unshared Uint8Array/,
      );
  });

  it("rejects altered prepared text, provenance, profile or raw bytes before assembly", async () => {
    const prepared = prepareTwoMibSourcesFromBodies(2, await bodies());
    const changed = Buffer.from(prepared.rawSources.bios);
    changed[0] ^= 1;
    for (const value of [
      { ...prepared, biosSource: prepared.biosSource + "\n; altered" },
      {
        ...prepared,
        bootstrapSource: prepared.bootstrapSource + "\n; altered",
      },
      { ...prepared, profile: { ...prepared.profile, bios: 0 } },
      {
        ...prepared,
        sourcePaths: { ...prepared.sourcePaths, bios: "/another/source.asm" },
      },
      {
        ...prepared,
        sourceProvenance: {
          ...prepared.sourceProvenance,
          bios: {
            ...prepared.sourceProvenance.bios,
            rawSha256: "0".repeat(64),
          },
        },
      },
      { ...prepared, rawSources: { ...prepared.rawSources, bios: changed } },
    ])
      await assert.rejects(
        assemblePreparedTwoMibProfile(value),
        /captured .* disagrees/,
      );
  });

  it("preserves default assembled bytes for every configured count", async () => {
    // Baseline captured before this change from 569d51d with pinned ATOM.
    const biosHashes = [
      "61bc336b1594052b90479df85dd516289b1f2063d823682fabcbe63517fabc4c",
      "6fe9ccac3936925c4747809e8b2e6052189661c2790a6c61e75bd8925c37b587",
      "93f476c7f37c2e1d341c03bb05347d1b1622c0ec6dd706cf1aaef5286d9cfab6",
      "138e57de21314591b9366d3158b684f253513ffa301e403cda18335be5d15de8",
      "da061472af08568bdd356e623394ff2182d36b710f7719246f920335982389aa",
      "9d3d6697d9d4357ecb273b6992e72a8a135481e0fe9e06b751d5321548cf57e6",
      "83961fb8f8f5038427ab5c67a29172e00babf0380e6a96fd00fee11d5a6131fa",
      "d2300e9085df750904a321244916facd9a9cc0a2b0dfd5c765bd677fed0c4f93",
      "6f211dbfed4be2382914f006051fe2f61895773bbdb43f30357f8f91dc355ed2",
      "0d5b116cee58bceb0a161c08907c0c5126552e4a89e878bcb329954db16c140a",
      "218320bd1200e9fab4c372e800c0e075d5f1759af2496455be249ebd1c1293b7",
      "283286857d6d4b93d4737949f20e3df2b8da04a0870044255db850854e5cc9a9",
      "9ccca157af9cc37934f9d10ee3db8cb774b148d64c6cca6e03202eebcd7a78ec",
      "89d704e561ef1fbd648727894dac7d58ea7a8ddeed98f98b01cd7808fbfa9953",
      "e481df5bfdac8ae339e0eb8233f8710e7b509123ec0dcbb1cdac2cf856b180bb",
      "e416f31bef20f80804c1cc7ae7d1495d010baf7099563beb7fe615101187b2fc",
    ];
    const bootstrapHashes = [
      "8e9805ce6c476fc44b226effeefd49bcdcee797f455565802c17ed70fadab3a3",
      "54c6bfd356b4b42f8c51f3b85777a9d2be7aa680945335783c4dd7a6dae8921e",
      "6ca90515ea8d0824291a26dce3d57a8854cdada6eec8e6aa29d35f3ea0c3c587",
      "57bfde136e8e892a17f638fb096519efbe903471cc616d35f8c77636071f0280",
      "f2c29591532a3d948740b3bcd68c53229b8628df4193cc7618c6086c367ee2e0",
      "d271facda752823ea59ef80b02a325cfc52a065c24b21a33be4d401e02ee79b2",
      "a2ba906229e8d2a3d1987384b5b556669c8455b2a01c20b04ec2131c1b020bda",
      "37e592913e76b3dc36972f3791326e6fbe08c4442dece3d98b584bbfe68dd379",
    ];
    for (let count = 1; count <= 16; count++) {
      const built = await assembleTwoMibProfile(count);
      assert.equal(
        hash(built.bios.bytes),
        biosHashes[count - 1],
        `BIOS n${count}`,
      );
      assert.equal(
        hash(built.bootstrap.bytes),
        bootstrapHashes[Math.floor((count - 1) / 2)],
        `bootstrap n${count}`,
      );
    }
  }, 30_000);
});
