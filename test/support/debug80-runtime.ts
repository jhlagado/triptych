import { createZ80Runtime } from "@jhlagado/debug80-runtime/z80/runtime";
import type {
  CpuStateSnapshot,
  IoHandlers as Debug80IoHandlers,
  Z80Runtime as Debug80Runtime,
} from "@jhlagado/debug80-runtime/z80/runtime";
import type {
  CreateZ80HostRuntime,
  Z80HostRuntime,
  Z80IoHandlers,
} from "../../src/shared/z80.js";

/** Uses Debug80 as an external Z80 test harness; it is not a machine dependency. */
export const createDebug80TestRuntime: CreateZ80HostRuntime = (
  ioHandlers: Z80IoHandlers,
): Z80HostRuntime =>
  createZ80Runtime(
    { memory: new Uint8Array(0x10000), startAddress: 0 },
    0,
    ioHandlers,
  );

export interface Debug80TestHarness {
  createRuntime: CreateZ80HostRuntime;
  runtime(): Debug80Runtime;
  captureCpuState(): CpuStateSnapshot;
}

/** Gives conformance tests access to detached CPU state without widening production APIs. */
export function createDebug80TestHarness(options?: {
  tick?: Debug80IoHandlers["tick"];
}): Debug80TestHarness {
  let activeRuntime: Debug80Runtime | undefined;

  const runtime = (): Debug80Runtime => {
    if (activeRuntime === undefined) {
      throw new Error("Debug80 test runtime has not been created");
    }
    return activeRuntime;
  };

  const createRuntime: CreateZ80HostRuntime = (
    ioHandlers: Z80IoHandlers,
  ): Z80HostRuntime => {
    activeRuntime = createZ80Runtime(
      { memory: new Uint8Array(0x10000), startAddress: 0 },
      0,
      {
        ...ioHandlers,
        ...(options?.tick === undefined ? {} : { tick: options.tick }),
      },
    );
    return activeRuntime;
  };

  return {
    createRuntime,
    runtime,
    captureCpuState: (): CpuStateSnapshot => runtime().captureCpuState(),
  };
}
