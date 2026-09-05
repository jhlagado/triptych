import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const RELEASE_PROVENANCE_SCHEMA = "triptych-release-provenance-v1";

function closedObject(value, keys, label) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  for (const key of keys) {
    assert.ok(Object.hasOwn(value, key), `${label} is missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    assert.ok(keys.includes(key), `${label} has unknown field ${key}`);
  }
}

async function containedFile(root, path, label) {
  assert.ok(
    typeof path === "string" &&
      path.length > 0 &&
      !isAbsolute(path) &&
      !/^[A-Za-z]:/.test(path) &&
      !/[\\\0]/.test(path) &&
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    `${label} must be a normalized relative path`,
  );
  const resolved = await realpath(resolve(root, path));
  const local = relative(root, resolved);
  assert.ok(
    local !== "" &&
      local !== ".." &&
      !local.startsWith(`..${sep}`) &&
      !isAbsolute(local),
    `${label} resolves outside the repository`,
  );
  assert.ok((await stat(resolved)).isFile(), `${label} must be a regular file`);
  return resolved;
}

/**
 * Verify reviewed local inputs for a structurally validated Git component.
 * Provenance is a closed object with schema, repository, revision, bytes,
 * sha256, manifestSha256, and origin:
 * { kind: "release-asset" | "ci-artifact", url: HTTPS URL }.
 * The origin records the reviewed asset or CI artifact; it is never fetched.
 * Reviewed repository provenance supplies the association, not a signature.
 * Assumes a trusted local checkout without concurrent hostile filesystem
 * mutation; realpath/stat/read checks are containment checks, not a sandbox.
 * Upstream manifest formats and target compatibility belong to the caller.
 */
export async function readVerifiedRelease(repositoryRoot, component) {
  assert.equal(component.recipe, "verified-release", "release recipe");
  assert.equal(component.source.kind, "git", "release source kind");
  const root = await realpath(repositoryRoot);
  const artifact = component.artifact;
  const paths = await Promise.all(
    ["path", "manifest", "provenance"].map((field) =>
      containedFile(root, artifact[field], `release artifact.${field}`),
    ),
  );
  const [bytes, manifestBytes, provenanceText] = await Promise.all([
    readFile(paths[0]),
    readFile(paths[1]),
    readFile(paths[2], "utf8"),
  ]);
  assert.equal(bytes.length, artifact.bytes, "release artifact byte length");
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    artifact.sha256,
    "release artifact SHA-256",
  );
  const provenance = JSON.parse(provenanceText);
  closedObject(
    provenance,
    [
      "schema",
      "repository",
      "revision",
      "bytes",
      "sha256",
      "manifestSha256",
      "origin",
    ],
    "release provenance",
  );
  assert.equal(
    provenance.schema,
    RELEASE_PROVENANCE_SCHEMA,
    "provenance schema",
  );
  assert.equal(
    provenance.repository,
    component.source.repository,
    "provenance repository",
  );
  assert.equal(
    provenance.revision,
    component.source.revision,
    "provenance revision",
  );
  assert.equal(provenance.bytes, artifact.bytes, "provenance byte length");
  assert.equal(provenance.sha256, artifact.sha256, "provenance SHA-256");
  assert.match(
    provenance.manifestSha256,
    /^[0-9a-f]{64}$/,
    "provenance manifest SHA-256",
  );
  assert.equal(
    createHash("sha256").update(manifestBytes).digest("hex"),
    provenance.manifestSha256,
    "release manifest SHA-256",
  );
  closedObject(provenance.origin, ["kind", "url"], "provenance origin");
  assert.ok(
    ["release-asset", "ci-artifact"].includes(provenance.origin.kind),
    "provenance origin kind must identify a release asset or CI artifact",
  );
  assert.equal(typeof provenance.origin.url, "string", "provenance origin URL");
  const origin = new URL(provenance.origin.url);
  assert.equal(origin.protocol, "https:", "provenance origin must use HTTPS");
  assert.ok(
    !origin.username && !origin.password,
    "provenance origin must not contain credentials",
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.ok(
    manifest !== null &&
      typeof manifest === "object" &&
      !Array.isArray(manifest),
    "release manifest must be a JSON object",
  );
  return { bytes: Uint8Array.from(bytes), manifest };
}
