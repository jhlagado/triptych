import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  await page.route("**/saved-machine-workspace-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Disposable coordinator integration</title>",
    }),
  );
  for (const file of [
    "disk-workspace.js",
    "saved-machine-workspace.js",
    "saved-machine-store.js",
    "saved-machine.js",
    "drive-set-v4.js",
    "drive-set.js",
    "drive-set-store.js",
    "working-disk-store.js",
  ]) {
    const body = await readFile(
      new URL(
        `../../../crates/triptych-host-wasm/web/${file}`,
        import.meta.url,
      ),
      "utf8",
    );
    await page.route(`**/${file}`, (route) =>
      route.fulfill({ contentType: "text/javascript", body }),
    );
  }
  await page.goto("/saved-machine-workspace-test");
});

test("real IndexedDB promotes a legacy checkpoint with backup, then commits and reopens exact media", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  expect(
    await page.evaluate(async () => {
      const { openDriveSetStore } = await import("/drive-set-store.js");
      const { openSavedMachineStore } = await import("/saved-machine-store.js");
      const { createSavedMachineWorkspace } =
        await import("/saved-machine-workspace.js");
      const { acquireDiskWriter } = await import("/disk-workspace.js");
      const { copySavedMachine, sameSavedMachine } =
        await import("/saved-machine.js");
      const name = `coordinator-${crypto.randomUUID()}`,
        boot = new Uint8Array(256).fill(42);
      const disk = (byte) => ({
        bootstrap: { profile: "legacy-e400", bytes: boot },
        drives: {
          A: { name: "work.img", bytes: new Uint8Array(512).fill(byte) },
          B: null,
        },
      });
      const old = await openDriveSetStore({ name, legacyBootstrap: boot });
      await old.saveCheckpoint({ kind: "empty" }, disk(7));
      old.close();
      const store = await openSavedMachineStore({
          name,
          legacyBootstrap: boot,
        }),
        loaded = await store.load();
      const writer = await acquireDiskWriter({ name: `${name}:writer` });
      let guest = disk(8),
        activated = 0;
      const workspace = createSavedMachineWorkspace({
        store,
        writer,
        token: loaded.token,
        operationId: () => "edit",
        runtime: {
          pause() {},
          resume() {},
          ready: () => true,
          checkpoint: () => copySavedMachine(guest),
          prepare: async (snapshot) => ({ snapshot }),
          activate(prepared) {
            guest = prepared.snapshot;
            activated++;
          },
          discard() {},
        },
      });
      try {
        const saved = await workspace.saveCheckpoint(guest);
        const predecessor = await store.readBackup("v4:checkpoint:2");
        const session = await workspace.beginManagement({
          savedAndExited: true,
        });
        workspace.stage(session, disk(9));
        const publication = await workspace.commit(session);
        const backup = await store.readBackup("v4:edit"),
          rawOld = await store.readRawRecovery("drive-set-state", "head");
        await workspace.close();
        store.close();
        const reopened = await openSavedMachineStore({
            name,
            legacyBootstrap: boot,
          }),
          head = await reopened.load();
        reopened.close();
        return {
          historical: loaded.token.kind,
          source: loaded.token.store,
          promoted: saved.token.kind,
          predecessor: sameSavedMachine(predecessor, disk(7)),
          backup: sameSavedMachine(backup, disk(8)),
          exact: sameSavedMachine(head.snapshot, disk(9)),
          receipt: publication.receipt.authority,
          tokenMatch:
            JSON.stringify(head.token) === JSON.stringify(publication.token),
          oldRevision: rawOld.revision,
          activated,
        };
      } finally {
        await workspace.close();
        store.close();
        await writer.release();
      }
    }),
  ).toEqual({
    historical: "historical",
    source: "drive-set-state",
    promoted: "v4",
    predecessor: true,
    backup: true,
    exact: true,
    receipt: "v4",
    tokenMatch: true,
    oldRevision: 1,
    activated: 1,
  });
  expect(errors).toEqual([]);
});

test("real storage plus sparse A/P coordinator rejects a valid stale receipt before activation", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  expect(
    await page.evaluate(async () => {
      const { openSavedMachineStore } = await import("/saved-machine-store.js");
      const { createSavedMachineWorkspace } =
        await import("/saved-machine-workspace.js");
      const { copySavedMachine } = await import("/saved-machine.js");
      const snapshot = (byte) => ({
        schema: "triptych-drive-set-v4",
        configuredCount: 16,
        bootstrap: {
          profile: "triptych-cpu-v0.1-2m-n16",
          bytes: new Uint8Array(256).fill(42),
        },
        slots: Array.from({ length: 16 }, (_, i) =>
          i !== 0 && i !== 15
            ? null
            : {
                instanceId: `550e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`,
                name: `${i}.img`,
                bytes: new Uint8Array(2097152).fill(byte + i),
              },
        ),
      });
      const store = await openSavedMachineStore({
          name: `sparse-${crypto.randomUUID()}`,
        }),
        initial = snapshot(1);
      const first = await store.saveCheckpoint({ kind: "empty" }, initial);
      let activated = 0,
        discarded = 0;
      // Deliberate runtime double: this tests coordinator/storage ordering, not
      // released-profile admission or execution of these synthetic system bytes.
      const adapter = {
        load: () => store.load(),
        saveCheckpoint: (...args) => store.saveCheckpoint(...args),
        async commitChange(...args) {
          const prior = await store.commitChange(...args);
          await store.saveCheckpoint(prior.token, snapshot(9));
          return prior;
        },
      };
      const workspace = createSavedMachineWorkspace({
        store: adapter,
        writer: { owned: true },
        token: first.token,
        operationId: () => "stale",
        runtime: {
          pause() {},
          resume() {},
          ready: () => true,
          checkpoint: () => copySavedMachine(initial),
          prepare: async (snapshot) => ({ snapshot }),
          activate() {
            activated++;
          },
          discard() {
            discarded++;
          },
        },
      });
      try {
        const session = await workspace.beginManagement({
          savedAndExited: true,
        });
        workspace.stage(session, snapshot(3));
        const rejected = await workspace.commit(session).then(
          () => false,
          () => true,
        );
        const head = await store.load();
        return {
          rejected,
          state: workspace.state,
          activated,
          discarded,
          revision: head.token.revision,
          p: head.snapshot.slots[15].bytes[2097151],
          count: head.snapshot.configuredCount,
          interior: head.snapshot.slots[7],
        };
      } finally {
        await workspace.close();
        store.close();
      }
    }),
  ).toEqual({
    rejected: true,
    state: "recovery",
    activated: 0,
    discarded: 1,
    revision: 4,
    p: 24,
    count: 16,
    interior: null,
  });
  expect(errors).toEqual([]);
});
