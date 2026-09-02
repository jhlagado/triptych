import assert from "node:assert/strict";

const RECORD_BYTES = 128;
const SYSTEM_RECORDS = 52;
const DIRECTORY_ENTRIES = 64;
const DIRECTORY_ENTRY_BYTES = 32;
const RECORDS_PER_BLOCK = 8;
const RESERVED_BLOCKS = 2;
const MAXIMUM_BLOCK = 242;
const RECORDS_PER_EXTENT = 128;
const BLOCKS_PER_EXTENT = 16;
const DIRECTORY_OFFSET = SYSTEM_RECORDS * RECORD_BYTES;

function canonicalName(name) {
  assert.equal(typeof name, "string", "CP/M filename must be text");
  const match =
    /^([A-Za-z0-9_$#@!%&'()\-^{}~]{1,8})(?:\.([A-Za-z0-9_$#@!%&'()\-^{}~]{1,3}))?$/.exec(
      name,
    );
  assert.ok(match, `invalid CP/M 8.3 filename ${JSON.stringify(name)}`);
  return Uint8Array.from(
    Buffer.from(
      `${match[1].toUpperCase().padEnd(8, " ")}${(match[2] ?? "").toUpperCase().padEnd(3, " ")}`,
      "ascii",
    ),
  );
}

function entryOffset(index) {
  return DIRECTORY_OFFSET + index * DIRECTORY_ENTRY_BYTES;
}

function sameName(entry, wanted) {
  for (let index = 0; index < wanted.length; index += 1) {
    if ((entry[index + 1] & 0x7f) !== wanted[index]) return false;
  }
  return true;
}

function validateImage(image) {
  assert.ok(image instanceof Uint8Array, "CP/M disk must be a byte array");
  const requiredBytes =
    (SYSTEM_RECORDS + (MAXIMUM_BLOCK + 1) * RECORDS_PER_BLOCK) * RECORD_BYTES;
  assert.ok(
    image.length >= requiredBytes,
    `CP/M disk has ${image.length} bytes; expected at least ${requiredBytes}`,
  );
}

function dataBlockOffset(block) {
  return (SYSTEM_RECORDS + block * RECORDS_PER_BLOCK) * RECORD_BYTES;
}

function directoryEntry(image, index) {
  const offset = entryOffset(index);
  return image.subarray(offset, offset + DIRECTORY_ENTRY_BYTES);
}

function extentNumber(entry) {
  return ((entry[14] & 0x3f) << 5) | (entry[12] & 0x1f);
}

/** Install or replace one user-zero file in a private IBM-3740 CP/M image. */
export function installCpm22File(image, { name, bytes, padByte = 0x1a }) {
  validateImage(image);
  assert.ok(bytes instanceof Uint8Array, `${name} contents must be bytes`);
  assert.ok(
    Number.isInteger(padByte) && padByte >= 0 && padByte <= 0xff,
    `${name} pad byte must be one byte`,
  );
  const wanted = canonicalName(name);
  const disk = Uint8Array.from(image);
  const reusableEntries = [];
  const usedBlocks = new Set();

  for (let index = 0; index < DIRECTORY_ENTRIES; index += 1) {
    const entry = directoryEntry(disk, index);
    const matching = entry[0] === 0 && sameName(entry, wanted);
    if (entry[0] === 0xe5 || matching) {
      if (matching) entry.fill(0xe5);
      reusableEntries.push(index);
      continue;
    }
    if (entry[0] > 0x0f) continue;
    for (const block of entry.subarray(16, 32)) {
      if (block !== 0) usedBlocks.add(block);
    }
  }

  const recordCount = Math.ceil(bytes.length / RECORD_BYTES);
  const extentCount = Math.max(1, Math.ceil(recordCount / RECORDS_PER_EXTENT));
  assert.ok(extentCount <= 64, `${name} exceeds the supported CP/M file size`);
  assert.ok(
    reusableEntries.length >= extentCount,
    `${name} needs ${extentCount} directory entries; only ${reusableEntries.length} are free`,
  );
  const freeBlocks = [];
  for (let block = RESERVED_BLOCKS; block <= MAXIMUM_BLOCK; block += 1) {
    if (!usedBlocks.has(block)) freeBlocks.push(block);
  }
  const requiredBlocks = Math.ceil(recordCount / RECORDS_PER_BLOCK);
  assert.ok(
    freeBlocks.length >= requiredBlocks,
    `${name} needs ${requiredBlocks} blocks; only ${freeBlocks.length} are free`,
  );

  const physical = new Uint8Array(recordCount * RECORD_BYTES).fill(padByte);
  physical.set(bytes);
  let sourceOffset = 0;
  let blockCursor = 0;
  for (let extent = 0; extent < extentCount; extent += 1) {
    const records = Math.min(
      RECORDS_PER_EXTENT,
      Math.max(0, recordCount - extent * RECORDS_PER_EXTENT),
    );
    const blocks = Math.ceil(records / RECORDS_PER_BLOCK);
    const entry = directoryEntry(disk, reusableEntries[extent]);
    entry.fill(0);
    entry[0] = 0;
    entry.set(wanted, 1);
    entry[12] = extent & 0x1f;
    entry[14] = (extent >>> 5) & 0x3f;
    entry[15] = records;
    for (let index = 0; index < blocks; index += 1) {
      const block = freeBlocks[blockCursor];
      blockCursor += 1;
      entry[16 + index] = block;
      const count = Math.min(
        RECORDS_PER_BLOCK * RECORD_BYTES,
        physical.length - sourceOffset,
      );
      disk
        .subarray(dataBlockOffset(block), dataBlockOffset(block) + count)
        .set(physical.subarray(sourceOffset, sourceOffset + count));
      sourceOffset += count;
    }
  }
  return disk;
}

/** Read the exact physical records belonging to one user-zero CP/M file. */
export function readCpm22File(image, name) {
  validateImage(image);
  const wanted = canonicalName(name);
  const extents = [];
  for (let index = 0; index < DIRECTORY_ENTRIES; index += 1) {
    const entry = directoryEntry(image, index);
    if (entry[0] === 0 && sameName(entry, wanted)) {
      extents.push({ entry, extent: extentNumber(entry) });
    }
  }
  assert.ok(extents.length > 0, `${name} is absent from the CP/M image`);
  extents.sort((left, right) => left.extent - right.extent);
  const chunks = [];
  let expectedExtent = 0;
  for (const { entry, extent } of extents) {
    assert.equal(
      extent,
      expectedExtent,
      `${name} has a missing or duplicate extent`,
    );
    expectedExtent += 1;
    let records = entry[15];
    const blocks = Math.ceil(records / RECORDS_PER_BLOCK);
    for (let index = 0; index < blocks; index += 1) {
      const block = entry[16 + index];
      assert.ok(
        block >= RESERVED_BLOCKS && block <= MAXIMUM_BLOCK,
        `${name} extent ${extent} has an invalid allocation block`,
      );
      const count = Math.min(RECORDS_PER_BLOCK, records) * RECORD_BYTES;
      chunks.push(
        image.slice(dataBlockOffset(block), dataBlockOffset(block) + count),
      );
      records -= count / RECORD_BYTES;
    }
    assert.equal(
      records,
      0,
      `${name} extent ${extent} is missing allocation blocks`,
    );
  }
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const file = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    file.set(chunk, offset);
    offset += chunk.length;
  }
  return file;
}
