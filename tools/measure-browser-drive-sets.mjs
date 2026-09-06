import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir, platform, arch, release, cpus } from "node:os";
import { join } from "node:path";

// Diagnosis only: no application server, shared builds or production changes.
// The supplied deployment must expose its normal store/coordinator modules.
const supplied = process.argv[2];
if (!supplied || !/^https?:\/\//.test(supplied))
  throw new Error(
    "Usage: node tools/measure-browser-drive-sets.mjs http://127.0.0.1:4173/",
  );
const base = new URL(supplied.endsWith("/") ? supplied : `${supplied}/`);
const evidence = await mkdtemp(join(tmpdir(), "triptych-drive-set-measure-"));
console.log(`Evidence: ${evidence}`);
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summarize = (values) => ({
  samplesMs: values,
  medianMs: median(values),
  madMs: median(values.map((value) => Math.abs(value - median(values)))),
});
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const probeUrl = new URL("__drive-set-measure", base).href;
await page.route(probeUrl, (route) =>
  route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><title>Drive-set measurement</title>",
  }),
);
let result;
try {
  await page.goto(probeUrl);
  const environment = await page.evaluate(async (base) => {
    const names = [
      "drive-set-store.js",
      "disk-workspace.js",
      "drive-set.js",
      "working-disk-store.js",
    ];
    const modules = [];
    for (const name of names) {
      const response = await fetch(new URL(name, base), { cache: "no-store" });
      if (!response.ok)
        throw new Error(`Cannot load ${name}: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes),
      );
      modules.push({
        name,
        bytes: bytes.length,
        sha256: Array.from(digest, (v) => v.toString(16).padStart(2, "0")).join(
          "",
        ),
      });
    }
    const { openDriveSetStore } = await import(
      new URL("drive-set-store.js", base)
    );
    const { createDiskWorkspace, acquireDiskWriter } = await import(
      new URL("disk-workspace.js", base)
    );
    const { copyDriveSet } = await import(new URL("drive-set.js", base));
    const check = (yes, message) => {
      if (!yes) throw new Error(message);
    };
    const payloadBytes = (snapshot) =>
      snapshot.bootstrap.bytes.length +
      snapshot.drives.A.bytes.length +
      (snapshot.drives.B?.bytes.length ?? 0);
    window.measureSetup = async (profile) => {
      const name = `triptych-measure-${crypto.randomUUID()}`;
      const size = profile === "legacy-a" ? 256512 : 8388608;
      let current = {
        bootstrap: {
          profile:
            profile === "large-ab"
              ? "triptych-cpu-v0.1-8m-ab"
              : profile === "large-a"
                ? "triptych-cpu-v0.1-8m-a"
                : "legacy-e400",
          bytes: new Uint8Array(256),
        },
        drives: {
          A: { name: "a.img", bytes: new Uint8Array(size).fill(17) },
          B:
            profile === "large-ab"
              ? { name: "b.img", bytes: new Uint8Array(size).fill(34) }
              : null,
        },
      };
      const store = await openDriveSetStore({ name });
      const writer = await acquireDiskWriter({ name: `${name}:writer` });
      check(
        writer.owned,
        "Measurement did not acquire its real browser writer lease",
      );
      const runtime = {
        pause() {},
        resume() {},
        ready: () => true,
        checkpoint: () => current,
        prepare: (snapshot) => snapshot,
        activate: (snapshot) => {
          current = snapshot;
        },
        discard() {},
      };
      const workspace = createDiskWorkspace({ store, writer, runtime });
      await workspace.saveCheckpoint(current);
      window.measureState = {
        name,
        store,
        writer,
        workspace,
        runtime,
        get current() {
          return current;
        },
        set current(value) {
          current = value;
        },
      };
      return {
        name,
        payloadBytes: payloadBytes(current),
        changedDrive: current.drives.B ? "B" : "A",
        changedImageBytes: size,
      };
    };
    window.measureRaw = async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(measureState.name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(
            ["drive-set-blobs", "drive-set-state"],
            "readonly",
          );
          const blobs = tx.objectStore("drive-set-blobs").getAll();
          const states = tx.objectStore("drive-set-state").getAll();
          tx.oncomplete = () =>
            resolve({
              blobCount: blobs.result.length,
              blobBytes: blobs.result.reduce(
                (sum, value) => sum + value.bytes.byteLength,
                0,
              ),
              blobs: blobs.result
                .map((value) => ({
                  sha256: value.sha256,
                  bytes: value.bytes.byteLength,
                }))
                .sort((a, b) => a.sha256.localeCompare(b.sha256)),
              headCount: states.result.filter((value) => value.key === "head")
                .length,
              backupCount: states.result.filter((value) =>
                value.key.startsWith("backup:"),
              ).length,
              receiptCount: states.result.filter((value) =>
                value.key.startsWith("operation:"),
              ).length,
            });
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    };
    window.measureSaves = async () => {
      const times = [];
      const state = measureState;
      const drive = state.current.drives.B ? "B" : "A";
      for (let i = 1; i <= 5; i++) {
        state.current.drives[drive].bytes[
          state.current.drives[drive].bytes.length - 1
        ] = i;
        const start = performance.now();
        const value = await state.workspace.saveCheckpoint(state.current);
        times.push(performance.now() - start);
        check(
          value.kind === "saved",
          "Serial save was unexpectedly superseded",
        );
      }
      return times;
    };
    window.measureManual = async () => {
      const state = measureState;
      const drive = state.current.drives.B ? "B" : "A";
      const before = await measureRaw();
      const samples = [];
      for (let i = 1; i <= 5; i++) {
        const start = performance.now();
        const token = await state.workspace.beginManagement({
          savedAndExited: true,
        });
        const candidate = copyDriveSet(state.current);
        candidate.drives[drive].bytes[
          candidate.drives[drive].bytes.length - 1
        ] = i + 16;
        state.workspace.stage(token, candidate);
        await state.workspace.commit(token);
        const elapsedMs = performance.now() - start;
        const stored = await state.store.load();
        check(stored.kind === "ready", "Manual commit did not publish");
        check(
          stored.snapshot.drives[drive].bytes.at(-1) === i + 16,
          "Wrong manual candidate",
        );
        if (drive === "B")
          check(
            stored.snapshot.drives.A.bytes.every((v) => v === 17),
            "B-only change corrupted A",
          );
        samples.push({ elapsedMs, raw: await measureRaw() });
      }
      return { before, samples };
    };
    window.measureQueueSetup = async () => {
      const state = measureState;
      await state.workspace.close();
      const head = await state.store.load();
      const calls = [];
      let release, entered;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const heldStore = {
        saveCheckpoint: async (token, snapshot) => {
          calls.push(
            snapshot.drives.B?.bytes.at(-1) ?? snapshot.drives.A.bytes.at(-1),
          );
          if (calls.length === 1) {
            entered();
            await gate;
          }
          return state.store.saveCheckpoint(token, snapshot);
        },
      };
      const workspace = createDiskWorkspace({
        store: heldStore,
        writer: state.writer,
        runtime: state.runtime,
        token: head.token,
      });
      const input = copyDriveSet(state.current);
      window.measureQueue = {
        workspace,
        input,
        calls,
        release,
        started,
        outcomes: [],
        promises: [],
      };
      return {
        payloadBytes: payloadBytes(input),
        callerInputBytes: payloadBytes(input),
      };
    };
    window.measureQueueSubmit = async () => {
      const q = measureQueue;
      const drive = q.input.drives.B ? "B" : "A";
      for (let i = 1; i <= 100; i++) {
        q.input.drives[drive].bytes[q.input.drives[drive].bytes.length - 1] = i;
        q.promises.push(
          q.workspace.saveCheckpoint(q.input).then((value) => {
            q.outcomes.push(value.kind);
            return value;
          }),
        );
        if (i === 1) await q.started;
      }
      await Promise.resolve();
      check(
        q.calls.length === 1,
        "Stalled first save did not exclude publication",
      );
      check(
        q.outcomes.filter((v) => v === "superseded").length === 98,
        "Newest-only queue did not supersede 98 snapshots",
      );
      return {
        submissions: 100,
        saveCallsWhileStalled: q.calls.length,
        supersededWhileStalled: q.outcomes.length,
        unsettled: 100 - q.outcomes.length,
        sourceDerivedRetainedCoordinatorPayloadBytes: 2 * payloadBytes(q.input),
      };
    };
    window.measureQueueRelease = async () => {
      const q = measureQueue;
      q.release();
      await Promise.all(q.promises);
      const result = {
        saved: q.outcomes.filter((v) => v === "saved").length,
        superseded: q.outcomes.filter((v) => v === "superseded").length,
        publishedValues: [...q.calls],
      };
      check(
        JSON.stringify(result) ===
          JSON.stringify({
            saved: 2,
            superseded: 98,
            publishedValues: [1, 100],
          }),
        "Wrong bounded-queue completion",
      );
      await q.workspace.close();
      window.measureQueue = undefined;
      return result;
    };
    window.measureCleanup = async () => {
      const state = measureState;
      await state.workspace.close();
      state.store.close();
      await state.writer.release();
      window.measureState = undefined;
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(state.name);
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
        request.onblocked = () =>
          reject(new Error("Private measurement database cleanup blocked"));
      });
    };
    return {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: navigator.deviceMemory ?? null,
      modules,
    };
  }, base.href);
  const cdp = await context.newCDPSession(page);
  const heap = async () => {
    try {
      await cdp.send("HeapProfiler.collectGarbage");
      const value = await cdp.send("Runtime.getHeapUsage");
      return {
        ...value,
        backingStorageSupported: Number.isFinite(value.backingStorageSize),
      };
    } catch (error) {
      return { unavailable: String(error) };
    }
  };
  const profiles = [];
  for (const profile of ["legacy-a", "large-a", "large-ab"]) {
    const setup = await page.evaluate(
      (profile) => measureSetup(profile),
      profile,
    );
    const saves = summarize(await page.evaluate(() => measureSaves()));
    const manual = await page.evaluate(() => measureManual());
    const latest = manual.samples.at(-1).raw;
    assert.equal(latest.blobCount - manual.before.blobCount, 5);
    assert.equal(
      latest.blobBytes - manual.before.blobBytes,
      5 * setup.changedImageBytes,
    );
    assert.equal(latest.backupCount, 5);
    const queueSetup = await page.evaluate(() => measureQueueSetup());
    const baseline = await heap();
    const stalled = await page.evaluate(() => measureQueueSubmit());
    const stalledHeap = await heap();
    const completion = await page.evaluate(() => measureQueueRelease());
    profiles.push({
      profile,
      setup,
      autosave: saves,
      manual: {
        ...summarize(manual.samples.map((s) => s.elapsedMs)),
        before: manual.before,
        samples: manual.samples,
        addedBlobBytes: latest.blobBytes - manual.before.blobBytes,
        naiveSixCompleteSnapshotPayloadBytes: 6 * setup.payloadBytes,
      },
      queue: {
        setup: queueSetup,
        baselineAfterGc: baseline,
        stalledAfterGc: stalledHeap,
        stalled,
        completion,
      },
    });
    await page.evaluate(() => measureCleanup());
    console.log(
      `${profile}: save median ${saves.medianMs.toFixed(1)} ms; manual blob growth ${latest.blobBytes - manual.before.blobBytes} bytes`,
    );
  }
  result = {
    date: new Date().toISOString(),
    suppliedBase: base.href,
    environment: {
      ...environment,
      browserVersion: browser.version(),
      node: process.version,
      os: platform(),
      arch: arch(),
      release: release(),
      cpu: cpus()[0]?.model,
    },
    method: {
      samples: 5,
      statistic: "median and median absolute deviation",
      units: "milliseconds, bytes",
      saveBoundary:
        "public coordinator submission through completed IndexedDB transaction",
      manualBoundary:
        "beginManagement + stage + commit; controlled runtime hooks, no CPU preparation",
      queueMemory:
        "forced-GC CDP samples, NOT peak memory; coordinator retained bytes derived from 2 payloads and confirmed supersession/publication behavior",
      storage:
        "exact raw stored blob payload lengths/counts; excludes IndexedDB metadata and engine overhead; NOT quota or physical disk usage",
      inputs:
        "deterministic synthetic media with distinct A/B contents; five B-only manual changes for AB, five A-only changes for single-drive comparators",
      excluded:
        "CPU execution, filesystem parsing, application rendering, ESP32 and browser quota",
    },
    profiles,
  };
  await writeFile(
    join(evidence, "results.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      { status: "passed", evidence, profiles: profiles.length },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  await browser.close();
}
