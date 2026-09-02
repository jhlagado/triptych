import { compile, defaultFormatWriters } from "@jhlagado/azm/compile";

export interface AssembledZ80ForTest {
  bytes: Uint8Array;
  labels: Readonly<Record<string, number>>;
}

/** Assemble host-test Z80 source and retain labels for memory-boundary proofs. */
export async function assembleZ80WithLabelsForTest(
  source: string,
): Promise<AssembledZ80ForTest> {
  const result = await compile(
    source,
    {
      emitBin: true,
      emitHex: false,
      emitD8m: true,
      emitLst: false,
      emitAsm80: false,
      registerContracts: "off",
      registerContractsInterfaces: [],
    },
    { formats: defaultFormatWriters },
  );
  const errors = result.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (errors.length > 0) {
    throw new Error(
      errors
        .map(
          (diagnostic) =>
            `${diagnostic.sourceName}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`,
        )
        .join("\n"),
    );
  }
  const binary = result.artifacts.find((artifact) => artifact.kind === "bin");
  if (binary?.kind !== "bin") {
    throw new Error(`AZM did not emit a binary for ${source}`);
  }
  const debugMap = result.artifacts.find((artifact) => artifact.kind === "d8m");
  if (debugMap?.kind !== "d8m") {
    throw new Error(`AZM did not emit a debug map for ${source}`);
  }
  const labels = Object.fromEntries(
    debugMap.json.symbols.flatMap((symbol) =>
      symbol.kind === "label" && symbol.address !== undefined
        ? [[symbol.name, symbol.address] as const]
        : [],
    ),
  );
  return { bytes: Uint8Array.from(binary.bytes), labels };
}

/** Assemble host-test Z80 source without making AZM a production dependency. */
export async function assembleZ80ForTest(source: string): Promise<Uint8Array> {
  return (await assembleZ80WithLabelsForTest(source)).bytes;
}
