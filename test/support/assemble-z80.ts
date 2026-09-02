import { compile, defaultFormatWriters } from "@jhlagado/azm/compile";

/** Assemble host-test Z80 source without making AZM a production dependency. */
export async function assembleZ80ForTest(source: string): Promise<Uint8Array> {
  const result = await compile(
    source,
    {
      emitBin: true,
      emitHex: false,
      emitD8m: false,
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
  return Uint8Array.from(binary.bytes);
}
