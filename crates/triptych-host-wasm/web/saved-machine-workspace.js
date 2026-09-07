import { copySavedMachine, sameSavedMachine } from "./saved-machine.js";
import { createWorkspaceCoordinator } from "./disk-workspace.js";

function fields(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw new Error("Invalid saved-machine record fields.");
}
const hashValue = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function savedToken(value) {
  if (value?.kind === "empty") {
    fields(value, ["kind"]);
    return { kind: "empty" };
  }
  if (value?.kind === "historical") {
    fields(value, ["kind", "store", "identity"]);
    if (
      !["drive-set-state", "disk-revisions", "working-disks"].includes(
        value.store,
      ) ||
      !hashValue(value.identity)
    )
      throw new Error("Invalid historical saved-machine token.");
    return { kind: "historical", store: value.store, identity: value.identity };
  }
  fields(value, ["kind", "revision", "digest"]);
  if (
    value.kind !== "v4" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !hashValue(value.digest)
  )
    throw new Error("Invalid saved-machine token.");
  return { kind: "v4", revision: value.revision, digest: value.digest };
}
function savedReceipt(value) {
  fields(value, ["authority", "revision", "operationId", "digest"]);
  if (value.authority !== "v4")
    throw new Error("Invalid saved-machine receipt authority.");
  savedToken({ kind: "v4", revision: value.revision, digest: value.digest });
  if (
    typeof value.operationId !== "string" ||
    !value.operationId ||
    value.operationId.length > 256
  )
    throw new Error("Invalid saved-machine receipt identity.");
  return {
    authority: "v4",
    revision: value.revision,
    operationId: value.operationId,
    digest: value.digest,
  };
}
function savedPublication(value) {
  fields(value, ["token", "receipt"]);
  const token = savedToken(value.token),
    receipt = savedReceipt(value.receipt);
  if (
    token.kind !== "v4" ||
    token.revision !== receipt.revision ||
    token.digest !== receipt.digest
  )
    throw new Error("Saved-machine publication token and receipt disagree.");
  return { token, receipt };
}
function savedMachineHead(value) {
  if (value?.kind !== "ready")
    throw new Error("A valid saved machine is required for recovery.");
  const token = savedToken(value.token);
  if (token.kind === "empty")
    throw new Error("An empty token is not a saved machine.");
  let receipt;
  if (token.kind === "v4")
    receipt = savedPublication({ token, receipt: value.receipt }).receipt;
  else if (value.receipt !== undefined)
    throw new Error("Historical authority cannot carry a v4 receipt.");
  return { token, receipt, snapshot: copySavedMachine(value.snapshot) };
}

const SAVED_PROTOCOL = {
  copySnapshot: copySavedMachine,
  sameSnapshot: sameSavedMachine,
  copyToken: savedToken,
  copyReceipt: savedReceipt,
  savedHead: savedMachineHead,
  publication: savedPublication,
  checkpointResult: (publication) => ({
    kind: "saved",
    ...savedPublication(publication),
  }),
  commitResult: savedPublication,
  captureAfterDrain: true,
};

/** Saved-machine authority coordinator. The caller admits the initial runtime
 * before construction; runtime.prepare must reject unsupported candidates before
 * publication. Structural snapshot validation is not execution admission. */
export function createSavedMachineWorkspace(options) {
  return createWorkspaceCoordinator(options, SAVED_PROTOCOL);
}
