export const WORKING_DISK_SCHEMA = "triptych-working-disk-v1";

const DATABASE_NAME = "triptych-cpu";
const DATABASE_VERSION = 1;
const OBJECT_STORE = "working-disks";
const DRIVE_A_KEY = "drive-a";

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("Disk transaction aborted.")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("Disk transaction failed.")),
      { once: true },
    );
  });
}

function copyBytes(value) {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  throw new Error("Saved working disk contains invalid bytes.");
}

export function validateWorkingDiskRecord(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Saved working disk is invalid.");
  }
  if (value.schema !== WORKING_DISK_SCHEMA || value.key !== DRIVE_A_KEY) {
    throw new Error("Saved working disk has an unsupported format.");
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Error("Saved working disk has no name.");
  }
  const bytes = copyBytes(value.bytes);
  if (bytes.length === 0 || bytes.length % 512 !== 0) {
    throw new Error("Saved working disk has an invalid byte length.");
  }
  return { name: value.name, bytes };
}

export async function openWorkingDiskStore(indexedDB = globalThis.indexedDB) {
  if (indexedDB === undefined) {
    throw new Error("This browser does not provide IndexedDB storage.");
  }
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(OBJECT_STORE)) {
      database.createObjectStore(OBJECT_STORE, { keyPath: "key" });
    }
  });
  const database = await requestResult(request);

  return {
    async load() {
      const transaction = database.transaction(OBJECT_STORE, "readonly");
      const complete = transactionComplete(transaction);
      const result = await requestResult(
        transaction.objectStore(OBJECT_STORE).get(DRIVE_A_KEY),
      );
      await complete;
      return validateWorkingDiskRecord(result);
    },

    async save({ name, bytes }) {
      const record = validateWorkingDiskRecord({
        schema: WORKING_DISK_SCHEMA,
        key: DRIVE_A_KEY,
        name,
        bytes,
      });
      const transaction = database.transaction(OBJECT_STORE, "readwrite");
      const complete = transactionComplete(transaction);
      await requestResult(
        transaction.objectStore(OBJECT_STORE).put({
          schema: WORKING_DISK_SCHEMA,
          key: DRIVE_A_KEY,
          name: record.name,
          bytes: record.bytes,
        }),
      );
      await complete;
    },

    async clear() {
      const transaction = database.transaction(OBJECT_STORE, "readwrite");
      const complete = transactionComplete(transaction);
      await requestResult(
        transaction.objectStore(OBJECT_STORE).delete(DRIVE_A_KEY),
      );
      await complete;
    },

    close() {
      database.close();
    },
  };
}
