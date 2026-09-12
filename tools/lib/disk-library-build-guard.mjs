/** Publication policy for an already validated checked-in retained package.
 * Candidate refresh is a local qualification build, never a release build.
 * This does not change the separate deployment checker's --release contract:
 * the pin command must still qualify a clean candidate with that checker.
 */
export function diskLibraryBuildMode({ browser, release, refresh, previous }) {
  if (refresh && !browser)
    throw new Error("disk-library refresh requires a browser candidate build");
  if (!browser) return "none";
  if (release && refresh)
    throw new Error(
      "Browser publication cannot refresh the disk library. Build and qualify a local candidate, pin it, then build --release without --refresh-disk-library.",
    );
  const manifest = previous?.manifest;
  const pinned =
    Array.isArray(manifest?.recipes) && manifest.recipes.length > 0;
  if (release) {
    for (const id of ["starter", "library"]) {
      const selected = manifest?.defaults?.find((row) => row.id === id);
      if (
        !pinned ||
        !selected ||
        !manifest.recipes.some(
          (row) => row.id === id && row.revision === selected.revision,
        )
      )
        throw new Error(
          "Browser publication requires a pinned retained library with starter and library defaults. Qualify and pin the initial candidate first.",
        );
    }
  }
  return pinned && !refresh ? "pinned" : "candidate";
}

export function selectDiskLibraryBuild(mode, previous, candidate, merge) {
  if (mode === "pinned") return previous;
  if (mode !== "candidate")
    throw new Error("No browser disk library build mode");
  return merge(previous, candidate, { defaults: candidate.manifest.defaults });
}
