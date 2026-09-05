import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("Pages upload retains the hidden files in the verified site inventory", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/wasm-pages.yml", import.meta.url),
    "utf8",
  );
  const upload = workflow
    .split("- name: Upload GitHub Pages artifact")[1]
    .split("\n  deploy:")[0];
  expect(upload).toContain("path: dist/wasm-browser");
  expect(upload).toMatch(/include-hidden-files:\s*true/);
});
