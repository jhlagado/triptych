// Lossless raw-record transport. Source record hashes are deliberately opaque.
// Current transport limit is 1 GiB, not a promise that unbounded history fits.
// Binary inputs are IndexedDB structured-clone byte containers: only bytes and
// shared container identity are represented. Auxiliary JavaScript properties
// on Uint8Array/ArrayBuffer are excluded, as in IndexedDB, and never inspected.
const MAGIC = new TextEncoder().encode("TDBR0001");
const HEADER = 44,
  MAX_META = 16 * 1024 * 1024,
  MAX_BYTES = 1024 * 1024 * 1024;
const MAX_NODES = 65536;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsic = (prototype, key, value) =>
  Reflect.apply(Object.getOwnPropertyDescriptor(prototype, key).get, value, []);
const fail = (message) => {
  throw new Error(`Disk-box recovery: ${message}`);
};
const check = (condition, message) => {
  if (!condition) fail(message);
};
const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const digest = async (bytes, crypto) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const keys = (value, expected) =>
  check(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify(expected.split(",").sort()),
    "invalid metadata fields",
  );

/** Snapshot before the first await; supports plain graphs and owned binary data. */
export async function encodeDiskBoxRecovery(
  stores,
  { crypto = globalThis.crypto } = {},
) {
  const nodes = [],
    segments = [],
    seen = new Map();
  let total = HEADER;
  // Conservative JSON upper bound, checked before serialization allocates it.
  let metadataBudget = 512;
  const budget = (characters = 0) => {
    metadataBudget += 256 + characters * 6;
    check(metadataBudget <= MAX_META, "metadata exceeds encoding budget");
  };
  const capture = (value, depth = 0) => {
    check(depth <= 512, "graph nesting exceeds 512 levels");
    budget(typeof value === "string" ? value.length : 0);
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return ["value", value];
    if (typeof value === "undefined") return ["undefined"];
    if (typeof value === "number")
      return ["number", Object.is(value, -0) ? "-0" : String(value)];
    check(typeof value === "object", `unsupported ${typeof value} value`);
    if (seen.has(value)) return ["ref", seen.get(value)];
    check(nodes.length < MAX_NODES, "too many records");
    const id = nodes.length;
    seen.set(value, id);
    nodes.push(null);
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      const isView = value instanceof Uint8Array;
      const byteLength = intrinsic(
        isView ? typedPrototype : ArrayBuffer.prototype,
        "byteLength",
        value,
      );
      check(total + byteLength <= MAX_BYTES, "archive too large");
      const bytes = isView
        ? new Uint8Array(
            intrinsic(typedPrototype, "buffer", value),
            intrinsic(typedPrototype, "byteOffset", value),
            byteLength,
          ).slice()
        : new Uint8Array(value).slice();
      total += bytes.length;
      check(total <= MAX_BYTES, "archive too large");
      nodes[id] = {
        type: isView ? "bytes" : "buffer",
        segment: segments.length,
      };
      segments.push(bytes);
    } else {
      const array = Array.isArray(value),
        proto = Object.getPrototypeOf(value);
      check(
        array || proto === Object.prototype || proto === null,
        "unsupported object type",
      );
      const props = [];
      for (const key of Reflect.ownKeys(value)) {
        if (array && key === "length") continue;
        check(typeof key === "string", "unsupported symbol property");
        budget(key.length);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        check(
          "value" in descriptor && descriptor.enumerable,
          "unsupported accessor or hidden property",
        );
        props.push([key, capture(descriptor.value, depth + 1)]);
      }
      nodes[id] = array
        ? { type: "array", length: value.length, props }
        : { type: proto === null ? "null-object" : "object", props };
    }
    return ["ref", id];
  };
  const root = capture(stores);
  const descriptors = [];
  for (const bytes of segments)
    descriptors.push({
      byteLength: bytes.length,
      sha256: hex(await digest(bytes, crypto)),
    });
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      schema: "triptych-disk-box-recovery-v1",
      root,
      nodes,
      segments: descriptors,
    }),
  );
  check(
    metadata.length <= MAX_META && total + metadata.length <= MAX_BYTES,
    "archive too large",
  );
  const header = new Uint8Array(HEADER);
  header.set(MAGIC);
  new DataView(header.buffer).setUint32(8, metadata.length, true);
  header.set(await digest(metadata, crypto), 12);
  return new Blob([header, metadata, ...segments], {
    type: "application/octet-stream",
  });
}

/** Decode only this canonical, bounded wire format; no source validity checks. */
export async function decodeDiskBoxRecovery(
  blob,
  { crypto = globalThis.crypto } = {},
) {
  check(
    blob instanceof Blob && blob.size >= HEADER && blob.size <= MAX_BYTES,
    "invalid archive size",
  );
  const header = new Uint8Array(await blob.slice(0, HEADER).arrayBuffer());
  check(
    MAGIC.every((byte, i) => header[i] === byte),
    "invalid magic/version",
  );
  const length = new DataView(header.buffer).getUint32(8, true);
  check(
    length <= MAX_META && HEADER + length <= blob.size,
    "invalid metadata length",
  );
  const bytes = new Uint8Array(
    await blob.slice(HEADER, HEADER + length).arrayBuffer(),
  );
  check(
    hex(await digest(bytes, crypto)) === hex(header.subarray(12)),
    "metadata checksum mismatch",
  );
  let meta;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    meta = JSON.parse(text);
    check(
      JSON.stringify(meta) === text,
      "noncanonical or duplicate metadata fields",
    );
  } catch (error) {
    fail(`invalid metadata: ${error.message}`);
  }
  keys(meta, "schema,root,nodes,segments");
  check(
    meta.schema === "triptych-disk-box-recovery-v1",
    "invalid metadata schema",
  );
  check(
    Array.isArray(meta.nodes) &&
      meta.nodes.length <= MAX_NODES &&
      Array.isArray(meta.segments) &&
      meta.segments.length <= MAX_NODES,
    "invalid graph size",
  );
  let offset = HEADER + length;
  const bodies = [];
  for (const segment of meta.segments) {
    keys(segment, "byteLength,sha256");
    check(
      Number.isSafeInteger(segment.byteLength) &&
        segment.byteLength >= 0 &&
        offset + segment.byteLength <= blob.size &&
        typeof segment.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(segment.sha256),
      "invalid segment bounds/hash",
    );
    const body = new Uint8Array(
      await blob.slice(offset, offset + segment.byteLength).arrayBuffer(),
    );
    check(
      hex(await digest(body, crypto)) === segment.sha256,
      "segment checksum mismatch",
    );
    bodies.push(body);
    offset += body.length;
  }
  check(offset === blob.size, "trailing archive bytes");
  const usedSegments = new Set();
  const values = meta.nodes.map((node) => {
    check(node && typeof node === "object", "invalid node");
    if (node.type === "bytes" || node.type === "buffer") {
      keys(node, "type,segment");
      check(
        Number.isInteger(node.segment) &&
          node.segment >= 0 &&
          node.segment < bodies.length &&
          !usedSegments.has(node.segment),
        "invalid segment reference",
      );
      usedSegments.add(node.segment);
      return node.type === "bytes"
        ? bodies[node.segment]
        : bodies[node.segment].buffer;
    }
    check(
      ["array", "object", "null-object"].includes(node.type),
      "unknown node type",
    );
    keys(node, node.type === "array" ? "type,length,props" : "type,props");
    check(Array.isArray(node.props), "invalid properties");
    if (node.type === "array") {
      check(
        Number.isInteger(node.length) &&
          node.length >= 0 &&
          node.length <= 0xffffffff,
        "invalid array length",
      );
      return new Array(node.length);
    }
    return node.type === "null-object" ? Object.create(null) : {};
  });
  check(usedSegments.size === bodies.length, "unreferenced segment");
  const value = (token) => {
    check(Array.isArray(token), "invalid value token");
    if (token.length === 1 && token[0] === "undefined") return undefined;
    check(token.length === 2, "invalid value token length");
    if (token[0] === "value") {
      check(
        token[1] === null || ["string", "boolean"].includes(typeof token[1]),
        "invalid literal",
      );
      return token[1];
    }
    if (token[0] === "number") {
      check(
        typeof token[1] === "string" &&
          (token[1] === "-0" || String(Number(token[1])) === token[1]),
        "invalid number",
      );
      return Number(token[1]);
    }
    check(
      token[0] === "ref" &&
        Number.isInteger(token[1]) &&
        token[1] >= 0 &&
        token[1] < values.length,
      "invalid graph reference",
    );
    return values[token[1]];
  };
  for (const [id, node] of meta.nodes.entries()) {
    if (!node.props) continue;
    check(Array.isArray(node.props), "invalid properties");
    const names = new Set();
    for (const prop of node.props) {
      check(
        Array.isArray(prop) &&
          prop.length === 2 &&
          typeof prop[0] === "string" &&
          !names.has(prop[0]),
        "duplicate or invalid property",
      );
      const [name, token] = prop;
      names.add(name);
      if (node.type === "array")
        check(
          name !== "length" &&
            (!/^(0|[1-9]\d*)$/.test(name) ||
              Number(name) >= 0xffffffff ||
              Number(name) < node.length),
          "invalid array property",
        );
      Object.defineProperty(values[id], name, {
        value: value(token),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return value(meta.root);
}
