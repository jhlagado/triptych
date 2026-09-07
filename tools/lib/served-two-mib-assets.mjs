import assert from "node:assert/strict";

/** Qualify the actual served browser module graph and its selected binaries.
 * The caller supplies a disposable page and already-verified deployment.
 * This does not create a CPU, open storage or qualify application activation.
 */
export async function checkServedTwoMibAssets(page, baseUrl, deployment) {
  assert.deepEqual(
    deployment.twoMibProfiles
      .map((profile) => profile.configuredCount)
      .sort((a, b) => a - b),
    Array.from({ length: 16 }, (_, index) => index + 1),
    "served release requires all sixteen profiles",
  );
  const actual = await page.evaluate(
    async ({ baseUrl, deployment }) => {
      const { fetchTwoMibSystem } = await import(
        new URL("two-mib-system.js", baseUrl).href
      );
      const hash = async (bytes) =>
        Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
      const tuples = [];
      for (const configuredCount of [1, 16]) {
        const { system, bootstrap, descriptor } = await fetchTwoMibSystem({
          deployment,
          configuredCount,
          baseUrl,
        });
        tuples.push({
          descriptor,
          systemBytes: system.length,
          systemSha256: await hash(system),
          bootstrapBytes: bootstrap.length,
          bootstrapSha256: await hash(bootstrap),
        });
      }
      return tuples;
    },
    { baseUrl, deployment },
  );
  assert.deepEqual(
    actual,
    [1, 16].map((count) => {
      const descriptor = deployment.twoMibProfiles.find(
        (profile) => profile.configuredCount === count,
      );
      return {
        descriptor,
        systemBytes: descriptor.system.bytes,
        systemSha256: descriptor.system.sha256,
        bootstrapBytes: descriptor.bootstrap.bytes,
        bootstrapSha256: descriptor.bootstrap.sha256,
      };
    }),
    "served system/bootstrap tuples differ from verified deployment",
  );
  return actual;
}
