/** Host interfaces used by the transport-neutral Triptych reference models. */

export interface Z80IoHandlers {
  read?: (port: number) => number;
  write?: (port: number, value: number) => void;
}

export interface Z80HostHardware {
  memory: Uint8Array;
  ioRead(port: number): number;
  ioWrite(port: number, value: number): void;
  memRead?: (address: number) => number;
  memWrite?: (address: number, value: number) => void;
  forceMemWrite?: (address: number, value: number) => void;
  isMemoryWritable?: (address: number) => boolean;
}

export interface Z80HostRuntime {
  hardware: Z80HostHardware;
  step(): { cycles?: number };
  reset(): void;
  isHalted(): boolean;
  getPC(): number;
  getRegisters(): { a: number };
}

export type CreateZ80HostRuntime = (
  ioHandlers: Z80IoHandlers,
) => Z80HostRuntime;
