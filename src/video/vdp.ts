/** Transport-neutral model of the proposed ESP32-S3 indexed-colour VDP. */

export * from "./vdp-contract.js";

import {
  ESP32_VDP_COMMAND,
  ESP32_VDP_DEFAULT_VRAM_SIZE,
  ESP32_VDP_HEIGHT,
  ESP32_VDP_INTERRUPT,
  ESP32_VDP_MODE,
  ESP32_VDP_PALETTE_CONTROL,
  ESP32_VDP_PALETTE_SIZE,
  ESP32_VDP_PHYSICAL_HEIGHT,
  ESP32_VDP_PHYSICAL_WIDTH,
  ESP32_VDP_PORT,
  ESP32_VDP_REGISTER,
  ESP32_VDP_REGISTER_COUNT,
  ESP32_VDP_STATUS,
  ESP32_VDP_WIDTH,
  type Esp32FrameConfiguration,
  type Esp32RenderedFrame,
  type Esp32VdpDevice,
  type Esp32VdpSnapshot,
} from "./vdp-contract.js";

const ADDRESS_MASK = 0xff_ffff;

function byte(value: number): number {
  return value & 0xff;
}

function word(low: number, high: number): number {
  return byte(low) | (byte(high) << 8);
}

function address24(low: number, middle: number, high: number): number {
  return byte(low) | (byte(middle) << 8) | (byte(high) << 16);
}

function copyFrame(frame: Esp32FrameConfiguration): Esp32FrameConfiguration {
  return { ...frame };
}

function validVramSize(size: number): boolean {
  return Number.isInteger(size) && size > 0 && size <= ADDRESS_MASK + 1;
}

function frameDimensions(mode: number): { width: number; height: number } {
  if (
    mode === ESP32_VDP_MODE.TEXT ||
    mode === ESP32_VDP_MODE.HIGH_RESOLUTION_RGB565_BITMAP
  ) {
    return {
      width: ESP32_VDP_PHYSICAL_WIDTH,
      height: ESP32_VDP_PHYSICAL_HEIGHT,
    };
  }
  return { width: ESP32_VDP_WIDTH, height: ESP32_VDP_HEIGHT };
}

function sourceRowBytes(mode: number): number {
  return mode === ESP32_VDP_MODE.HIGH_RESOLUTION_RGB565_BITMAP
    ? ESP32_VDP_PHYSICAL_WIDTH * 2
    : ESP32_VDP_WIDTH;
}

/** Expands an RGB332 byte to a packed 0xRRGGBB value by bit replication. */
export function rgb332ToRgb888(value: number): number {
  const color = byte(value);
  const red3 = (color >> 5) & 0x07;
  const green3 = (color >> 2) & 0x07;
  const blue2 = color & 0x03;
  const red8 = (red3 << 5) | (red3 << 2) | (red3 >> 1);
  const green8 = (green3 << 5) | (green3 << 2) | (green3 >> 1);
  const blue8 = blue2 * 85;
  return (red8 << 16) | (green8 << 8) | blue8;
}

/** Expands an RGB332 byte to a packed RGB565 word. */
export function rgb332ToRgb565(value: number): number {
  const color = byte(value);
  const red3 = (color >> 5) & 0x07;
  const green3 = (color >> 2) & 0x07;
  const blue2 = color & 0x03;
  const red5 = (red3 << 2) | (red3 >> 1);
  const green6 = (green3 << 3) | green3;
  const blue5 = (blue2 << 3) | (blue2 << 1) | (blue2 >> 1);
  return (red5 << 11) | (green6 << 5) | blue5;
}

/** Creates the logical VDP. A machine profile assigns its sixteen port offsets. */
export function createEsp32Vdp(
  options: { vramSize?: number } = {},
): Esp32VdpDevice {
  const vramSize = options.vramSize ?? ESP32_VDP_DEFAULT_VRAM_SIZE;
  if (!validVramSize(vramSize)) {
    throw new RangeError(
      "ESP32 VDP RAM must contain between 1 byte and 16 MiB",
    );
  }

  const registers = new Uint8Array(ESP32_VDP_REGISTER_COUNT);
  const vram = new Uint8Array(vramSize);
  const programmedPalette = new Uint16Array(ESP32_VDP_PALETTE_SIZE);
  const activePalette = new Uint16Array(ESP32_VDP_PALETTE_SIZE);
  let active = true;
  let frameCount = 0;
  let vblank = false;
  let vblankInterruptPending = false;
  let rasterInterruptPending = false;
  let spriteOverload = false;
  let addressError = false;
  let configurationError = false;
  let transportError = false;
  let vramAddress = 0;
  let vramIncrement = 1;
  let selectedRegister = 0;
  let paletteIndex = 0;
  let paletteLowLatch = 0;
  let paletteDirty = false;
  let programmedFrame: Esp32FrameConfiguration = {
    mode: ESP32_VDP_MODE.BLANK,
    borderIndex: 0,
    bitmapBase: 0,
    bitmapPitch: ESP32_VDP_WIDTH,
  };
  let pendingFrame: Esp32FrameConfiguration | null = null;
  let activeFrame = copyFrame(programmedFrame);

  const interruptEnabled = (mask: number): boolean =>
    ((registers[ESP32_VDP_REGISTER.INTERRUPT_ENABLE] ?? 0) & mask) !== 0;

  const hasPendingInterrupt = (): boolean =>
    (vblankInterruptPending && interruptEnabled(ESP32_VDP_INTERRUPT.VBLANK)) ||
    (rasterInterruptPending && interruptEnabled(ESP32_VDP_INTERRUPT.RASTER));

  const status = (): number => {
    let result = ESP32_VDP_STATUS.VRAM_TRANSFER_READY;
    if (vblank) result |= ESP32_VDP_STATUS.VBLANK;
    if (rasterInterruptPending) result |= ESP32_VDP_STATUS.RASTER_INTERRUPT;
    if (pendingFrame !== null) result |= ESP32_VDP_STATUS.COMMAND_BUSY;
    if (spriteOverload) result |= ESP32_VDP_STATUS.SPRITE_OVERLOAD;
    if (transportError) result |= ESP32_VDP_STATUS.TRANSPORT_ERROR;
    if (addressError || configurationError)
      result |= ESP32_VDP_STATUS.DEVICE_ERROR;
    if (hasPendingInterrupt()) result |= ESP32_VDP_STATUS.INTERRUPT_PENDING;
    return result;
  };

  const advanceVramAddress = (): void => {
    vramAddress = (vramAddress + vramIncrement) & ADDRESS_MASK;
  };

  const readVram = (): number => {
    const result = vram[vramAddress];
    if (result === undefined) addressError = true;
    advanceVramAddress();
    return result ?? 0xff;
  };

  const writeVram = (value: number): void => {
    if (vramAddress < vram.length) vram[vramAddress] = byte(value);
    else addressError = true;
    advanceVramAddress();
  };

  const updateProgrammedRegister = (register: number): void => {
    switch (register) {
      case ESP32_VDP_REGISTER.MODE:
        programmedFrame.mode = registers[register] ?? 0;
        break;
      case ESP32_VDP_REGISTER.BORDER_INDEX:
        programmedFrame.borderIndex = registers[register] ?? 0;
        break;
      case ESP32_VDP_REGISTER.VRAM_INCREMENT_HIGH:
        vramIncrement = word(
          registers[ESP32_VDP_REGISTER.VRAM_INCREMENT_LOW] ?? 0,
          registers[ESP32_VDP_REGISTER.VRAM_INCREMENT_HIGH] ?? 0,
        );
        break;
      case ESP32_VDP_REGISTER.BITMAP_BASE_HIGH:
        programmedFrame.bitmapBase = address24(
          registers[ESP32_VDP_REGISTER.BITMAP_BASE_LOW] ?? 0,
          registers[ESP32_VDP_REGISTER.BITMAP_BASE_MIDDLE] ?? 0,
          registers[ESP32_VDP_REGISTER.BITMAP_BASE_HIGH] ?? 0,
        );
        break;
      case ESP32_VDP_REGISTER.BITMAP_PITCH_HIGH:
        programmedFrame.bitmapPitch = word(
          registers[ESP32_VDP_REGISTER.BITMAP_PITCH_LOW] ?? 0,
          registers[ESP32_VDP_REGISTER.BITMAP_PITCH_HIGH] ?? 0,
        );
        break;
    }
  };

  const writeSelectedRegister = (value: number): void => {
    if (selectedRegister >= registers.length) {
      configurationError = true;
      return;
    }
    registers[selectedRegister] = byte(value);
    updateProgrammedRegister(selectedRegister);
  };

  const setPaletteIndex = (value: number): void => {
    paletteIndex = byte(value);
    paletteLowLatch = (programmedPalette[paletteIndex] ?? 0) & 0xff;
  };

  const commitPaletteHighByte = (value: number): void => {
    programmedPalette[paletteIndex] = (byte(value) << 8) | paletteLowLatch;
    paletteDirty = true;
    if (
      (registers[ESP32_VDP_REGISTER.PALETTE_CONTROL] ?? 0) &
      ESP32_VDP_PALETTE_CONTROL.AUTO_INCREMENT
    ) {
      setPaletteIndex(paletteIndex + 1);
    }
  };

  const validProgrammedFrame = (): boolean => {
    if (programmedFrame.mode === ESP32_VDP_MODE.BLANK) return true;
    if (
      programmedFrame.mode !== ESP32_VDP_MODE.INDEXED_BITMAP &&
      programmedFrame.mode !== ESP32_VDP_MODE.DIRECT_RGB332_BITMAP &&
      programmedFrame.mode !== ESP32_VDP_MODE.HIGH_RESOLUTION_RGB565_BITMAP
    ) {
      return false;
    }
    const dimensions = frameDimensions(programmedFrame.mode);
    const rowBytes = sourceRowBytes(programmedFrame.mode);
    if (programmedFrame.bitmapPitch < rowBytes) return false;
    const finalByteExclusive =
      programmedFrame.bitmapBase +
      (dimensions.height - 1) * programmedFrame.bitmapPitch +
      rowBytes;
    return finalByteExclusive <= vram.length;
  };

  const queueFrame = (): void => {
    if (!validProgrammedFrame()) {
      configurationError = true;
      return;
    }
    pendingFrame = copyFrame(programmedFrame);
  };

  const executeCommand = (command: number): void => {
    switch (byte(command)) {
      case ESP32_VDP_COMMAND.ACKNOWLEDGE_VBLANK:
        vblankInterruptPending = false;
        break;
      case ESP32_VDP_COMMAND.ACKNOWLEDGE_RASTER:
        rasterInterruptPending = false;
        break;
      case ESP32_VDP_COMMAND.ACKNOWLEDGE_INTERRUPTS:
        vblankInterruptPending = false;
        rasterInterruptPending = false;
        break;
      case ESP32_VDP_COMMAND.QUEUE_FRAME:
        queueFrame();
        break;
      case ESP32_VDP_COMMAND.CLEAR_ERRORS:
        addressError = false;
        configurationError = false;
        transportError = false;
        break;
      default:
        transportError = true;
        break;
    }
  };

  const reset = (): void => {
    frameCount = 0;
    vblank = false;
    vblankInterruptPending = false;
    rasterInterruptPending = false;
    spriteOverload = false;
    addressError = false;
    configurationError = false;
    transportError = false;
    vramAddress = 0;
    vramIncrement = 1;
    selectedRegister = 0;
    paletteIndex = 0;
    paletteLowLatch = 0;
    paletteDirty = false;
    registers.fill(0);
    registers[ESP32_VDP_REGISTER.VRAM_INCREMENT_LOW] = 1;
    registers[ESP32_VDP_REGISTER.PALETTE_CONTROL] =
      ESP32_VDP_PALETTE_CONTROL.AUTO_INCREMENT;
    registers[ESP32_VDP_REGISTER.BITMAP_PITCH_LOW] = ESP32_VDP_WIDTH & 0xff;
    registers[ESP32_VDP_REGISTER.BITMAP_PITCH_HIGH] = ESP32_VDP_WIDTH >> 8;
    vram.fill(0);
    for (let index = 0; index < ESP32_VDP_PALETTE_SIZE; index += 1) {
      programmedPalette[index] = rgb332ToRgb565(index);
    }
    activePalette.set(programmedPalette);
    programmedFrame = {
      mode: ESP32_VDP_MODE.BLANK,
      borderIndex: 0,
      bitmapBase: 0,
      bitmapPitch: ESP32_VDP_WIDTH,
    };
    pendingFrame = null;
    activeFrame = copyFrame(programmedFrame);
  };

  reset();

  return {
    readPort(offset: number): number {
      if (!active) return 0xff;
      switch (offset) {
        case ESP32_VDP_PORT.VRAM_DATA:
          return readVram();
        case ESP32_VDP_PORT.VRAM_ADDRESS_LOW:
          return vramAddress & 0xff;
        case ESP32_VDP_PORT.VRAM_ADDRESS_MIDDLE:
          return (vramAddress >> 8) & 0xff;
        case ESP32_VDP_PORT.VRAM_ADDRESS_HIGH:
          return (vramAddress >> 16) & 0xff;
        case ESP32_VDP_PORT.REGISTER_SELECT:
          return selectedRegister;
        case ESP32_VDP_PORT.REGISTER_DATA:
          return registers[selectedRegister] ?? 0xff;
        case ESP32_VDP_PORT.STATUS_COMMAND:
          return status();
        case ESP32_VDP_PORT.PALETTE_INDEX:
          return paletteIndex;
        case ESP32_VDP_PORT.PALETTE_DATA_LOW:
          return (programmedPalette[paletteIndex] ?? 0) & 0xff;
        case ESP32_VDP_PORT.PALETTE_DATA_HIGH:
          return (programmedPalette[paletteIndex] ?? 0) >> 8;
        case ESP32_VDP_PORT.BULK_FIFO:
          return 0xff;
        default:
          transportError = true;
          return 0xff;
      }
    },
    writePort(offset: number, value: number): void {
      if (!active) return;
      const data = byte(value);
      switch (offset) {
        case ESP32_VDP_PORT.VRAM_DATA:
          writeVram(data);
          break;
        case ESP32_VDP_PORT.VRAM_ADDRESS_LOW:
          vramAddress = (vramAddress & 0xffff00) | data;
          break;
        case ESP32_VDP_PORT.VRAM_ADDRESS_MIDDLE:
          vramAddress = (vramAddress & 0xff00ff) | (data << 8);
          break;
        case ESP32_VDP_PORT.VRAM_ADDRESS_HIGH:
          vramAddress = (vramAddress & 0x00ffff) | (data << 16);
          break;
        case ESP32_VDP_PORT.REGISTER_SELECT:
          selectedRegister = data;
          break;
        case ESP32_VDP_PORT.REGISTER_DATA:
          writeSelectedRegister(data);
          break;
        case ESP32_VDP_PORT.STATUS_COMMAND:
          executeCommand(data);
          break;
        case ESP32_VDP_PORT.PALETTE_INDEX:
          setPaletteIndex(data);
          break;
        case ESP32_VDP_PORT.PALETTE_DATA_LOW:
          paletteLowLatch = data;
          break;
        case ESP32_VDP_PORT.PALETTE_DATA_HIGH:
          commitPaletteHighByte(data);
          break;
        case ESP32_VDP_PORT.BULK_FIFO:
        default:
          transportError = true;
          break;
      }
    },
    beginVblank(): void {
      if (!active) return;
      vblank = true;
      vblankInterruptPending = true;
      frameCount += 1;
      if (pendingFrame !== null) {
        activeFrame = pendingFrame;
        pendingFrame = null;
      }
      if (paletteDirty) {
        activePalette.set(programmedPalette);
        paletteDirty = false;
      }
    },
    endVblank(): void {
      vblank = false;
    },
    interruptAsserted(): boolean {
      return active && hasPendingInterrupt();
    },
    reportTransportError(): void {
      transportError = true;
    },
    renderFrame(): Esp32RenderedFrame {
      const dimensions = frameDimensions(activeFrame.mode);
      const pixels = new Uint16Array(dimensions.width * dimensions.height);
      pixels.fill(activePalette[activeFrame.borderIndex] ?? 0);

      if (activeFrame.mode === ESP32_VDP_MODE.INDEXED_BITMAP) {
        for (let row = 0; row < dimensions.height; row += 1) {
          const source = activeFrame.bitmapBase + row * activeFrame.bitmapPitch;
          const destination = row * dimensions.width;
          for (let column = 0; column < dimensions.width; column += 1) {
            pixels[destination + column] =
              activePalette[vram[source + column] ?? 0] ?? 0;
          }
        }
      } else if (activeFrame.mode === ESP32_VDP_MODE.DIRECT_RGB332_BITMAP) {
        for (let row = 0; row < dimensions.height; row += 1) {
          const source = activeFrame.bitmapBase + row * activeFrame.bitmapPitch;
          const destination = row * dimensions.width;
          for (let column = 0; column < dimensions.width; column += 1) {
            pixels[destination + column] = rgb332ToRgb565(
              vram[source + column] ?? 0,
            );
          }
        }
      } else if (
        activeFrame.mode === ESP32_VDP_MODE.HIGH_RESOLUTION_RGB565_BITMAP
      ) {
        for (let row = 0; row < dimensions.height; row += 1) {
          const source = activeFrame.bitmapBase + row * activeFrame.bitmapPitch;
          const destination = row * dimensions.width;
          for (let column = 0; column < dimensions.width; column += 1) {
            const byteOffset = source + column * 2;
            pixels[destination + column] = word(
              vram[byteOffset] ?? 0,
              vram[byteOffset + 1] ?? 0,
            );
          }
        }
      }
      return { ...dimensions, pixels };
    },
    reset,
    setActive(nextActive: boolean): void {
      active = nextActive;
    },
    snapshot(): Esp32VdpSnapshot {
      return {
        active,
        frameCount,
        vblank,
        status: active ? status() : 0xff,
        interruptAsserted: active && hasPendingInterrupt(),
        vramAddress,
        vramIncrement,
        selectedRegister,
        paletteIndex,
        paletteDirty,
        registers: Array.from(registers),
        programmedPalette: programmedPalette.slice(),
        activePalette: activePalette.slice(),
        errors: {
          address: addressError,
          configuration: configurationError,
          transport: transportError,
        },
        programmedFrame: copyFrame(programmedFrame),
        pendingFrame: pendingFrame === null ? null : copyFrame(pendingFrame),
        activeFrame: copyFrame(activeFrame),
        vram: vram.slice(),
      };
    },
  };
}
