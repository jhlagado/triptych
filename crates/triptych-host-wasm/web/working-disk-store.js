// Version-1 record decoder retained only for migration and recovery. All writes
// use the revisioned store and disk coordinator; there is no version-1 writer.
export const WORKING_DISK_SCHEMA = "triptych-working-disk-v1";

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
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Saved working disk is invalid.");
  if (value.schema !== WORKING_DISK_SCHEMA || value.key !== "drive-a")
    throw new Error("Saved working disk has an unsupported format.");
  if (typeof value.name !== "string" || value.name.length === 0)
    throw new Error("Saved working disk has no name.");
  const bytes = copyBytes(value.bytes);
  if (!bytes.length || bytes.length % 512 !== 0)
    throw new Error("Saved working disk has an invalid byte length.");
  return { name: value.name, bytes };
}
