import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readCpm22File } from "./cpm22-disk.mjs";
import { validateToolCatalog } from "../../crates/triptych-host-wasm/web/tool-catalog.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const IDS = ["atom", "nucleus", "edit"];

/**
 * Extract only the pinned tools from a freshly built private distribution.
 * Asset bytes include exact CP/M record padding, making installed identity
 * measurable without guessing the original length from a directory entry.
 * Caller publishes the returned catalog and flat-named assets together.
 */
export function buildBrowserToolCatalog(manifest, disk) {
  assert.ok(disk instanceof Uint8Array, "distribution disk must be bytes");
  assert.equal(disk.length, manifest.disk.bytes, "distribution disk length");
  assert.equal(hash(disk), manifest.disk.sha256, "distribution disk digest");
  const assets = new Map();
  const tools = IDS.map((id) => {
    const matches = manifest.components.filter(
      (component) => component.id === id,
    );
    assert.equal(matches.length, 1, `one ${id} component is required`);
    const component = matches[0];
    assert.equal(component.install.kind, "file", `${id} installation`);
    const bytes = readCpm22File(disk, component.install.name);
    assert.equal(
      bytes.length,
      Math.ceil(component.bytes / 128) * 128,
      `${id} record length`,
    );
    assert.equal(
      hash(bytes.subarray(0, component.bytes)),
      component.sha256,
      `${id} raw digest`,
    );
    assert.ok(
      bytes
        .subarray(component.bytes)
        .every((byte) => byte === component.install.padByte),
      `${id} record padding`,
    );
    const padded = { bytes: bytes.length, sha256: hash(bytes) };
    const asset = `tool-${id}-${padded.sha256}.com`;
    assets.set(asset, bytes);
    return {
      id,
      name: component.install.name,
      source: component.source,
      target: component.target,
      raw: { bytes: component.bytes, sha256: component.sha256 },
      padded,
      padByte: component.install.padByte,
      asset,
    };
  });
  const catalog = validateToolCatalog(
    {
      schema: "triptych-browser-tools-v1",
      targetProfile: manifest.targetProfile,
      distribution: {
        revision: manifest.triptych.revision,
        lockSha256: manifest.lockSha256,
        diskSha256: manifest.disk.sha256,
      },
      tools,
    },
    manifest,
  );
  return { catalog, assets };
}
