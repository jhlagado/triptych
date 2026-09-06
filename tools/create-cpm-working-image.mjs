import { link, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCpmDistribution } from "./lib/cpm-distribution.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** Create a new default machine disk; never adapt or overwrite saved media. */
export async function createCpmWorkingImage(
  destination,
  { allowDirty = false } = {},
) {
  const diskPath = resolve(destination);
  const distribution = await buildCpmDistribution(repositoryRoot, {
    allowDirty,
  });
  const temporary = await mkdtemp(
    join(dirname(diskPath), ".triptych-new-disk-"),
  );
  try {
    const candidate = join(temporary, "candidate.img");
    const handle = await open(candidate, "wx");
    try {
      await handle.writeFile(distribution.disk);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Same-filesystem link publishes a complete file only if destination is
    // absent, including when another process creates it after preparation.
    await link(candidate, diskPath);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { diskPath, manifest: distribution.manifest };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const paths = args.filter((arg) => !arg.startsWith("--"));
  const flags = args.filter((arg) => arg.startsWith("--"));
  if (
    paths.length !== 1 ||
    flags.some((flag) => flag !== "--allow-dirty") ||
    flags.length > 1
  ) {
    throw new Error(
      "usage: node tools/create-cpm-working-image.mjs NEW-IMAGE [--allow-dirty]",
    );
  }
  console.log(
    JSON.stringify(
      await createCpmWorkingImage(paths[0], {
        allowDirty: flags.includes("--allow-dirty"),
      }),
      null,
      2,
    ),
  );
}
