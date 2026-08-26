/**
 * @file Public types for the experimental ESP32 sound reference model.
 */

import type { Z80IoHandlers } from "../shared/z80.js";

export type Esp32SoundEnvelopeStage =
  "idle" | "attack" | "decay" | "sustain" | "release";

export interface Esp32SoundStereoBlock {
  sampleRate: number;
  frames: number;
  /** Signed 16-bit samples in left, right interleaved order. */
  samples: Int16Array;
}

export interface Esp32SoundSynthVoiceSnapshot {
  phase: number;
  phaseIncrement: number;
  pulseWidth: number;
  enabled: boolean;
  gate: boolean;
  waveform: number;
  envelopeStage: Esp32SoundEnvelopeStage;
  envelopeLevel: number;
  volume: number;
  pan: number;
  noiseState: number;
}

export interface Esp32SoundPcmVoiceSnapshot {
  enabled: boolean;
  looping: boolean;
  signedSamples: boolean;
  start: number;
  loop: number;
  end: number;
  phaseIncrement: number;
  address: number;
  fraction: number;
  volume: number;
  pan: number;
}

export interface Esp32SoundSnapshot {
  status: number;
  soundAddress: number;
  selectedRegister: number;
  applyPending: boolean;
  shadowRegisters: Uint8Array;
  activeRegisters: Uint8Array;
  synthVoices: Esp32SoundSynthVoiceSnapshot[];
  pcmVoices: Esp32SoundPcmVoiceSnapshot[];
  soundRam: Uint8Array;
}

export interface Esp32SoundDevice {
  readPort(offset: number): number;
  writePort(offset: number, value: number): void;
  renderBlock(frames: number): Esp32SoundStereoBlock;
  reportUnderrun(): void;
  reset(): void;
  snapshot(): Esp32SoundSnapshot;
}

export interface Esp32SoundDeviceOptions {
  soundRamSize?: number;
}

export interface Esp32SoundIoWindow {
  handlers: Z80IoHandlers;
  basePort: number;
}
