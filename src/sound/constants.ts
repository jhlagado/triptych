/**
 * @file Programmer-visible constants for the experimental ESP32 sound module.
 */

export const ESP32_SOUND_SAMPLE_RATE = 48_000;
export const ESP32_SOUND_SYNTH_VOICES = 8;
export const ESP32_SOUND_PCM_VOICES = 2;
export const ESP32_SOUND_DEFAULT_RAM_SIZE = 0x10_0000;
export const ESP32_SOUND_REGISTER_COUNT = 0x100;
export const ESP32_SOUND_PORT_COUNT = 8;

export const ESP32_SOUND_PORT = {
  data: 0,
  addressLow: 1,
  addressMiddle: 2,
  addressHigh: 3,
  registerSelect: 4,
  registerData: 5,
  statusCommand: 6,
  eventFifo: 7,
} as const;

export const ESP32_SOUND_COMMAND = {
  applyAll: 0x01,
  reset: 0x7f,
  clearStatus: 0x80,
} as const;

export const ESP32_SOUND_STATUS = {
  engineRunning: 0x01,
  commandAccepted: 0x02,
  pcm0Complete: 0x04,
  pcm1Complete: 0x08,
  soundRamOverflow: 0x10,
  transportError: 0x20,
  underrun: 0x40,
  interruptPending: 0x80,
} as const;

export const ESP32_SOUND_GLOBAL_REGISTER = {
  masterVolume: 0x00,
} as const;

export const ESP32_SOUND_SYNTH_REGISTER_BASE = 0x10;
export const ESP32_SOUND_PCM_REGISTER_BASE = 0x90;
export const ESP32_SOUND_REGISTER_STRIDE = 0x10;

export const ESP32_SOUND_SYNTH_REGISTER = {
  phaseIncrement0: 0x00,
  phaseIncrement1: 0x01,
  phaseIncrement2: 0x02,
  phaseIncrement3: 0x03,
  pulseWidthLow: 0x04,
  pulseWidthHigh: 0x05,
  control: 0x06,
  attack: 0x07,
  decay: 0x08,
  sustain: 0x09,
  release: 0x0a,
  volume: 0x0b,
  pan: 0x0c,
} as const;

export const ESP32_SOUND_SYNTH_CONTROL = {
  enabled: 0x01,
  gate: 0x02,
  waveformMask: 0x0c,
  waveformShift: 2,
} as const;

export const ESP32_SOUND_PCM_REGISTER = {
  start0: 0x00,
  start1: 0x01,
  start2: 0x02,
  loop0: 0x03,
  loop1: 0x04,
  loop2: 0x05,
  end0: 0x06,
  end1: 0x07,
  end2: 0x08,
  phaseIncrement0: 0x09,
  phaseIncrement1: 0x0a,
  phaseIncrement2: 0x0b,
  phaseIncrement3: 0x0c,
  control: 0x0d,
  volume: 0x0e,
  pan: 0x0f,
} as const;

export const ESP32_SOUND_PCM_CONTROL = {
  enabled: 0x01,
  loop: 0x02,
  signedSamples: 0x04,
} as const;

export const ESP32_SOUND_WAVEFORM = {
  pulse: 0,
  sawtooth: 1,
  triangle: 2,
  noise: 3,
} as const;
