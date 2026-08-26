import { createZ80Runtime } from "@jhlagado/debug80-runtime/z80/runtime";
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
