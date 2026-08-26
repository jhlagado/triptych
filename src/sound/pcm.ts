/**
 * @file Byte-addressed PCM playback for the ESP32 sound reference model.
 */

import {
  ESP32_SOUND_PCM_CONTROL,
  ESP32_SOUND_PCM_REGISTER,
} from "./constants.js";
import { readUint24, readUint32 } from "./registers.js";
import type { Esp32SoundPcmVoiceSnapshot } from "./types.js";

export interface PcmVoiceState {
  programmedEnabled: boolean;
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

export interface PcmRenderResult {
  sample: number;
  completed: boolean;
}

/** Creates a reset, silent PCM voice. */
export function createPcmVoice(): PcmVoiceState {
  return {
    programmedEnabled: false,
    enabled: false,
    looping: false,
    signedSamples: false,
    start: 0,
    loop: 0,
    end: 0,
    phaseIncrement: 0,
    address: 0,
    fraction: 0,
    volume: 0,
    pan: 0x80,
  };
}

/** Publishes one 16-byte shadow bank into a PCM channel at a block boundary. */
export function applyPcmRegisters(
  voice: PcmVoiceState,
  registers: Uint8Array,
  base: number,
): void {
  const control = registers[base + ESP32_SOUND_PCM_REGISTER.control] ?? 0;
  const nextEnabled = (control & ESP32_SOUND_PCM_CONTROL.enabled) !== 0;
  const nextStart = readUint24(
    registers,
    base + ESP32_SOUND_PCM_REGISTER.start0,
  );
  const nextLoop = readUint24(registers, base + ESP32_SOUND_PCM_REGISTER.loop0);
  const nextEnd = readUint24(registers, base + ESP32_SOUND_PCM_REGISTER.end0);
  const nextIncrement = readUint32(
    registers,
    base + ESP32_SOUND_PCM_REGISTER.phaseIncrement0,
  );
  const restart =
    nextEnabled &&
    (!voice.programmedEnabled ||
      voice.start !== nextStart ||
      voice.loop !== nextLoop ||
      voice.end !== nextEnd ||
      voice.phaseIncrement !== nextIncrement);

  voice.programmedEnabled = nextEnabled;
  voice.looping = (control & ESP32_SOUND_PCM_CONTROL.loop) !== 0;
  voice.signedSamples = (control & ESP32_SOUND_PCM_CONTROL.signedSamples) !== 0;
  voice.start = nextStart;
  voice.loop = nextLoop;
  voice.end = nextEnd;
  voice.phaseIncrement = nextIncrement;
  voice.volume = registers[base + ESP32_SOUND_PCM_REGISTER.volume] ?? 0;
  voice.pan = registers[base + ESP32_SOUND_PCM_REGISTER.pan] ?? 0;
  if (restart) {
    voice.enabled = true;
    voice.address = voice.start;
    voice.fraction = 0;
  }
  if (!nextEnabled) {
    voice.enabled = false;
    voice.fraction = 0;
  }
}

/** Renders one PCM sample and advances the Q16.16 source cursor. */
export function renderPcmSample(
  voice: PcmVoiceState,
  soundRam: Uint8Array,
): PcmRenderResult {
  if (!voice.enabled) {
    return { sample: 0, completed: false };
  }
  if (voice.address >= voice.end || voice.address >= soundRam.length) {
    voice.enabled = false;
    return { sample: 0, completed: true };
  }

  const byte = soundRam[voice.address] ?? 0;
  const sample8 = voice.signedSamples
    ? byte < 0x80
      ? byte
      : byte - 0x100
    : byte - 0x80;
  const result = sample8 * 0x100;
  const fractionIncrement = voice.phaseIncrement & 0xffff;
  const wholeIncrement = voice.phaseIncrement >>> 16;
  const nextFraction = voice.fraction + fractionIncrement;
  const carry = nextFraction >>> 16;
  const nextAddress = voice.address + wholeIncrement + carry;
  voice.fraction = nextFraction & 0xffff;

  if (nextAddress >= voice.end) {
    if (hasValidLoop(voice)) {
      const loopLength = voice.end - voice.loop;
      voice.address = voice.loop + ((nextAddress - voice.end) % loopLength);
    } else {
      voice.address = voice.end;
      voice.enabled = false;
      return { sample: result, completed: true };
    }
  } else {
    voice.address = nextAddress;
  }
  return { sample: result, completed: false };
}

/** Copies the observable PCM state for proofs and debugger clients. */
export function pcmVoiceSnapshot(
  voice: PcmVoiceState,
): Esp32SoundPcmVoiceSnapshot {
  return {
    enabled: voice.enabled,
    looping: voice.looping,
    signedSamples: voice.signedSamples,
    start: voice.start,
    loop: voice.loop,
    end: voice.end,
    phaseIncrement: voice.phaseIncrement,
    address: voice.address,
    fraction: voice.fraction,
    volume: voice.volume,
    pan: voice.pan,
  };
}

function hasValidLoop(voice: PcmVoiceState): boolean {
  return voice.looping && voice.loop >= voice.start && voice.loop < voice.end;
}
