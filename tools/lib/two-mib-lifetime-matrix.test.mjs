import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createTwoMibLifetimeJobs,
  runTwoMibLifetimeMatrix,
  TWO_MIB_ARENA_SUITES,
} from "./two-mib-lifetime-matrix.mjs";
import { createSuite as atomSuite } from "./large-ab-atom-arenas.mjs";
import { createSuite as editSuite } from "./large-ab-edit-arenas.mjs";
import { createSuite as nucleusSuite } from "./large-ab-nucleus-arenas.mjs";

test("fixed matrix covers all resident tuples and three full-arena liveness cases", () => {
  const jobs = createTwoMibLifetimeJobs();
  assert.equal(jobs.length, 31);
  assert(Object.isFrozen(jobs));
  assert(jobs.every(Object.isFrozen));
  assert.deepEqual(
    jobs.filter(({ suite }) => !suite).map(({ count }) => count),
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
  for (const count of [1, 3, 16])
    assert.deepEqual(
      jobs
        .filter((job) => job.count === count && job.suite)
        .map(({ suite }) => suite),
      TWO_MIB_ARENA_SUITES,
    );
  assert.equal(new Set(jobs.map((job) => JSON.stringify(job))).size, 31);
  assert.notEqual(createTwoMibLifetimeJobs(), jobs);
});

test("matrix executes every job once with at most two active proofs", async () => {
  let active = 0,
    maximum = 0;
  const seen = [];
  const result = await runTwoMibLifetimeMatrix(async (job) => {
    maximum = Math.max(maximum, ++active);
    seen.push(job);
    await new Promise(setImmediate);
    active--;
  });
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.deepEqual(seen, createTwoMibLifetimeJobs());
  assert.deepEqual(result, { jobs: 31 });
});

test("failure stops new jobs, drains the other active proof and preserves causes", async () => {
  const calls = [];
  let finishOther,
    settled = false;
  const first = new Error("first proof failed");
  const second = new Error("other active proof failed");
  const running = runTwoMibLifetimeMatrix((job) => {
    calls.push(job);
    if (job.count === 1) throw first;
    return new Promise((resolve, reject) => {
      finishOther = () => reject(second);
    });
  });
  // A synchronous failure can stop worker two before it starts at all.
  await assert.rejects(running, (error) => error.errors[0].cause === first);
  assert.equal(calls.length, 1);

  calls.length = 0;
  const asynchronous = runTwoMibLifetimeMatrix(async (job) => {
    calls.push(job);
    if (job.count === 1) {
      await Promise.resolve();
      throw first;
    }
    await new Promise((resolve, reject) => {
      finishOther = () => reject(second);
    });
  });
  const checked = assert.rejects(asynchronous, (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map(({ cause }) => cause),
      [first, second],
    );
    settled = true;
    return true;
  });
  await new Promise(setImmediate);
  assert.deepEqual(
    calls.map(({ count }) => count),
    [1, 2],
  );
  assert.equal(settled, false);
  finishOther();
  await checked;
  assert.equal(calls.length, 2);
});

test("CLI rejects unsupported or repeated flags before starting proofs", () => {
  const script = fileURLToPath(
    new URL("../prove-two-mib-lifetimes.mjs", import.meta.url),
  );
  for (const args of [["--counts=1"], ["--allow-dirty", "--allow-dirty"]]) {
    const child = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /usage:/);
    assert.doesNotMatch(child.stdout, /Evidence:/);
  }
});

// Captured from the historical pre-parameterization source at f2b9c60. The
// serialization excludes functions and normalizes only the selection-report ID.
// Expected fixture bytes/commands are independent of the current factories.
const historical = [
  [
    "atom-symbols",
    atomSuite,
    "ff6448897675c6436ea6bffeb550c14988bc31274b2741246ceb9dffce657700",
  ],
  [
    "atom-parts",
    atomSuite,
    "bc9d054bc7f179d0c88adf0f34026f322d9a344c20e56c4af234dc41c614d033",
  ],
  [
    "atom-chain",
    atomSuite,
    "13829c5acc5f234511a722aa50f6d0925d368774265e266a78928d8ee09cebcb",
  ],
  [
    "nucleus",
    nucleusSuite,
    "0b9ec96532d22f5282361682cd66c3b5fc237adcbfd31c5663f7b54daf3bb50a",
  ],
  [
    "edit",
    editSuite,
    "66fcdddf0e3a6b15807d9a3ae7d452a168b13989735cfecaeb4d5f6685856c8c",
  ],
];
for (const [kind, createSuite, expected] of historical) {
  test(`${kind}: historical default fixture and step contract`, () => {
    const suite = createSuite(kind);
    const record = {
      fixtures: [...suite.fixtures].map(([name, bytes]) => [
        name,
        Buffer.from(bytes).toString("hex"),
      ]),
      steps: suite.steps.map((step) =>
        Object.fromEntries(
          Object.entries(step)
            .filter(([, value]) => typeof value !== "function")
            .map(([key, value]) => [
              key,
              key === "id"
                ? value.replace("select-b", "select-work-drive")
                : value,
            ]),
        ),
      ),
      limits: suite.limits,
      outputStems: suite.outputStems,
      mutableFiles: [...(suite.mutableFiles ?? [])],
    };
    assert.equal(
      createHash("sha256").update(JSON.stringify(record)).digest("hex"),
      expected,
    );
  });
  test(`${kind}: A/P routing changes only selected drive and prompts`, () => {
    for (const workLetter of ["A", "P"]) {
      const suite = createSuite(kind, { workLetter });
      assert.equal(suite.steps[1].input, `${workLetter}:\r`);
      assert.equal(suite.steps[1].suffix, `\r\n${workLetter}>`);
      assert.equal(suite.steps.at(-1).suffix, `\r\n${workLetter}>`);
      assert.deepEqual(suite.fixtures, createSuite(kind).fixtures);
    }
    assert.throws(() => createSuite(kind, { workLetter: "Q" }));
  });
}

test("Nucleus fixture stack floor translates by resident origin without weakening 84-byte bound", () => {
  const cpu = {
    read_ram() {
      throw new Error("unexpected RAM observation");
    },
  };
  for (const ccpBase of [0xe300, 0xe500, 0xe400, 0xde00]) {
    const suite = nucleusSuite("nucleus", { ccpBase });
    const entrySp = ccpBase + 2027;
    const lifetime = { tool: "R7.COM", entrySp };
    // PC in provider prefix avoids the separate activation-state sampling.
    suite.observe(cpu, { pc: 0x101, sp: entrySp - 84 }, lifetime);
    assert.throws(
      () => suite.observe(cpu, { pc: 0x101, sp: entrySp - 85 }, lifetime),
      /caller-frame floor/,
    );
  }
  assert.equal(0xe300 + 2027 - 84, 0xea97);
});
