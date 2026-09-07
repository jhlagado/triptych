import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { cpus, freemem, platform, release, tmpdir, totalmem } from "node:os";
import { extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import {
  copySavedMachine,
  decodeSavedMachineArchive,
  encodeSavedMachine,
} from "../crates/triptych-host-wasm/web/saved-machine.js";
import { prepareTwoMibConfiguration } from "../crates/triptych-host-wasm/web/saved-machine-configuration.js";

// Measurement only: no product edits, build, Playwright test runner, or cleanup
// of previous evidence. Every workload owns a fresh browser process and context.
assert.equal(
  process.argv.length,
  4,
  "Usage: node tools/measure-browser-management-memory.mjs --archive ALL_SIXTEEN.tds",
);
assert.equal(process.argv[2], "--archive");
assert.ok(
  ["darwin", "linux"].includes(platform()),
  "RSS sampler requires macOS/Linux ps",
);
const root = resolve(import.meta.dirname, "..");
const assetsRoot = join(root, "dist/wasm-browser");
const input = resolve(process.argv[3]);
const output = await mkdtemp(join(tmpdir(), "triptych-management-memory-"));
console.log(`Measurement evidence: ${output}`);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((yes) => setTimeout(yes, ms));
const exec = promisify(execFile);
const manifestBytes = await readFile(
  join(assetsRoot, "deployment-manifest.json"),
);
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.storageSchema, "triptych-drive-set-v4");
const assetPaths = new Map(manifest.assets.map((asset) => [asset.path, asset]));
for (const asset of manifest.assets) {
  assert.match(asset.path, /^[A-Za-z0-9_.-]+$/);
  const bytes = await readFile(join(assetsRoot, asset.path));
  assert.equal(bytes.length, asset.bytes);
  assert.equal(
    hash(bytes),
    asset.sha256,
    `Frozen asset mismatch: ${asset.path}`,
  );
}
const archiveBytes = await readFile(input);
const original = await decodeSavedMachineArchive(archiveBytes);
assert.equal(original.configuredCount, 16);
assert.ok(original.slots.every(Boolean), "Requires all sixteen inserted media");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".wasm": "application/wasm",
};
const requests = [];
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const name = path === "/" ? "index.html" : path.slice(1);
  if (
    request.method !== "GET" ||
    (!assetPaths.has(name) && name !== "deployment-manifest.json")
  ) {
    response.writeHead(404).end();
    return;
  }
  requests.push({ at: new Date().toISOString(), path: name });
  response.writeHead(200, {
    "Content-Type": types[extname(name)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  createReadStream(join(assetsRoot, name)).pipe(response);
});
await new Promise((yes) => server.listen(0, "127.0.0.1", yes));
const base = `http://127.0.0.1:${server.address().port}/`;
const report = {
  complete: false,
  output,
  input,
  inputSha256: hash(archiveBytes),
  manifestSha256: hash(manifestBytes),
  assetCount: manifest.assets.length,
  utilitySha256: hash(await readFile(new URL(import.meta.url))),
  environment: {
    platform: platform(),
    release: release(),
    node: process.version,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem(),
    started: new Date().toISOString(),
  },
  method: {
    repeats: 3,
    summary: "median and median absolute deviation",
    rssRequestedIntervalMs: 100,
    heapRequestedIntervalMs: 250,
    boundaries:
      "Additional RSS samples immediately before and after each action capture short retained states. Phase duration includes sampling overhead; actionDurationMs excludes the boundary samples.",
    baselineDurationMs: 1000,
    baseline: "median samples after setup/reload; no forced GC",
    metric:
      "Sum of OS resident set sizes of renderer PIDs reported by this fresh browser process; per-PID values retained. RSS is not unique physical memory and may include shared pages.",
    peak: "Maximum observed sample per named phase, not guaranteed true high-water mark. CDP heap measurements are separate and may be delayed while the renderer is busy.",
    comparison:
      "Absolute costs of realistic n01/one-inserted and n16/sixteen-inserted machines, not an isolated causal count experiment.",
    scope:
      "Local headless Chromium, not ESP32, browser process total, GPU process, or native process memory.",
  },
  workloads: [],
};

async function recorder(browser, page, directory) {
  const session = await browser.newBrowserCDPSession();
  const pageSession = await page.context().newCDPSession(page);
  await pageSession.send("Performance.enable");
  const started = performance.now();
  let phase = "initial",
    stopped = false;
  const samples = [],
    errors = [];
  const file = join(directory, "samples.jsonl");
  const elapsed = () => performance.now() - started;
  const save = async (value) => {
    samples.push(value);
    await appendFile(file, `${JSON.stringify(value)}\n`);
  };
  const loop = async (kind, interval, sample) => {
    while (!stopped) {
      const at = performance.now(),
        samplePhase = phase;
      try {
        const measured = await sample();
        await save({
          kind,
          phase: samplePhase,
          requestedAtMs: at - started,
          completedAtMs: elapsed(),
          ...measured,
        });
      } catch (error) {
        const value = {
          kind,
          phase: samplePhase,
          atMs: elapsed(),
          error: String(error),
        };
        errors.push(value);
        await save(value);
      }
      await pause(Math.max(0, interval - (performance.now() - at)));
    }
  };
  const sampleRss = async () => {
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    const pids = processInfo
      .filter((p) => p.type === "renderer")
      .map((p) => p.id);
    assert.ok(pids.length, "No observed renderer PIDs");
    const { stdout } = await exec(
      "ps",
      ["-o", "pid=,rss=", "-p", pids.join(",")],
      { timeout: 3000 },
    );
    const processes = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((row) => {
        const [pid, kib] = row.trim().split(/\s+/).map(Number);
        assert.ok(pids.includes(pid) && Number.isFinite(kib));
        return { pid, rssBytes: kib * 1024 };
      });
    return {
      observedPids: pids,
      processes,
      rssBytes: processes.reduce((sum, p) => sum + p.rssBytes, 0),
      sampleEndMs: elapsed(),
      phaseAtCompletion: phase,
    };
  };
  const rss = loop("rss", 100, sampleRss);
  const heap = loop("heap", 250, async () => {
    const { metrics } = await pageSession.send("Performance.getMetrics");
    return {
      metrics: Object.fromEntries(
        metrics
          .filter((m) =>
            [
              "JSHeapUsedSize",
              "JSHeapTotalSize",
              "Nodes",
              "Documents",
            ].includes(m.name),
          )
          .map((m) => [m.name, m.value]),
      ),
      sampleEndMs: elapsed(),
      phaseAtCompletion: phase,
    };
  });
  return {
    samples,
    async phase(name, action) {
      phase = name;
      const begin = elapsed();
      await save({ kind: "phase", phase, event: "begin", atMs: begin });
      const boundary = async (event) => {
        const requestedAtMs = elapsed();
        const measured = await sampleRss();
        await save({
          kind: "rss",
          phase,
          boundary: event,
          requestedAtMs,
          completedAtMs: elapsed(),
          ...measured,
        });
      };
      await boundary("before-action");
      await save({
        kind: "phase",
        phase,
        event: "action-start",
        atMs: elapsed(),
      });
      const value = await action();
      await save({
        kind: "phase",
        phase,
        event: "action-end",
        atMs: elapsed(),
      });
      await boundary("after-action");
      await save({ kind: "phase", phase, event: "end", atMs: elapsed() });
      return value;
    },
    async stop() {
      stopped = true;
      await Promise.all([rss, heap]);
      assert.equal(
        errors.length,
        0,
        `Sampler errors: ${JSON.stringify(errors)}`,
      );
    },
  };
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};
const statistics = (values) => {
  assert.ok(values.length);
  const value = median(values);
  return {
    median: value,
    mad: median(values.map((x) => Math.abs(x - value))),
    samples: values,
  };
};
function phaseSummary(samples) {
  const names = [
    ...new Set(samples.filter((s) => s.kind === "phase").map((s) => s.phase)),
  ];
  return Object.fromEntries(
    names.map((name) => {
      const times = samples.filter(
        (s) => s.kind === "phase" && s.phase === name,
      );
      const rows = samples.filter(
        (s) =>
          s.kind === "rss" &&
          s.phase === name &&
          s.phaseAtCompletion === name &&
          s.requestedAtMs >= times[0].atMs &&
          s.completedAtMs <= times.at(-1).atMs &&
          !s.error,
      );
      return [
        name,
        {
          rssSampleCount: rows.length,
          medianRssBytes: rows.length
            ? median(rows.map((s) => s.rssBytes))
            : null,
          sampledPeakRssBytes: rows.length
            ? Math.max(...rows.map((s) => s.rssBytes))
            : null,
          durationMs: times.at(-1).atMs - times[0].atMs,
          actionDurationMs:
            times.find((s) => s.event === "action-end").atMs -
            times.find((s) => s.event === "action-start").atMs,
          maxObservedIntervalMs:
            rows.length > 1
              ? Math.max(
                  ...rows
                    .slice(1)
                    .map((s, i) => s.sampleEndMs - rows[i].sampleEndMs),
                )
              : null,
        },
      ];
    }),
  );
}
async function withBrowser(label, action) {
  const directory = join(output, label);
  await mkdir(directory);
  const browser = await chromium.launch({ headless: true });
  report.environment.chromium = browser.version();
  report.environment.chromiumExecutable = chromium.executablePath();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  page.setDefaultTimeout(60000);
  let recording;
  try {
    recording = await recorder(browser, page, directory);
    return await action(page, recording, directory);
  } finally {
    try {
      if (recording) await recording.stop();
    } finally {
      await browser.close();
    }
  }
}
async function manage(page) {
  if (!(await page.locator("#files-dialog").isVisible()))
    await page.locator("#files").click();
  await page.locator("#saved-and-exited").check();
  await page.locator("#begin-management").click();
  await expect(page.locator("#file-import")).toBeEnabled();
}
async function apply(page) {
  await page.locator("#commit-disk").click();
  await expect(page.locator("#files-status")).toContainText("Disk committed");
  await expect(page.locator("#terminal")).toContainText("A>");
}

try {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  report.calibration = await withBrowser("calibration", async (page, meter) => {
    await page.goto("about:blank");
    // Separate process, no calibration allocation remains in measured workloads.
    await meter.phase("calibration-baseline", () => pause(1000));
    await meter.phase("calibration-touched", async () => {
      await page.evaluate(() => {
        globalThis.memoryRuler = new Uint8Array(192 * 1024 * 1024);
        for (let index = 0; index < memoryRuler.length; index += 4096)
          memoryRuler[index] = 1;
      });
      await pause(1500);
    });
    const phases = phaseSummary(meter.samples);
    const rise =
      phases["calibration-touched"].medianRssBytes -
      phases["calibration-baseline"].medianRssBytes;
    assert.ok(
      rise > 96 * 1024 * 1024,
      `RSS ruler did not respond to 192 MiB touched buffer: ${rise}`,
    );
    return {
      touchedBytes: 192 * 1024 * 1024,
      medianRssRiseBytes: rise,
      phases,
    };
  });
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  const one = (
    await prepareTwoMibConfiguration({
      snapshot: copySavedMachine(original),
      configuredCount: 1,
      deployment: manifest,
      baseUrl: base,
    })
  ).snapshot;
  const onePath = join(output, "n01-one-medium.tds");
  await writeFile(onePath, await encodeSavedMachine(one), { flag: "wx" });
  for (let repeat = 1; repeat <= 3; repeat++) {
    for (const [count, snapshot, source] of [
      [1, one, onePath],
      [16, original, input],
    ]) {
      const result = await withBrowser(
        `run-${repeat}-n${count}`,
        async (page, meter, directory) => {
          const selected = count === 16 ? "P" : "A";
          await meter.phase("setup-restore", async () => {
            await page.goto(base);
            await expect(page.locator("#status")).toHaveAttribute(
              "data-state",
              "running",
            );
            await manage(page);
            await page.locator("#drive-set-input").setInputFiles(source);
            await expect(page.locator("#files-status")).toContainText(
              "Complete drive set staged",
            );
            await apply(page);
            await page.reload();
            await expect(page.locator("#status")).toHaveAttribute(
              "data-state",
              "running",
            );
            await expect(page.locator("#terminal")).toContainText("A>");
          });
          await meter.phase("baseline", () => pause(1000));
          await meter.phase("enter-management", () => manage(page));
          await meter.phase("stage-import", async () => {
            await page.locator("#file-drive").selectOption(selected);
            await page.locator("#file-import").setInputFiles({
              name: "MEMPROBE.TXT",
              mimeType: "text/plain",
              buffer: Buffer.from(`Memory measurement n${count}\r\n`),
            });
            await expect(page.locator("#files-status")).toContainText(
              "Staged MEMPROBE.TXT",
            );
          });
          await meter.phase("apply-reboot", () => apply(page));
          const downloaded = join(directory, "after-import.tds");
          await meter.phase("archive-download", async () => {
            await page.locator("#close-files").click();
            const [download] = await Promise.all([
              page.waitForEvent("download"),
              page.locator("#download-set").click(),
            ]);
            await download.saveAs(downloaded);
          });
          await meter.phase("reload-read", async () => {
            await page.reload();
            await expect(page.locator("#status")).toHaveAttribute(
              "data-state",
              "running",
            );
            await expect(page.locator("#terminal")).toContainText("A>");
            await page.locator("#terminal").focus();
            await page.keyboard.type(`TYPE ${selected}:MEMPROBE.TXT`);
            await page.keyboard.press("Enter");
            await expect(page.locator("#terminal")).toContainText(
              `Memory measurement n${count}`,
            );
          });
          await meter.phase("settled-after-reload", () => pause(1000));
          const archived = await decodeSavedMachineArchive(
            await readFile(downloaded),
          );
          assert.equal(archived.configuredCount, count);
          assert.deepEqual(archived.bootstrap, snapshot.bootstrap);
          for (let index = 0; index < count; index++) {
            assert.equal(
              archived.slots[index].instanceId,
              snapshot.slots[index].instanceId,
            );
            assert.equal(
              archived.slots[index].name,
              snapshot.slots[index].name,
            );
            assert.equal(archived.slots[index].bytes.length, 2097152);
            assert.deepEqual(
              archived.slots[index].bytes.subarray(0, 16384),
              snapshot.slots[index].bytes.subarray(0, 16384),
            );
            if (index !== count - 1)
              assert.deepEqual(
                archived.slots[index].bytes,
                snapshot.slots[index].bytes,
              );
          }
          return {
            repeat,
            configuredCount: count,
            insertedMedia: count,
            selectedDrive: selected,
            phases: phaseSummary(meter.samples),
            sourceArchive: source,
            downloaded,
            archiveBytes: (await readFile(downloaded)).length,
            correctness:
              "Reloaded guest reads imported sentinel; IDs, names, count, bootstrap/reserved bytes and all unrelated media preserved.",
            samples: join(directory, "samples.jsonl"),
          };
        },
      );
      report.workloads.push(result);
      await writeFile(
        join(output, "report.json"),
        JSON.stringify(report, null, 2),
      );
      console.log(
        `Measured run ${repeat}/3, n${count}: ${result.phases["apply-reboot"].sampledPeakRssBytes} bytes sampled apply peak`,
      );
    }
  }
  report.summary = Object.fromEntries(
    [1, 16].map((count) => {
      const runs = report.workloads.filter((r) => r.configuredCount === count);
      return [
        String(count),
        Object.fromEntries(
          Object.keys(runs[0].phases).map((phase) => [
            phase,
            {
              sampledPeakRssBytes: statistics(
                runs
                  .map((r) => r.phases[phase].sampledPeakRssBytes)
                  .filter((v) => v !== null),
              ),
              medianRssBytes: statistics(
                runs
                  .map((r) => r.phases[phase].medianRssBytes)
                  .filter((v) => v !== null),
              ),
              durationMs: statistics(
                runs.map((r) => r.phases[phase].durationMs),
              ),
            },
          ]),
        ),
      ];
    }),
  );
  assert.equal(hash(await readFile(input)), report.inputSha256);
  assert.equal(
    hash(await readFile(join(assetsRoot, "deployment-manifest.json"))),
    report.manifestSha256,
  );
  for (const asset of manifest.assets)
    assert.equal(
      hash(await readFile(join(assetsRoot, asset.path))),
      asset.sha256,
    );
  report.complete = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(
    join(output, "requests.json"),
    JSON.stringify(requests, null, 2),
  );
  await new Promise((yes) => server.close(yes));
}
