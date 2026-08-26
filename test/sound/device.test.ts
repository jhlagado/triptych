import { describe, expect, it } from "vitest";
import {
  ESP32_SOUND_COMMAND,
  ESP32_SOUND_PCM_CONTROL,
  ESP32_SOUND_PCM_REGISTER,
  ESP32_SOUND_PCM_REGISTER_BASE,
  ESP32_SOUND_PORT,
  ESP32_SOUND_STATUS,
  ESP32_SOUND_SYNTH_CONTROL,
  ESP32_SOUND_SYNTH_REGISTER,
  ESP32_SOUND_SYNTH_REGISTER_BASE,
  ESP32_SOUND_WAVEFORM,
  createEsp32SoundDevice,
  createEsp32SoundIoWindow,
  frequencyForPhaseIncrement,
  phaseIncrementForFrequency,
} from "../../src/sound/index.js";
import type { HexProgram } from "@jhlagado/debug80-runtime/z80/loaders";
import { createZ80Runtime } from "@jhlagado/debug80-runtime/z80/runtime";

function writeRegister(
  sound: ReturnType<typeof createEsp32SoundDevice>,
  register: number,
  value: number,
): void {
  sound.writePort(ESP32_SOUND_PORT.registerSelect, register);
  sound.writePort(ESP32_SOUND_PORT.registerData, value);
}

function writeUint24(
  sound: ReturnType<typeof createEsp32SoundDevice>,
  register: number,
  value: number,
): void {
  for (let byte = 0; byte < 3; byte += 1) {
    writeRegister(sound, register + byte, value >>> (byte * 8));
  }
}

function writeUint32(
  sound: ReturnType<typeof createEsp32SoundDevice>,
  register: number,
  value: number,
): void {
  for (let byte = 0; byte < 4; byte += 1) {
    writeRegister(sound, register + byte, value >>> (byte * 8));
  }
}

function apply(sound: ReturnType<typeof createEsp32SoundDevice>): void {
  sound.writePort(ESP32_SOUND_PORT.statusCommand, ESP32_SOUND_COMMAND.applyAll);
}

function configureVoice(
  sound: ReturnType<typeof createEsp32SoundDevice>,
  options: {
    voice?: number;
    increment?: number;
    waveform?: number;
    pulseWidth?: number;
    attack?: number;
    decay?: number;
    sustain?: number;
    release?: number;
    volume?: number;
    pan?: number;
    gate?: boolean;
  } = {},
): void {
  const base = ESP32_SOUND_SYNTH_REGISTER_BASE + (options.voice ?? 0) * 0x10;
  writeUint32(
    sound,
    base + ESP32_SOUND_SYNTH_REGISTER.phaseIncrement0,
    options.increment ?? 0x4000_0000,
  );
  const pulseWidth = options.pulseWidth ?? 0x8000;
  writeRegister(
    sound,
    base + ESP32_SOUND_SYNTH_REGISTER.pulseWidthLow,
    pulseWidth,
  );
  writeRegister(
    sound,
    base + ESP32_SOUND_SYNTH_REGISTER.pulseWidthHigh,
    pulseWidth >>> 8,
  );
  const waveform = options.waveform ?? ESP32_SOUND_WAVEFORM.pulse;
  const control =
    ESP32_SOUND_SYNTH_CONTROL.enabled |
    (options.gate === false ? 0 : ESP32_SOUND_SYNTH_CONTROL.gate) |
    (waveform << ESP32_SOUND_SYNTH_CONTROL.waveformShift);
  writeRegister(sound, base + ESP32_SOUND_SYNTH_REGISTER.control, control);
  writeRegister(
    sound,
    base + ESP32_SOUND_SYNTH_REGISTER.attack,
    options.attack ?? 0,
  );
  writeRegister(
    sound,
    base + ESP32_SOUND_SYNTH_REGISTER.decay,
    options.decay ?? 0,
  );
  writeRegister(
    sound,
    base + ESP32_SOUND_SYNTH_REGISTER.sustain,
    options.sustain ?? 0xff,
  );
  writeRegister(
    sound,
    base + ESP32_SOUND_SYNTH_REGISTER.release,
    options.release ?? 0,
  );
  writeRegister(
    sound,
    base + ESP32_SOUND_SYNTH_REGISTER.volume,
    options.volume ?? 0xff,
  );
  writeRegister(sound, base + ESP32_SOUND_SYNTH_REGISTER.pan, options.pan ?? 0);
}

function setSoundAddress(
  sound: ReturnType<typeof createEsp32SoundDevice>,
  address: number,
): void {
  sound.writePort(ESP32_SOUND_PORT.addressLow, address);
  sound.writePort(ESP32_SOUND_PORT.addressMiddle, address >>> 8);
  sound.writePort(ESP32_SOUND_PORT.addressHigh, address >>> 16);
}

describe("ESP32 programmable sound reference model", () => {
  it("quantizes representative oscillator frequencies to the nearest DDS increment", () => {
    const increment = phaseIncrementForFrequency(440);

    expect(increment).toBe(39_370_534);
    expect(frequencyForPhaseIncrement(increment)).toBeCloseTo(440, 4);
    expect(() => phaseIncrementForFrequency(24_001)).toThrow(RangeError);
  });

  it("publishes complete multi-byte registers only at an audio block boundary", () => {
    const sound = createEsp32SoundDevice({ soundRamSize: 16 });
    configureVoice(sound, { increment: 0x1234_5678 });
    apply(sound);

    expect(sound.snapshot().applyPending).toBe(true);
    expect(sound.snapshot().synthVoices[0]?.phaseIncrement).toBe(0);

    sound.renderBlock(1);

    expect(sound.snapshot().applyPending).toBe(false);
    expect(sound.snapshot().synthVoices[0]?.phaseIncrement).toBe(0x1234_5678);
  });

  it("renders exact sawtooth phase positions and wraps a 32-bit accumulator", () => {
    const sound = createEsp32SoundDevice({ soundRamSize: 16 });
    configureVoice(sound, {
      increment: 0x4000_0000,
      waveform: ESP32_SOUND_WAVEFORM.sawtooth,
      pan: 0,
    });
    apply(sound);

    const block = sound.renderBlock(4);

    expect(Array.from(block.samples)).toEqual([
      -32768, 0, -16384, 0, 0, 0, 16384, 0,
    ]);
    expect(sound.snapshot().synthVoices[0]?.phase).toBe(0);
  });

  it("distinguishes pulse, triangle, and phase-clocked noise waveforms", () => {
    const pulse = createEsp32SoundDevice({ soundRamSize: 16 });
    configureVoice(pulse, { waveform: ESP32_SOUND_WAVEFORM.pulse, pan: 0 });
    apply(pulse);
    expect(
      Array.from(pulse.renderBlock(4).samples).filter(
        (_, index) => index % 2 === 0,
      ),
    ).toEqual([32767, 32767, -32768, -32768]);

    const triangle = createEsp32SoundDevice({ soundRamSize: 16 });
    configureVoice(triangle, {
      waveform: ESP32_SOUND_WAVEFORM.triangle,
      pan: 0,
    });
    apply(triangle);
    expect(
      Array.from(triangle.renderBlock(4).samples).filter(
        (_, index) => index % 2 === 0,
      ),
    ).toEqual([-32768, 0, 32767, -1]);

    const noise = createEsp32SoundDevice({ soundRamSize: 16 });
    configureVoice(noise, {
      increment: 0x8000_0000,
      waveform: ESP32_SOUND_WAVEFORM.noise,
      pan: 0,
    });
    apply(noise);
    const noiseSamples = Array.from(noise.renderBlock(4).samples).filter(
      (_, index) => index % 2 === 0,
    );
    expect(noiseSamples[0]).toBe(noiseSamples[1]);
    expect(noiseSamples[2]).toBe(noiseSamples[3]);
    expect(noiseSamples[0]).not.toBe(noiseSamples[2]);
  });

  it("handles a gate change during attack and reaches zero during release", () => {
    const sound = createEsp32SoundDevice({ soundRamSize: 16 });
    configureVoice(sound, { attack: 1, release: 1, pan: 0 });
    apply(sound);

    sound.renderBlock(128);
    const attackLevel = sound.snapshot().synthVoices[0]?.envelopeLevel ?? 0;
    expect(attackLevel).toBe(32767);

    const controlRegister =
      ESP32_SOUND_SYNTH_REGISTER_BASE + ESP32_SOUND_SYNTH_REGISTER.control;
    writeRegister(sound, controlRegister, ESP32_SOUND_SYNTH_CONTROL.enabled);
    apply(sound);
    sound.renderBlock(128);

    expect(sound.snapshot().synthVoices[0]?.envelopeStage).toBe("idle");
    expect(sound.snapshot().synthVoices[0]?.envelopeLevel).toBe(0);
  });

  it("handles gate changes during decay, sustain, and release", () => {
    const duringDecay = createEsp32SoundDevice({ soundRamSize: 16 });
    configureVoice(duringDecay, {
      attack: 0,
      decay: 2,
      sustain: 0,
      release: 2,
    });
    apply(duringDecay);
    duringDecay.renderBlock(1);
    expect(duringDecay.snapshot().synthVoices[0]?.envelopeStage).toBe("decay");
    writeRegister(
      duringDecay,
      ESP32_SOUND_SYNTH_REGISTER_BASE + ESP32_SOUND_SYNTH_REGISTER.control,
      ESP32_SOUND_SYNTH_CONTROL.enabled,
    );
    apply(duringDecay);
    duringDecay.renderBlock(1);
    expect(duringDecay.snapshot().synthVoices[0]?.envelopeStage).toBe(
      "release",
    );

    const duringSustain = createEsp32SoundDevice({ soundRamSize: 16 });
    configureVoice(duringSustain, { sustain: 0x80, release: 2 });
    apply(duringSustain);
    duringSustain.renderBlock(1);
    expect(duringSustain.snapshot().synthVoices[0]?.envelopeStage).toBe(
      "sustain",
    );
    writeRegister(
      duringSustain,
      ESP32_SOUND_SYNTH_REGISTER_BASE + ESP32_SOUND_SYNTH_REGISTER.control,
      ESP32_SOUND_SYNTH_CONTROL.enabled,
    );
    apply(duringSustain);
    duringSustain.renderBlock(16);
    expect(duringSustain.snapshot().synthVoices[0]?.envelopeStage).toBe(
      "release",
    );

    writeRegister(
      duringSustain,
      ESP32_SOUND_SYNTH_REGISTER_BASE + ESP32_SOUND_SYNTH_REGISTER.control,
      ESP32_SOUND_SYNTH_CONTROL.enabled | ESP32_SOUND_SYNTH_CONTROL.gate,
    );
    apply(duringSustain);
    duringSustain.renderBlock(1);
    expect(duringSustain.snapshot().synthVoices[0]?.envelopeStage).toBe(
      "sustain",
    );
    expect(duringSustain.snapshot().synthVoices[0]?.envelopeLevel).toBe(0x8080);
  });

  it("honors hard-left, hard-right, and saturating eight-voice mixing", () => {
    const stereo = createEsp32SoundDevice({ soundRamSize: 16 });
    configureVoice(stereo, { voice: 0, pan: 0 });
    configureVoice(stereo, { voice: 1, pan: 0xff });
    apply(stereo);
    expect(Array.from(stereo.renderBlock(1).samples)).toEqual([32767, 32767]);

    const saturated = createEsp32SoundDevice({ soundRamSize: 16 });
    for (let voice = 0; voice < 8; voice += 1) {
      configureVoice(saturated, { voice, pan: 0x80 });
    }
    apply(saturated);
    expect(Array.from(saturated.renderBlock(1).samples)).toEqual([
      32767, 32767,
    ]);
  });

  it("accesses the final sound-RAM byte and reports the first overflow", () => {
    const sound = createEsp32SoundDevice({ soundRamSize: 4 });
    setSoundAddress(sound, 3);
    sound.writePort(ESP32_SOUND_PORT.data, 0xa5);
    sound.writePort(ESP32_SOUND_PORT.data, 0x5a);

    const snapshot = sound.snapshot();
    expect(Array.from(snapshot.soundRam)).toEqual([0, 0, 0, 0xa5]);
    expect(snapshot.soundAddress).toBe(5);
    expect(snapshot.status & ESP32_SOUND_STATUS.soundRamOverflow).not.toBe(0);
    expect(snapshot.status & ESP32_SOUND_STATUS.interruptPending).not.toBe(0);
  });

  it("carries auto-increment across address bytes and acknowledges status explicitly", () => {
    const sound = createEsp32SoundDevice({ soundRamSize: 0x10_001 });
    setSoundAddress(sound, 0xffff);
    sound.writePort(ESP32_SOUND_PORT.data, 0x12);
    sound.writePort(ESP32_SOUND_PORT.data, 0x34);

    const snapshot = sound.snapshot();
    expect(snapshot.soundRam[0xffff]).toBe(0x12);
    expect(snapshot.soundRam[0x1_0000]).toBe(0x34);
    expect(snapshot.soundAddress).toBe(0x1_0001);

    sound.reportUnderrun();
    const firstStatus = sound.readPort(ESP32_SOUND_PORT.statusCommand);
    const secondStatus = sound.readPort(ESP32_SOUND_PORT.statusCommand);
    expect(firstStatus).toBe(secondStatus);
    expect(firstStatus & ESP32_SOUND_STATUS.underrun).not.toBe(0);
    sound.writePort(
      ESP32_SOUND_PORT.statusCommand,
      ESP32_SOUND_COMMAND.clearStatus,
    );
    expect(sound.readPort(ESP32_SOUND_PORT.statusCommand)).toBe(
      ESP32_SOUND_STATUS.engineRunning | ESP32_SOUND_STATUS.commandAccepted,
    );
  });

  it("plays unsigned PCM to its half-open end address and reports completion", () => {
    const sound = createEsp32SoundDevice({ soundRamSize: 8 });
    setSoundAddress(sound, 0);
    for (const byte of [0x00, 0x80, 0xff]) {
      sound.writePort(ESP32_SOUND_PORT.data, byte);
    }
    const base = ESP32_SOUND_PCM_REGISTER_BASE;
    writeUint24(sound, base + ESP32_SOUND_PCM_REGISTER.start0, 0);
    writeUint24(sound, base + ESP32_SOUND_PCM_REGISTER.loop0, 0);
    writeUint24(sound, base + ESP32_SOUND_PCM_REGISTER.end0, 3);
    writeUint32(
      sound,
      base + ESP32_SOUND_PCM_REGISTER.phaseIncrement0,
      0x0001_0000,
    );
    writeRegister(
      sound,
      base + ESP32_SOUND_PCM_REGISTER.control,
      ESP32_SOUND_PCM_CONTROL.enabled,
    );
    writeRegister(sound, base + ESP32_SOUND_PCM_REGISTER.volume, 0xff);
    writeRegister(sound, base + ESP32_SOUND_PCM_REGISTER.pan, 0);
    apply(sound);

    const block = sound.renderBlock(3);

    expect(Array.from(block.samples)).toEqual([-32768, 0, 0, 0, 32512, 0]);
    expect(sound.snapshot().pcmVoices[0]?.enabled).toBe(false);
    expect(sound.snapshot().status & ESP32_SOUND_STATUS.pcm0Complete).not.toBe(
      0,
    );

    configureVoice(sound, { pan: 0xff });
    apply(sound);
    const unrelatedApply = sound.renderBlock(1);
    expect(unrelatedApply.samples[0]).toBe(0);
    expect(sound.snapshot().pcmVoices[0]?.enabled).toBe(false);
  });

  it("loops PCM from the programmed loop address and stops when disabled", () => {
    const sound = createEsp32SoundDevice({ soundRamSize: 8 });
    setSoundAddress(sound, 0);
    for (const byte of [0x00, 0x80, 0xff]) {
      sound.writePort(ESP32_SOUND_PORT.data, byte);
    }
    const base = ESP32_SOUND_PCM_REGISTER_BASE;
    writeUint24(sound, base + ESP32_SOUND_PCM_REGISTER.start0, 0);
    writeUint24(sound, base + ESP32_SOUND_PCM_REGISTER.loop0, 1);
    writeUint24(sound, base + ESP32_SOUND_PCM_REGISTER.end0, 3);
    writeUint32(
      sound,
      base + ESP32_SOUND_PCM_REGISTER.phaseIncrement0,
      0x0001_0000,
    );
    writeRegister(
      sound,
      base + ESP32_SOUND_PCM_REGISTER.control,
      ESP32_SOUND_PCM_CONTROL.enabled | ESP32_SOUND_PCM_CONTROL.loop,
    );
    writeRegister(sound, base + ESP32_SOUND_PCM_REGISTER.volume, 0xff);
    writeRegister(sound, base + ESP32_SOUND_PCM_REGISTER.pan, 0);
    apply(sound);

    const block = sound.renderBlock(5);
    expect(
      Array.from(block.samples).filter((_, index) => index % 2 === 0),
    ).toEqual([-32768, 0, 32512, 0, 32512]);

    writeRegister(sound, base + ESP32_SOUND_PCM_REGISTER.control, 0);
    apply(sound);
    expect(Array.from(sound.renderBlock(2).samples)).toEqual([0, 0, 0, 0]);
  });

  it("resets every active source to a silent state", () => {
    const sound = createEsp32SoundDevice({ soundRamSize: 16 });
    configureVoice(sound);
    apply(sound);
    expect(sound.renderBlock(1).samples[0]).not.toBe(0);

    sound.writePort(ESP32_SOUND_PORT.statusCommand, ESP32_SOUND_COMMAND.reset);

    expect(Array.from(sound.renderBlock(4).samples)).toEqual(
      new Array(8).fill(0),
    );
    expect(sound.snapshot().status).toBe(
      ESP32_SOUND_STATUS.engineRunning | ESP32_SOUND_STATUS.commandAccepted,
    );
  });

  it("accepts register programming from a real Z80 OUT sequence", () => {
    const sound = createEsp32SoundDevice({ soundRamSize: 16 });
    const basePort = 0x40;
    const io = createEsp32SoundIoWindow(sound, basePort);
    const writes: number[] = [];
    const emitOut = (port: number, value: number): void => {
      writes.push(0x3e, value & 0xff, 0xd3, port & 0xff);
    };
    const emitRegisterWrite = (register: number, value: number): void => {
      emitOut(basePort + ESP32_SOUND_PORT.registerSelect, register);
      emitOut(basePort + ESP32_SOUND_PORT.registerData, value);
    };
    const voiceBase = ESP32_SOUND_SYNTH_REGISTER_BASE;
    for (let byte = 0; byte < 4; byte += 1) {
      emitRegisterWrite(
        voiceBase + ESP32_SOUND_SYNTH_REGISTER.phaseIncrement0 + byte,
        0x4000_0000 >>> (byte * 8),
      );
    }
    emitRegisterWrite(
      voiceBase + ESP32_SOUND_SYNTH_REGISTER.pulseWidthHigh,
      0x80,
    );
    emitRegisterWrite(
      voiceBase + ESP32_SOUND_SYNTH_REGISTER.control,
      ESP32_SOUND_SYNTH_CONTROL.enabled | ESP32_SOUND_SYNTH_CONTROL.gate,
    );
    emitRegisterWrite(voiceBase + ESP32_SOUND_SYNTH_REGISTER.sustain, 0xff);
    emitRegisterWrite(voiceBase + ESP32_SOUND_SYNTH_REGISTER.volume, 0xff);
    emitOut(
      basePort + ESP32_SOUND_PORT.statusCommand,
      ESP32_SOUND_COMMAND.applyAll,
    );
    writes.push(0x76);
    const memory = new Uint8Array(0x10000);
    memory.set(writes);
    const program: HexProgram = { memory, startAddress: 0 };
    const runtime = createZ80Runtime(program, undefined, io.handlers);

    const result = runtime.runUntilStop(new Set());
    expect(result.halted).toBe(true);
    expect(sound.renderBlock(4).samples.some((sample) => sample !== 0)).toBe(
      true,
    );
    expect(sound.snapshot().synthVoices[0]?.phase).toBe(0);
  });
});
