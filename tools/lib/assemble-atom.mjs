import { basename, dirname, resolve } from "node:path";
import {
  assembleAtomProject,
  materializeAtomGeneration,
  writeAtomD8,
} from "atom-z80";

/** Build a flat Z80 image with ATOM; bytes start at the lowest source address. */
export async function assembleAtomFile(source) {
  const absolute = resolve(source);
  const result = await assembleAtomProject({
    root: dirname(absolute),
    entry: basename(absolute),
  });
  const addresses = [
    ...result.generation.images.map((image) => image.address),
    ...result.generation.layout.map((event) => event.address),
  ];
  if (addresses.length === 0) {
    throw new Error(`ATOM emitted no image for ${source}`);
  }
  const base = Math.min(...addresses);
  const { bytes } = materializeAtomGeneration(result.generation, { base });
  if (bytes.length === 0) {
    throw new Error(`ATOM emitted no bytes for ${source}`);
  }
  const debugMap = writeAtomD8(result.project, result.generation, { base });
  const labels = Object.fromEntries(
    debugMap.symbols
      .filter((symbol) => symbol.kind === "label")
      .map((symbol) => [symbol.name, symbol.address]),
  );
  return { bytes, labels, base };
}

export async function assembleAtomBinary(source) {
  return (await assembleAtomFile(source)).bytes;
}
