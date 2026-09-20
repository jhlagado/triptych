// Raster fallbacks are generated from the same SVG used by modern browsers.
// Run after editing favicon.svg; commit the generated PNGs with the source.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const web = new URL("../crates/triptych-host-wasm/web/", import.meta.url);
const svg = await readFile(new URL("favicon.svg", web), "utf8");
const browser = await chromium.launch();
try {
  for (const [name, size] of [
    ["favicon.png", 32],
    ["apple-touch-icon.png", 180],
  ]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<style>html,body{margin:0;background:#08170f}svg{display:block;width:100%;height:100%}</style>${svg}`,
    );
    await page.screenshot({ path: fileURLToPath(new URL(name, web)) });
    await page.close();
  }
} finally {
  await browser.close();
}
