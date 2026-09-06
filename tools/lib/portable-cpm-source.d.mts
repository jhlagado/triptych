export function preparePortableCpmSource(
  repositoryRoot: string,
  id: "ccp" | "bdos",
  targetProfile?: "triptych-cpu-v0.1" | "triptych-cpu-v0.1-8m-ab",
): Promise<string>;
export function assemblePortableCpmSource(
  repositoryRoot: string,
  id: "ccp" | "bdos",
  targetProfile?: "triptych-cpu-v0.1" | "triptych-cpu-v0.1-8m-ab",
): Promise<{
  bytes: Uint8Array;
  labels: Readonly<Record<string, number>>;
  base: number;
}>;
export function portableCpmBinary(
  repositoryRoot: string,
  id: "ccp" | "bdos",
  targetProfile?: "triptych-cpu-v0.1" | "triptych-cpu-v0.1-8m-ab",
): Promise<Uint8Array>;
