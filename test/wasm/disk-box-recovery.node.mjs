import assert from "node:assert/strict";
import { webcrypto as crypto } from "node:crypto";
import test from "node:test";
import {
  encodeDiskBoxRecovery as encode,
  decodeDiskBoxRecovery as decode,
} from "../../crates/triptych-host-wasm/web/disk-box-recovery.js";

test("binary recovery retains full raw graphs without decimal image expansion", async () => {
  const one = new Uint8Array(2097152).fill(173),
    two = new Uint8Array(2097152).fill(29);
  const records = {
    historical: [{ key: "blob", value: one }],
    diskBox: [{ hash: "deliberately wrong source hash", bytes: two }],
    unknown: [],
  };
  records.shared = one;
  records.self = records;
  records.special = [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    -0,
    new ArrayBuffer(3),
  ];
  records.sparse = new Array(7);
  records.sparse[3] = "yes";
  Object.defineProperty(records, "__proto__", {
    value: "opaque",
    enumerable: true,
  });
  records.constructor = "also opaque";
  const archive = await encode(records, { crypto });
  assert(archive.size > 4194304 && archive.size < 4200000);
  const restored = await decode(archive, { crypto });
  assert.deepEqual(restored, records);
  assert.equal(restored.self, restored);
  assert.equal(restored.shared, restored.historical[0].value);
  assert.equal(Object.getPrototypeOf(restored), Object.prototype);
});

test("captures Buffer bytes and metadata before the first hash await", async () => {
  const bytes = Buffer.from([1, 2, 3]);
  const records = { bytes, metadata: { name: "before" } };
  let calls = 0;
  const changingCrypto = {
    subtle: {
      digest: async (...args) => {
        if (calls++ === 0) {
          bytes.fill(9);
          records.metadata.name = "after";
          records.extra = "late";
        }
        return crypto.subtle.digest(...args);
      },
    },
  };
  assert.deepEqual(
    await decode(await encode(records, { crypto: changingCrypto }), { crypto }),
    { bytes: Uint8Array.of(1, 2, 3), metadata: { name: "before" } },
  );
});

test("rejects truncation, trailing bytes and both checksum failures", async () => {
  const archive = await encode({ bytes: Uint8Array.of(1, 2, 3) }, { crypto });
  const body = new Uint8Array(await archive.arrayBuffer());
  await assert.rejects(decode(archive.slice(0, 20), { crypto }), /size/);
  await assert.rejects(decode(archive.slice(0, -1), { crypto }), /bounds/);
  await assert.rejects(
    decode(new Blob([archive, Uint8Array.of(0)]), { crypto }),
    /trailing/,
  );
  const metadata = body.slice();
  metadata[44] ^= 1;
  await assert.rejects(
    decode(new Blob([metadata]), { crypto }),
    /metadata checksum/,
  );
  body[body.length - 1] ^= 1;
  await assert.rejects(
    decode(new Blob([body]), { crypto }),
    /segment checksum/,
  );
});

async function malformed(text) {
  const bytes = new TextEncoder().encode(text),
    header = new Uint8Array(44);
  header.set(new TextEncoder().encode("TDBR0001"));
  new DataView(header.buffer).setUint32(8, bytes.length, true);
  header.set(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), 12);
  return new Blob([header, bytes]);
}
test("rejects duplicate fields and malformed graph metadata", async () => {
  for (const text of [
    '{"schema":0,"schema":0}',
    JSON.stringify({
      schema: "triptych-disk-box-recovery-v1",
      root: ["ref", 2],
      nodes: [],
      segments: [],
    }),
    JSON.stringify({
      schema: "triptych-disk-box-recovery-v1",
      root: ["ref", 0],
      nodes: [{ type: "object", props: null }],
      segments: [],
    }),
    JSON.stringify({
      schema: "triptych-disk-box-recovery-v1",
      root: ["ref", 0],
      nodes: [
        {
          type: "object",
          props: [
            ["x", ["undefined"]],
            ["x", ["undefined"]],
          ],
        },
      ],
      segments: [],
    }),
  ])
    await assert.rejects(
      decode(await malformed(text), { crypto }),
      /Disk-box recovery/,
    );
});

test("unsupported values and accessors fail explicitly without invoking getters", async () => {
  for (const value of [
    new Date(),
    new Map(),
    1n,
    () => {},
    Symbol("x"),
    new Uint16Array(2),
  ])
    await assert.rejects(encode(value, { crypto }), /unsupported/);
  let read = false;
  const value = {
    get bad() {
      read = true;
      return 1;
    },
  };
  await assert.rejects(encode(value, { crypto }), /accessor/);
  assert.equal(read, false);
  const bytes = new Uint8Array(1);
  Object.defineProperty(bytes, "byteLength", {
    get() {
      read = true;
      return 1;
    },
  });
  // Byte containers follow IndexedDB structured-clone semantics: auxiliary
  // JavaScript properties are excluded, never inspected or invoked.
  assert.deepEqual(
    await decode(await encode(bytes, { crypto }), { crypto }),
    new Uint8Array(1),
  );
  assert.equal(read, false);
});

test("8 MiB structured-clone binary capture never enumerates byte indices", async () => {
  const bytes = new Uint8Array(8388608).fill(173);
  bytes.extra = "not part of an IndexedDB byte container";
  const original = Reflect.ownKeys;
  let binaryEnumerations = 0,
    recordEnumerations = 0;
  Reflect.ownKeys = (value) => {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      binaryEnumerations++;
      throw new Error("binary index enumeration");
    }
    recordEnumerations++;
    return original(value);
  };
  try {
    const archive = await encode({ bytes, same: bytes }, { crypto });
    const restored = await decode(archive, { crypto });
    assert.equal(restored.bytes, restored.same);
    assert.deepEqual(restored.bytes, new Uint8Array(8388608).fill(173));
    assert.equal(restored.bytes.extra, undefined);
    assert.equal(binaryEnumerations, 0);
    assert(recordEnumerations > 0);
  } finally {
    Reflect.ownKeys = original;
  }
});

test("rejects oversized metadata before hashing and hostile header lengths before reading metadata", async () => {
  let hashed = false;
  await assert.rejects(
    encode("x".repeat(3 * 1024 * 1024), {
      crypto: {
        subtle: {
          digest() {
            hashed = true;
            throw new Error("unexpected hash");
          },
        },
      },
    }),
    /encoding budget/,
  );
  assert.equal(hashed, false);
  const header = new Uint8Array(44);
  header.set(new TextEncoder().encode("TDBR0001"));
  new DataView(header.buffer).setUint32(8, 0xffffffff, true);
  await assert.rejects(
    decode(new Blob([header]), { crypto }),
    /metadata length/,
  );
});
