import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const SOURCE_BYTES = 15_029;
const SOURCE_SHA256 =
  "cdd5d05e3131b23288914b354929cfb5c2e1639d71c35f337e8fcec8c2bdfcbb";
const OUTPUT_BUFFER = 0x9000;
const OUTPUT_BUFFER_BYTES = 0x4780;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function patchWord(image, signature, wordOffset, value, label) {
  const matches = [];
  for (let offset = 0; offset <= image.length - signature.length; offset += 1) {
    if (signature.every((byte, index) => image[offset + index] === byte)) {
      matches.push(offset);
    }
  }
  assert.equal(matches.length, 1, `${label} signature count`);
  image[matches[0] + wordOffset] = value & 0xff;
  image[matches[0] + wordOffset + 1] = value >>> 8;
}

/**
 * Derive a private CP/M Atom whose flat output range starts somewhere other
 * than $0100. The source is the provenance-pinned ATOM.COM artifact already
 * carried by the transitional disk. Only the two-word target descriptor and
 * four adapter immediates derived from it are changed; the Atom core is
 * untouched.
 */
export function retargetCpm22Atom(source, { start, capacity }) {
  assert.ok(source instanceof Uint8Array, "ATOM.COM must be bytes");
  assert.ok(
    Number.isInteger(start) && start >= 0 && start <= 0xffff,
    "Atom target start must be a word",
  );
  assert.ok(
    Number.isInteger(capacity) &&
      capacity > 0 &&
      capacity <= OUTPUT_BUFFER_BYTES,
    `Atom target capacity must be 1..${OUTPUT_BUFFER_BYTES}`,
  );
  assert.ok(start + capacity <= 0x10000, "Atom target range must not wrap");
  const image = source.slice(0, SOURCE_BYTES);
  assert.equal(image.length, SOURCE_BYTES, "ATOM.COM logical byte length");
  assert.equal(sha256(image), SOURCE_SHA256, "ATOM.COM source provenance");

  const outputDelta = (OUTPUT_BUFFER - start) & 0xffff;
  patchWord(image, [0x11, 0x00, 0x8f, 0x19], 1, outputDelta, "byte sink");
  patchWord(image, [0x01, 0x00, 0x8f, 0x09], 1, outputDelta, "word sink");
  patchWord(
    image,
    [0x11, 0x00, 0x01, 0xb7, 0xed, 0x52],
    1,
    start,
    "commit base",
  );
  patchWord(image, [0x21, 0x00, 0x01, 0x22], 1, start, "HEX base");
  const descriptor = [
    0x01, 0xf5, 0x4a, 0x00, 0x50, 0x00, 0x80, 0x00, 0x80, 0x00, 0x90, 0x00,
    0x01, 0x80, 0x47,
  ];
  patchWord(image, descriptor, 11, start, "target descriptor start");
  const descriptorCapacitySignature = [...descriptor];
  descriptorCapacitySignature[11] = start & 0xff;
  descriptorCapacitySignature[12] = start >>> 8;
  patchWord(
    image,
    descriptorCapacitySignature,
    13,
    capacity,
    "target descriptor capacity",
  );
  return image;
}

export const CPM22_ATOM_PROVENANCE = Object.freeze({
  bytes: SOURCE_BYTES,
  sha256: SOURCE_SHA256,
});
