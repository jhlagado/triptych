export function preparePortableCpmSource(
  repositoryRoot: string,
  id: "ccp" | "bdos",
): Promise<string>;
export function assemblePortableCpmSource(
  repositoryRoot: string,
  id: "ccp" | "bdos",
): Promise<{
  bytes: Uint8Array;
  labels: Readonly<Record<string, number>>;
  base: number;
}>;
export function portableCpmBinary(
  repositoryRoot: string,
  id: "ccp" | "bdos",
): Promise<Uint8Array>;
