import assert from "node:assert/strict";

export const TWO_MIB_ARENA_SUITES = Object.freeze([
  "atom-symbols",
  "atom-parts",
  "atom-chain",
  "nucleus",
  "edit",
]);

/** Every resident tuple gets the original source/output/text proof. Full tool
 * arenas additionally cover one shared boot/work drive, sparse odd allocation,
 * and the lowest resident boundary with P as the work drive. */
export function createTwoMibLifetimeJobs() {
  return Object.freeze(
    [
      ...Array.from({ length: 16 }, (_, index) => ({ count: index + 1 })),
      ...[1, 3, 16].flatMap((count) =>
        TWO_MIB_ARENA_SUITES.map((suite) => ({ count, suite })),
      ),
    ].map(Object.freeze),
  );
}

/** Two serial workers. On failure, stop assigning jobs and await both active
 * children before rejecting; an existing child is never restarted or dropped.
 * The callback resolves only after its proof process has closed successfully. */
export async function runTwoMibLifetimeMatrix(execute) {
  assert.equal(typeof execute, "function");
  const jobs = createTwoMibLifetimeJobs();
  const completed = [];
  const failures = [];
  let next = 0;
  const worker = async () => {
    while (!failures.length && next < jobs.length) {
      const job = jobs[next++];
      try {
        await execute(job);
        completed.push(job);
      } catch (cause) {
        failures.push(
          new Error(
            `n${String(job.count).padStart(2, "0")} ${job.suite ?? "source-output-text"} failed`,
            { cause },
          ),
        );
      }
    }
  };
  await Promise.all([worker(), worker()]);
  if (failures.length)
    throw new AggregateError(
      failures,
      "two-MiB lifetime matrix failed; active proofs have closed",
    );
  assert.equal(completed.length, jobs.length);
  return { jobs: completed.length };
}
