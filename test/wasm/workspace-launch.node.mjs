import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { loadWorkspaceLaunch } from "../../crates/triptych-host-wasm/web/workspace-launch.js";

const { CpmDisk } = createRequire(import.meta.url)(
  "../../dist/wasm/triptych_host_wasm.js",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const profile = "triptych-cpu-v0.1-2m-n04";
const system = new Uint8Array(16384);
const bootstrap = new Uint8Array(256);
const atom = Uint8Array.of(65, 84, 79, 77);
const example = new TextEncoder().encode("ORG 100H\n");

function descriptor(overrides = {}) {
  return {
    schema: "triptych-file-recipe-v1",
    id: "atom-starter",
    revision: "1",
    name: "Atom starter",
    instruction: "Type DIR.",
    profile,
    components: [
      {
        id: "atom",
        name: "ATOM.COM",
        description: "Assembler",
        files: [
          {
            name: "ATOM.COM",
            url: "https://files.example/ATOM.COM",
            bytes: atom.length,
            sha256: hash(atom),
          },
        ],
      },
      {
        id: "example",
        name: "EXAMPLE.ASM",
        description: "Example",
        files: [
          {
            name: "EXAMPLE.ASM",
            url: "assets/EXAMPLE.ASM",
            bytes: example.length,
            sha256: hash(example),
          },
        ],
      },
    ],
    ...overrides,
  };
}

function run({ metadata = descriptor(), componentIds } = {}) {
  const requests = [];
  return loadWorkspaceLaunch({
    url: "https://recipes.example/recipes/atom-starter.json",
    baseUrl: "https://machine.example/",
    deployment: {},
    CpmDisk,
    componentIds,
    crypto: webcrypto,
    fetchTwoMibSystem: async ({ configuredCount }) => ({
      descriptor: {
        residentProfile: `triptych-cpu-v0.1-2m-n${String(configuredCount).padStart(2, "0")}`,
      },
      system,
      bootstrap,
    }),
    fetch: async (url, options) => {
      requests.push({ url, options });
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      const target = new URL(url);
      if (
        target.hostname === "recipes.example" &&
        target.pathname.endsWith("atom-starter.json")
      )
        return new Response(JSON.stringify(metadata));
      if (target.pathname.endsWith("ATOM.COM")) return new Response(atom);
      if (target.pathname.endsWith("EXAMPLE.ASM")) return new Response(example);
      throw new Error(`unexpected request ${url}`);
    },
  }).then((launch) => ({ launch, requests }));
}

test("file recipes build a fresh bootable disk and retain selected components", async () => {
  const { launch, requests } = await run();
  assert.equal(launch.id, "atom-starter");
  assert.deepEqual(launch.components, ["atom", "example"]);
  assert.deepEqual(launch.files, ["ATOM.COM", "EXAMPLE.ASM"]);
  assert.equal(launch.image.length, 2097152);
  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "https://recipes.example/recipes/atom-starter.json",
      "https://files.example/ATOM.COM",
      "https://recipes.example/recipes/assets/EXAMPLE.ASM",
    ],
  );
  const disk = new CpmDisk(launch.image);
  try {
    assert.deepEqual(disk.file_names(), ["ATOM.COM", "EXAMPLE.ASM"]);
    assert.deepEqual(disk.read_file("ATOM.COM").slice(0, atom.length), atom);
    assert.deepEqual(
      disk.read_file("EXAMPLE.ASM").slice(0, example.length),
      example,
    );
  } finally {
    disk.free();
  }
});

test("component selection is part of the launch and installs only selected files", async () => {
  const { launch } = await run({ componentIds: ["example"] });
  assert.deepEqual(launch.components, ["example"]);
  const disk = new CpmDisk(launch.image);
  try {
    assert.deepEqual(disk.file_names(), ["EXAMPLE.ASM"]);
  } finally {
    disk.free();
  }
});

test("a corrupt file is rejected before a disk candidate is returned", async () => {
  const metadata = descriptor();
  metadata.components[0].files[0].sha256 = "0".repeat(64);
  await assert.rejects(run({ metadata }), /SHA-256 verification/);
});

test("conflicting component filenames are rejected", async () => {
  const metadata = descriptor();
  metadata.components.push({
    id: "other",
    name: "Other",
    description: "Conflict",
    files: [
      {
        name: "ATOM.COM",
        url: "https://files.example/other.com",
        bytes: 1,
        sha256: "1".repeat(64),
      },
    ],
  });
  await assert.rejects(run({ metadata }), /conflicting ATOM.COM/);
});

test("recipe metadata rejects insecure and oversized file declarations", async () => {
  const metadata = descriptor();
  metadata.components[0].files[0].url = "http://files.example/ATOM.COM";
  await assert.rejects(run({ metadata }), /HTTPS URL/);
  const oversized = descriptor();
  oversized.components[0].files[0].bytes = 256 * 1024 + 1;
  await assert.rejects(run({ metadata: oversized }), /invalid file size/);
});
