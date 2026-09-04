export function assembleAtomFile(source: string): Promise<{
  bytes: Uint8Array;
  labels: Readonly<Record<string, number>>;
  base: number;
}>;
export function assembleAtomBinary(source: string): Promise<Uint8Array>;
