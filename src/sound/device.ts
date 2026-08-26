/**
 * @file Deterministic host-side reference model for the ESP32 sound module.
 */

import {
  ESP32_SOUND_COMMAND,
  ESP32_SOUND_DEFAULT_RAM_SIZE,
  ESP32_SOUND_GLOBAL_REGISTER,
  ESP32_SOUND_PCM_REGISTER_BASE,
  ESP32_SOUND_PCM_VOICES,
  ESP32_SOUND_PORT,
  ESP32_SOUND_REGISTER_COUNT,
  ESP32_SOUND_REGISTER_STRIDE,
  ESP32_SOUND_SAMPLE_RATE,
  ESP32_SOUND_STATUS,
  ESP32_SOUND_SYNTH_REGISTER_BASE,
  ESP32_SOUND_SYNTH_VOICES,
} from "./constants.js";
import {
  applyPcmRegisters,
  createPcmVoice,
  pcmVoiceSnapshot,
  renderPcmSample,
} from "./pcm.js";
import { replaceAddressByte } from "./registers.js";
import {
  advanceEnvelope,
  applySynthRegisters,
  createSynthVoice,
  renderSynthSample,
  synthVoiceSnapshot,
} from "./synth.js";
import type {
  Esp32SoundDevice,
  Esp32SoundDeviceOptions,
  Esp32SoundSnapshot,
  Esp32SoundStereoBlock,
} from "./types.js";

const INTERRUPT_CAUSES =
  ESP32_SOUND_STATUS.pcm0Complete |
  ESP32_SOUND_STATUS.pcm1Complete |
  ESP32_SOUND_STATUS.soundRamOverflow |
  ESP32_SOUND_STATUS.transportError |
  ESP32_SOUND_STATUS.underrun;

/** Creates the platform-independent sound-chip reference implementation. */
export function createEsp32SoundDevice(
  options: Esp32SoundDeviceOptions = {},
): Esp32SoundDevice {
  const soundRamSize = options.soundRamSize ?? ESP32_SOUND_DEFAULT_RAM_SIZE;
  if (
    !Number.isInteger(soundRamSize) ||
    soundRamSize <= 0 ||
    soundRamSize > 0x100_0000
  ) {
    throw new RangeError(
      "soundRamSize must be an integer from 1 through 16 MiB",
    );
  }

  const soundRam = new Uint8Array(soundRamSize);
  const shadowRegisters = new Uint8Array(ESP32_SOUND_REGISTER_COUNT);
  const activeRegisters = new Uint8Array(ESP32_SOUND_REGISTER_COUNT);
  const synthVoices = Array.from(
    { length: ESP32_SOUND_SYNTH_VOICES },
    createSynthVoice,
  );
  const pcmVoices = Array.from(
    { length: ESP32_SOUND_PCM_VOICES },
    createPcmVoice,
  );
  let soundAddress = 0;
  let selectedRegister = 0;
  let status: number = ESP32_SOUND_STATUS.engineRunning;
  let applyPending = false;

  const updateInterruptStatus = (): void => {
    if ((status & INTERRUPT_CAUSES) !== 0) {
      status |= ESP32_SOUND_STATUS.interruptPending;
    } else {
      status &= ~ESP32_SOUND_STATUS.interruptPending;
    }
  };

  const setStatus = (bits: number): void => {
    status |= bits;
    updateInterruptStatus();
  };

  const reset = (): void => {
    soundAddress = 0;
    selectedRegister = 0;
    status = ESP32_SOUND_STATUS.engineRunning;
    applyPending = false;
    shadowRegisters.fill(0);
    activeRegisters.fill(0);
    shadowRegisters[ESP32_SOUND_GLOBAL_REGISTER.masterVolume] = 0xff;
    activeRegisters[ESP32_SOUND_GLOBAL_REGISTER.masterVolume] = 0xff;
    soundRam.fill(0);
    for (let voice = 0; voice < synthVoices.length; voice += 1) {
      synthVoices[voice] = createSynthVoice();
    }
    for (let voice = 0; voice < pcmVoices.length; voice += 1) {
      pcmVoices[voice] = createPcmVoice();
    }
  };

  const publishRegisters = (): void => {
    activeRegisters.set(shadowRegisters);
    for (let index = 0; index < synthVoices.length; index += 1) {
      const voice = synthVoices[index];
      if (voice !== undefined) {
        applySynthRegisters(
          voice,
          activeRegisters,
          ESP32_SOUND_SYNTH_REGISTER_BASE + index * ESP32_SOUND_REGISTER_STRIDE,
        );
      }
    }
    for (let index = 0; index < pcmVoices.length; index += 1) {
      const voice = pcmVoices[index];
      if (voice !== undefined) {
        applyPcmRegisters(
          voice,
          activeRegisters,
          ESP32_SOUND_PCM_REGISTER_BASE + index * ESP32_SOUND_REGISTER_STRIDE,
        );
        if (voice.enabled) {
          status &= ~(index === 0
            ? ESP32_SOUND_STATUS.pcm0Complete
            : ESP32_SOUND_STATUS.pcm1Complete);
        }
      }
    }
    applyPending = false;
    updateInterruptStatus();
  };

  const readSoundData = (): number => {
    const value = soundRam[soundAddress];
    if (value === undefined) {
      setStatus(ESP32_SOUND_STATUS.soundRamOverflow);
    }
    soundAddress = (soundAddress + 1) & 0xff_ffff;
    return value ?? 0;
  };

  const writeSoundData = (value: number): void => {
    if (soundAddress < soundRam.length) {
      soundRam[soundAddress] = value & 0xff;
    } else {
      setStatus(ESP32_SOUND_STATUS.soundRamOverflow);
    }
    soundAddress = (soundAddress + 1) & 0xff_ffff;
  };

  const writeCommand = (value: number): void => {
    switch (value & 0xff) {
      case ESP32_SOUND_COMMAND.applyAll:
        applyPending = true;
        setStatus(ESP32_SOUND_STATUS.commandAccepted);
        return;
      case ESP32_SOUND_COMMAND.reset:
        reset();
        setStatus(ESP32_SOUND_STATUS.commandAccepted);
        return;
      case ESP32_SOUND_COMMAND.clearStatus:
        status =
          ESP32_SOUND_STATUS.engineRunning | ESP32_SOUND_STATUS.commandAccepted;
        return;
      default:
        setStatus(ESP32_SOUND_STATUS.transportError);
    }
  };

  reset();
  return {
    readPort(offset: number): number {
      switch (offset) {
        case ESP32_SOUND_PORT.data:
          return readSoundData();
        case ESP32_SOUND_PORT.addressLow:
          return soundAddress & 0xff;
        case ESP32_SOUND_PORT.addressMiddle:
          return (soundAddress >>> 8) & 0xff;
        case ESP32_SOUND_PORT.addressHigh:
          return (soundAddress >>> 16) & 0xff;
        case ESP32_SOUND_PORT.registerSelect:
          return selectedRegister;
        case ESP32_SOUND_PORT.registerData:
          return shadowRegisters[selectedRegister] ?? 0;
        case ESP32_SOUND_PORT.statusCommand:
          return status & 0xff;
        case ESP32_SOUND_PORT.eventFifo:
          return 0;
        default:
          setStatus(ESP32_SOUND_STATUS.transportError);
          return 0xff;
      }
    },
    writePort(offset: number, value: number): void {
      const byte = value & 0xff;
      switch (offset) {
        case ESP32_SOUND_PORT.data:
          writeSoundData(byte);
          return;
        case ESP32_SOUND_PORT.addressLow:
          soundAddress = replaceAddressByte(soundAddress, 0, byte);
          return;
        case ESP32_SOUND_PORT.addressMiddle:
          soundAddress = replaceAddressByte(soundAddress, 1, byte);
          return;
        case ESP32_SOUND_PORT.addressHigh:
          soundAddress = replaceAddressByte(soundAddress, 2, byte);
          return;
        case ESP32_SOUND_PORT.registerSelect:
          selectedRegister = byte;
          return;
        case ESP32_SOUND_PORT.registerData:
          shadowRegisters[selectedRegister] = byte;
          return;
        case ESP32_SOUND_PORT.statusCommand:
          writeCommand(byte);
          return;
        case ESP32_SOUND_PORT.eventFifo:
        default:
          setStatus(ESP32_SOUND_STATUS.transportError);
      }
    },
    renderBlock(frames: number): Esp32SoundStereoBlock {
      if (!Number.isInteger(frames) || frames <= 0) {
        throw new RangeError("frames must be a positive integer");
      }
      if (applyPending) {
        publishRegisters();
      }
      const samples = new Int16Array(frames * 2);
      const masterVolume =
        activeRegisters[ESP32_SOUND_GLOBAL_REGISTER.masterVolume] ?? 0;
      for (let frame = 0; frame < frames; frame += 1) {
        let left = 0;
        let right = 0;
        for (const voice of synthVoices) {
          advanceEnvelope(voice);
          const raw = renderSynthSample(voice);
          const enveloped = Math.trunc((raw * voice.envelopeLevel) / 0xffff);
          left += panSample(enveloped, voice.volume, 0xff - voice.pan);
          right += panSample(enveloped, voice.volume, voice.pan);
        }
        for (let index = 0; index < pcmVoices.length; index += 1) {
          const voice = pcmVoices[index];
          if (voice === undefined) {
            continue;
          }
          const rendered = renderPcmSample(voice, soundRam);
          left += panSample(rendered.sample, voice.volume, 0xff - voice.pan);
          right += panSample(rendered.sample, voice.volume, voice.pan);
          if (rendered.completed) {
            setStatus(
              index === 0
                ? ESP32_SOUND_STATUS.pcm0Complete
                : ESP32_SOUND_STATUS.pcm1Complete,
            );
          }
        }
        samples[frame * 2] = saturate16(
          Math.trunc((left * masterVolume) / 0xff),
        );
        samples[frame * 2 + 1] = saturate16(
          Math.trunc((right * masterVolume) / 0xff),
        );
      }
      return { sampleRate: ESP32_SOUND_SAMPLE_RATE, frames, samples };
    },
    reportUnderrun(): void {
      setStatus(ESP32_SOUND_STATUS.underrun);
    },
    reset,
    snapshot(): Esp32SoundSnapshot {
      return {
        status: status & 0xff,
        soundAddress,
        selectedRegister,
        applyPending,
        shadowRegisters: shadowRegisters.slice(),
        activeRegisters: activeRegisters.slice(),
        synthVoices: synthVoices.map(synthVoiceSnapshot),
        pcmVoices: pcmVoices.map(pcmVoiceSnapshot),
        soundRam: soundRam.slice(),
      };
    },
  };
}

function panSample(
  sample: number,
  volume: number,
  channelGain: number,
): number {
  return Math.trunc((sample * volume * channelGain) / (0xff * 0xff));
}

function saturate16(value: number): number {
  return Math.max(-0x8000, Math.min(0x7fff, value));
}
