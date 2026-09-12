import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
const source = await readFile(
  new URL("../../crates/triptych-host-wasm/web/app.js", import.meta.url),
  "utf8",
);
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
const selection = new Function(
  `${functionSource("localConfigurationSelection")};return localConfigurationSelection;`,
)();
const bookmark = (suppliedMachine) =>
  new Function(
    "suppliedMachine",
    `${functionSource("localConfigurationBookmark")};return localConfigurationBookmark;`,
  )(suppliedMachine);
const id = "00000000-0000-4000-8000-000000000001";
test("device-local selector uses one exact UUID and rejects public selectors, duplicates and names", () => {
  assert.equal(selection(new URLSearchParams(`configuration=${id}`)), id);
  assert.equal(
    selection(new URLSearchParams("recipe=starter&revision=public")),
    undefined,
  );
  for (const query of [
    `configuration=${id}&recipe=starter`,
    `configuration=${id}&revision=public`,
    `configuration=${id}&configuration=${id}`,
    "configuration=My+saved+machine",
    "configuration=",
  ])
    assert.throws(() => selection(new URLSearchParams(query)));
});
test("local bookmarks preserve supplied namespace without a public recipe parameter", () => {
  assert.equal(bookmark(false)(id), `?configuration=${id}`);
  assert.equal(bookmark(true)(id), `?machine=supplied&configuration=${id}`);
});
