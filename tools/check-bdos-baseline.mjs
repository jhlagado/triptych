import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { assembleTriptychCpuFirmware } from "./cpm22-native-image.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixturePath = join(
  repositoryRoot,
  "test",
  "bdos",
  "fixtures",
  "reference-system.json",
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
assert.equal(fixture.schema, "triptych-bdos-reference-system-v1");

const imagePath = join(repositoryRoot, fixture.image.path);
const [image, firmware] = await Promise.all([
  readFile(imagePath),
  assembleTriptychCpuFirmware(repositoryRoot),
]);

assert.equal(image.length, fixture.image.bytes, "reference image byte length");
assert.equal(sha256(image), fixture.image.sha256, "reference image SHA-256");

const components = new Map();
for (const component of fixture.layout.components) {
  assert.equal(
    component.diskOffset,
    component.loadAddress - fixture.layout.systemLoadAddress,
    `${component.name} disk offset follows the load map`,
  );
  const bytes = image.subarray(
    component.diskOffset,
    component.diskOffset + component.bytes,
  );
  assert.equal(bytes.length, component.bytes, `${component.name} byte length`);
  assert.equal(sha256(bytes), component.sha256, `${component.name} SHA-256`);
  components.set(component.name, { metadata: component, bytes });
}

const ccp = components.get("ccp");
const bdos = components.get("bdos");
const embeddedBios = components.get("embedded-bios");
assert.ok(
  ccp && bdos && embeddedBios,
  "CCP, BDOS, and embedded BIOS components are present",
);
assert.equal(
  ccp.metadata.loadAddress + ccp.metadata.bytes,
  bdos.metadata.loadAddress,
  "CCP ends at BDOS base",
);
assert.equal(
  bdos.metadata.loadAddress + bdos.metadata.bytes,
  embeddedBios.metadata.loadAddress,
  "BDOS ends at the embedded BIOS base",
);

const bdosEntryOffset = bdos.metadata.publicEntry - bdos.metadata.loadAddress;
assert.equal(bdos.bytes[bdosEntryOffset], 0xc3, "BDOS entry is an absolute JP");
const bdosEntryTarget =
  bdos.bytes[bdosEntryOffset + 1] | (bdos.bytes[bdosEntryOffset + 2] << 8);
assert.ok(
  bdosEntryTarget >= bdos.metadata.loadAddress &&
    bdosEntryTarget < bdos.metadata.loadAddress + bdos.metadata.bytes,
  "BDOS public entry jumps inside the resident BDOS slot",
);

for (let entry = 0; entry < embeddedBios.metadata.jumpEntries; entry += 1) {
  assert.equal(
    embeddedBios.bytes[entry * 3],
    0xc3,
    `embedded BIOS jump-table entry ${entry} is an absolute JP`,
  );
}

assert.equal(firmware.bios.length, embeddedBios.metadata.bytes);
for (let entry = 0; entry < embeddedBios.metadata.jumpEntries; entry += 1) {
  assert.equal(
    firmware.bios[entry * 3],
    0xc3,
    `Triptych BIOS jump-table entry ${entry} is an absolute JP`,
  );
}

console.log(
  JSON.stringify(
    {
      status: "passed",
      fixture: fixture.schema,
      imageSha256: fixture.image.sha256,
      components: Object.fromEntries(
        [...components].map(([name, value]) => [
          name,
          {
            loadAddress: `0x${value.metadata.loadAddress.toString(16)}`,
            bytes: value.metadata.bytes,
            sha256: value.metadata.sha256,
          },
        ]),
      ),
      bdosPublicEntry: `0x${bdos.metadata.publicEntry.toString(16)}`,
      bdosEntryTarget: `0x${bdosEntryTarget.toString(16)}`,
      triptychBios: {
        bytes: firmware.bios.length,
        sha256: sha256(firmware.bios),
        jumpEntries: embeddedBios.metadata.jumpEntries,
      },
    },
    undefined,
    2,
  ),
);
