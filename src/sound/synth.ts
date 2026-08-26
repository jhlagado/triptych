/**
 * @file Integer oscillator and ADSR implementation for the ESP32 sound model.
 */

import {
  ESP32_SOUND_SYNTH_CONTROL,
  ESP32_SOUND_SYNTH_REGISTER,
  ESP32_SOUND_WAVEFORM,
} from "./constants.js";
import { readUint16, readUint32 } from "./registers.js";
import type {
  Esp32SoundEnvelopeStage,
  Esp32SoundSynthVoiceSnapshot,
} from "./types.js";

const ENVELOPE_MAX = 0xffff;
const NOISE_SEED = 0x6d2b_79f5;

export interface SynthVoiceState {
  phase: number;
  phaseIncrement: number;
  pulseWidth: number;
  enabled: boolean;
  gate: boolean;
  waveform: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  volume: number;
  pan: number;
  envelopeStage: Esp32SoundEnvelopeStage;
  envelopeLevel: number;
  envelopeRemainder: number;
  noiseState: number;
}

/** Creates a reset, silent oscillator voice. */
export function createSynthVoice(): SynthVoiceState {
  return {
    phase: 0,
    phaseIncrement: 0,
    pulseWidth: 0x8000,
    enabled: false,
    gate: false,
    waveform: ESP32_SOUND_WAVEFORM.pulse,
    attack: 0,
    decay: 0,
    sustain: 0,
    release: 0,
    volume: 0,
    pan: 0x80,
    envelopeStage: "idle",
    envelopeLevel: 0,
    envelopeRemainder: 0,
    noiseState: NOISE_SEED,
  };
}

/** Publishes one 16-byte shadow bank into an oscillator at a block boundary. */
export function applySynthRegisters(
  voice: SynthVoiceState,
  registers: Uint8Array,
  base: number,
): void {
  const control = registers[base + ESP32_SOUND_SYNTH_REGISTER.control] ?? 0;
  const nextEnabled = (control & ESP32_SOUND_SYNTH_CONTROL.enabled) !== 0;
  const nextGate = (control & ESP32_SOUND_SYNTH_CONTROL.gate) !== 0;
  const gateRose = nextEnabled && nextGate && (!voice.enabled || !voice.gate);
  const gateFell = voice.enabled && voice.gate && (!nextEnabled || !nextGate);

  voice.phaseIncrement = readUint32(
    registers,
    base + ESP32_SOUND_SYNTH_REGISTER.phaseIncrement0,
  );
  voice.pulseWidth = readUint16(
    registers,
    base + ESP32_SOUND_SYNTH_REGISTER.pulseWidthLow,
  );
  voice.enabled = nextEnabled;
  voice.gate = nextGate;
  voice.waveform =
    (control & ESP32_SOUND_SYNTH_CONTROL.waveformMask) >>>
    ESP32_SOUND_SYNTH_CONTROL.waveformShift;
  voice.attack = registers[base + ESP32_SOUND_SYNTH_REGISTER.attack] ?? 0;
  voice.decay = registers[base + ESP32_SOUND_SYNTH_REGISTER.decay] ?? 0;
  voice.sustain =
    (registers[base + ESP32_SOUND_SYNTH_REGISTER.sustain] ?? 0) * 0x101;
  voice.release = registers[base + ESP32_SOUND_SYNTH_REGISTER.release] ?? 0;
  voice.volume = registers[base + ESP32_SOUND_SYNTH_REGISTER.volume] ?? 0;
  voice.pan = registers[base + ESP32_SOUND_SYNTH_REGISTER.pan] ?? 0;

  if (!nextEnabled) {
    voice.phase = 0;
    voice.envelopeStage = "idle";
    voice.envelopeLevel = 0;
    voice.envelopeRemainder = 0;
  } else if (gateRose) {
    enterEnvelopeStage(voice, "attack");
  } else if (gateFell) {
    enterEnvelopeStage(voice, "release");
  }
}

/** Advances the ADSR state by one output sample. */
export function advanceEnvelope(voice: SynthVoiceState): void {
  for (;;) {
    switch (voice.envelopeStage) {
      case "idle":
        return;
      case "sustain":
        voice.envelopeLevel = voice.sustain;
        return;
      case "attack":
        if (voice.attack === 0) {
          voice.envelopeLevel = ENVELOPE_MAX;
          enterEnvelopeStage(voice, "decay");
          continue;
        }
        voice.envelopeLevel = Math.min(
          ENVELOPE_MAX,
          voice.envelopeLevel + envelopeStep(voice, voice.attack),
        );
        if (voice.envelopeLevel >= ENVELOPE_MAX) {
          enterEnvelopeStage(voice, "decay");
        }
        return;
      case "decay":
        if (voice.decay === 0) {
          voice.envelopeLevel = voice.sustain;
          enterEnvelopeStage(voice, "sustain");
          continue;
        }
        voice.envelopeLevel = Math.max(
          voice.sustain,
          voice.envelopeLevel - envelopeStep(voice, voice.decay),
        );
        if (voice.envelopeLevel <= voice.sustain) {
          enterEnvelopeStage(voice, "sustain");
        }
        return;
      case "release":
        if (voice.release === 0) {
          voice.envelopeLevel = 0;
          enterEnvelopeStage(voice, "idle");
          continue;
        }
        voice.envelopeLevel = Math.max(
          0,
          voice.envelopeLevel - envelopeStep(voice, voice.release),
        );
        if (voice.envelopeLevel === 0) {
          enterEnvelopeStage(voice, "idle");
        }
        return;
    }
  }
}

/** Returns the current signed waveform sample and advances its phase. */
export function renderSynthSample(voice: SynthVoiceState): number {
  if (!voice.enabled) {
    return 0;
  }
  if (voice.envelopeLevel === 0) {
    advancePhase(voice);
    return 0;
  }
  const phase16 = voice.phase >>> 16;
  let sample: number;
  switch (voice.waveform) {
    case ESP32_SOUND_WAVEFORM.sawtooth:
      sample = phase16 - 0x8000;
      break;
    case ESP32_SOUND_WAVEFORM.triangle:
      sample = phase16 < 0x8000 ? phase16 * 2 - 0x8000 : 0x17fff - phase16 * 2;
      break;
    case ESP32_SOUND_WAVEFORM.noise:
      sample = (voice.noiseState >>> 16) - 0x8000;
      break;
    default:
      sample = phase16 < voice.pulseWidth ? 0x7fff : -0x8000;
      break;
  }
  advancePhase(voice);
  return sample;
}

/** Copies the observable oscillator state for proofs and debugger clients. */
export function synthVoiceSnapshot(
  voice: SynthVoiceState,
): Esp32SoundSynthVoiceSnapshot {
  return {
    phase: voice.phase,
    phaseIncrement: voice.phaseIncrement,
    pulseWidth: voice.pulseWidth,
    enabled: voice.enabled,
    gate: voice.gate,
    waveform: voice.waveform,
    envelopeStage: voice.envelopeStage,
    envelopeLevel: voice.envelopeLevel,
    volume: voice.volume,
    pan: voice.pan,
    noiseState: voice.noiseState,
  };
}

function enterEnvelopeStage(
  voice: SynthVoiceState,
  stage: Esp32SoundEnvelopeStage,
): void {
  voice.envelopeStage = stage;
  voice.envelopeRemainder = 0;
}

/** A rate byte is the full-scale slope duration in units of 256 samples. */
function envelopeStep(voice: SynthVoiceState, rate: number): number {
  const duration = rate * 256;
  voice.envelopeRemainder += ENVELOPE_MAX;
  const step = Math.floor(voice.envelopeRemainder / duration);
  voice.envelopeRemainder -= step * duration;
  return step;
}

function advancePhase(voice: SynthVoiceState): void {
  const previous = voice.phase;
  voice.phase = (voice.phase + voice.phaseIncrement) >>> 0;
  if (voice.waveform === ESP32_SOUND_WAVEFORM.noise && voice.phase < previous) {
    voice.noiseState = nextNoise(voice.noiseState);
  }
}

function nextNoise(value: number): number {
  let next = value >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0 || NOISE_SEED;
}
