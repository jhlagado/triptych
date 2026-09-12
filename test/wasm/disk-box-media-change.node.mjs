import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { prepareSavedMachineAdoption } from "../../crates/triptych-host-wasm/web/disk-box-adoption.js";
import { prepareDiskBoxMediaChange } from "../../crates/triptych-host-wasm/web/disk-box-media-change.js";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function setup() {
  const original = new Uint8Array(2097152).fill(7);
  const { manifest } = await prepareSavedMachineAdoption(
    {
      schema: "triptych-drive-set-v4",
      configuredCount: 2,
      bootstrap: {
        profile: "triptych-cpu-v0.1-2m-n02",
        bytes: new Uint8Array(256),
      },
      slots: [1, 2].map((n) => ({
        instanceId: id(n),
        name: `Disk ${n}`,
        bytes: original,
      })),
    },
    { configurationId: id(3), name: "Machine", crypto: webcrypto },
  );
  const events = [];
  let owner = true,
    pending = false;
  const cpu = {
    disk_management_ready: () => true,
    prepare_drive_change(slot, bytes, writable) {
      events.push(["prepare", slot, writable, bytes[0]]);
      pending = true;
      return 9;
    },
    prepare_drive_eject(slot) {
      events.push(["eject", slot]);
      pending = true;
      return 9;
    },
    export_drive_checkpoint(slot) {
      assert.equal(pending, true);
      events.push(["checkpoint", slot]);
      return original;
    },
    cancel_media_change(ticket) {
      assert.equal(ticket, 9);
      events.push(["cancel"]);
      pending = false;
      return true;
    },
    commit_media_change(ticket) {
      assert.equal(ticket, 9);
      events.push(["commit"]);
      pending = false;
      return true;
    },
  };
  const token = { kind: "disk-box", revision: 1, digest: "a".repeat(64) };
  const store = {
    async commitChange(expected, operation, candidate, blobs) {
      assert.equal(pending, true);
      assert.deepEqual(expected, token);
      assert.equal(operation, "swap-1");
      assert.equal(candidate.personalDisks.length, 2); // ejected B remains in box
      events.push([
        "persist",
        candidate.configurations[0].slots[1],
        blobs.size,
      ]);
      return {
        status: "committed",
        token: { ...token, revision: 2 },
        receipt: { operationId: operation },
      };
    },
  };
  const binding = {
    kind: "published",
    image: {
      id: "game",
      revision: "v1",
      name: "Game",
      geometry: "triptych-cpm-2m-v1",
      ...manifest.personalDisks[0].content,
      url: "https://example.test/game.img",
      source: "https://example.test/source",
      license: "MIT",
      systemProfile: null,
    },
  };
  const options = {
    manifest,
    token,
    configurationId: id(3),
    slot: 1,
    binding,
    incomingBytes: original,
    cpu,
    store,
    lease: { isOwner: () => owner },
    pause: () => events.push(["pause"]),
    resume: () => events.push(["resume"]),
    onCommitted: () => events.push(["metadata"]),
    crypto: webcrypto,
    operationId: "swap-1",
  };
  return {
    options,
    events,
    owner: (value) => (owner = value),
    pending: () => pending,
  };
}
test("live change freezes, preserves outgoing disks, publishes before switching and resumes last", async () => {
  const { options, events, pending } = await setup();
  const session = await prepareDiskBoxMediaChange(options);
  assert.equal(session.status, "prepared");
  assert.equal(pending(), true);
  assert.deepEqual(
    events.map((e) => e[0]),
    ["pause", "prepare", "checkpoint", "checkpoint"],
  );
  assert.equal(events[1][2], false); // public image is protected even for writer
  await session.commit();
  assert.equal(session.status, "committed");
  assert.deepEqual(
    events.map((e) => e[0]),
    [
      "pause",
      "prepare",
      "checkpoint",
      "checkpoint",
      "persist",
      "commit",
      "metadata",
      "resume",
    ],
  );
});
test("publication response loss retains freeze and retries exactly without cancellation", async () => {
  const { options, events, pending } = await setup();
  const publish = options.store.commitChange;
  let calls = 0;
  options.store.commitChange = async (...args) => {
    const result = await publish(...args);
    if (++calls === 1) throw new Error("lost response");
    return result;
  };
  const session = await prepareDiskBoxMediaChange(options);
  await assert.rejects(session.commit(), /lost response/);
  assert.equal(session.status, "uncertain");
  assert.equal(pending(), true);
  assert.throws(() => session.cancel(), /unsafe/);
  assert.equal(
    events.some((e) => e[0] === "resume"),
    false,
  );
  await session.commit();
  assert.equal(session.status, "committed");
});
test("cancellation is available only before publication", async () => {
  const { options, events } = await setup();
  const session = await prepareDiskBoxMediaChange(options);
  session.cancel();
  assert.equal(session.status, "cancelled");
  assert.deepEqual(events.slice(-2), [["cancel"], ["resume"]]);
  await assert.rejects(session.commit(), /current state/);
});
test("unready guest and invalid image cannot publish or replace backing", async () => {
  const { options, events } = await setup();
  options.incomingBytes = new Uint8Array(2097152);
  await assert.rejects(prepareDiskBoxMediaChange(options), /hash/);
  assert.equal(events.length, 0);
  options.incomingBytes = new Uint8Array(2097152).fill(7);
  options.cpu.disk_management_ready = () => false;
  await assert.rejects(prepareDiskBoxMediaChange(options), /pending/);
  assert.deepEqual(events, [["pause"], ["resume"]]);
});
for (const outcome of [
  "superseded",
  "lost-owner",
  "bad-ticket",
  "ticket-throws",
  "metadata-error",
])
  test(`${outcome} after publication requires recovery without resuming`, async () => {
    const { options, events, owner } = await setup();
    const original = options.store.commitChange;
    options.store.commitChange = async (...args) => {
      const result = await original(...args);
      if (outcome === "superseded") result.status = "superseded";
      if (outcome === "lost-owner") owner(false);
      return result;
    };
    if (outcome === "bad-ticket") options.cpu.commit_media_change = () => false;
    if (outcome === "ticket-throws")
      options.cpu.commit_media_change = () => {
        throw new Error("ticket failure");
      };
    if (outcome === "metadata-error")
      options.onCommitted = () => {
        throw new Error("metadata failed");
      };
    const session = await prepareDiskBoxMediaChange(options);
    await assert.rejects(session.commit());
    assert.equal(session.status, "recovery");
    assert.equal(
      events.some((e) => e[0] === "resume"),
      false,
    );
  });
test("eject preserves personal identity and skips protected checkpoint exports", async () => {
  const { options, events } = await setup();
  options.manifest.configurations[0].slots[0].writable = false;
  options.binding = null;
  options.incomingBytes = undefined;
  const session = await prepareDiskBoxMediaChange(options);
  await session.commit();
  assert.deepEqual(
    events.filter((e) => e[0] === "checkpoint"),
    [["checkpoint", 1]],
  );
  assert.equal(events.find((e) => e[0] === "persist")[1], null);
});
