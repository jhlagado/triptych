/**
 * @file Little-endian register decoding helpers for the ESP32 sound model.
 */

/** Reads an unsigned 16-bit little-endian value. */
export function readUint16(registers: Uint8Array, offset: number): number {
  return (registers[offset] ?? 0) | ((registers[offset + 1] ?? 0) << 8);
}

/** Reads an unsigned 24-bit little-endian value. */
export function readUint24(registers: Uint8Array, offset: number): number {
  return (
    (registers[offset] ?? 0) |
    ((registers[offset + 1] ?? 0) << 8) |
    ((registers[offset + 2] ?? 0) << 16)
  );
}

/** Reads an unsigned 32-bit little-endian value. */
export function readUint32(registers: Uint8Array, offset: number): number {
  return (
    ((registers[offset] ?? 0) |
      ((registers[offset + 1] ?? 0) << 8) |
      ((registers[offset + 2] ?? 0) << 16) |
      ((registers[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/** Replaces one byte in a 24-bit address. */
export function replaceAddressByte(
  address: number,
  byteIndex: number,
  value: number,
): number {
  const shift = byteIndex * 8;
  const mask = 0xff << shift;
  return ((address & ~mask) | ((value & 0xff) << shift)) & 0xff_ffff;
}
