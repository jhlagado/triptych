import { resolve } from "node:path";
import { expect, it } from "vitest";
import { assemblePortableCpmSource } from "../../tools/lib/portable-cpm-source.mjs";

// This is the deliberately separate, heavier consumer gate. The helper compares
// each ATOM output byte with its retained released binary before returning.
for (let count = 1; count <= 16; count++) {
  it(`rebuilds released two-MiB CCP/BDOS profile ${count} with ATOM`, async () => {
    const root = resolve(import.meta.dirname, "../..");
    const id = `triptych-cpu-v0.1-2m-n${String(count).padStart(2, "0")}`;
    const ccp = 65536 - 256 * Math.ceil(count / 2) - 1024 - 3584 - 2048;
    for (const component of ["ccp", "bdos"]) {
      const built = await assemblePortableCpmSource(root, component, id);
      expect(built.base).toBe(ccp + (component === "bdos" ? 2048 : 0));
      expect(built.bytes.length).toBe(component === "bdos" ? 3584 : 2048);
    }
  }, 30000);
}
