import { createZ80Runtime } from "@jhlagado/z80-runtime/z80/runtime";
import type {
  CpuStateSnapshot,
  IoHandlers as Z80IoHandlers,
  Z80Runtime,
} from "@jhlagado/z80-runtime/z80/runtime";
import type {
  CreateZ80HostRuntime,
  Z80HostRuntime,
} from "../../src/shared/z80.js";

/** CPU-only test adapter for parity between the JS runtime and Triptych. */
export const createZ80TestRuntime: CreateZ80HostRuntime = (
  ioHandlers: Z80IoHandlers,
): Z80HostRuntime =>
  createZ80Runtime(
    { memory: new Uint8Array(0x10000), startAddress: 0 },
    0,
    ioHandlers,
  );

export interface Z80TestHarness {
  createRuntime: CreateZ80HostRuntime;
  runtime(): Z80Runtime;
  captureCpuState(): CpuStateSnapshot;
}

/** Keeps the generic CPU oracle separate from the legacy Debug80 adapter. */
export function createZ80TestHarness(options?: {
  tick?: Z80IoHandlers["tick"];
}): Z80TestHarness {
  let activeRuntime: Z80Runtime | undefined;

  const runtime = (): Z80Runtime => {
    if (activeRuntime === undefined) {
      throw new Error("Z80 test runtime has not been created");
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
