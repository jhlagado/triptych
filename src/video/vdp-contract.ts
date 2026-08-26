/** Public contract for the transport-neutral ESP32-S3 indexed-colour VDP. */

export const ESP32_VDP_WIDTH = 320;
export const ESP32_VDP_HEIGHT = 240;
export const ESP32_VDP_PHYSICAL_WIDTH = 640;
export const ESP32_VDP_PHYSICAL_HEIGHT = 480;
export const ESP32_VDP_DEFAULT_VRAM_SIZE = 0x10_0000;
export const ESP32_VDP_REGISTER_COUNT = 0x40;
export const ESP32_VDP_PALETTE_SIZE = 256;

/** A machine profile maps these sixteen logical offsets to Z80 I/O ports. */
export const ESP32_VDP_PORT = {
  VRAM_DATA: 0x00,
  VRAM_ADDRESS_LOW: 0x01,
  VRAM_ADDRESS_MIDDLE: 0x02,
  VRAM_ADDRESS_HIGH: 0x03,
  REGISTER_SELECT: 0x04,
  REGISTER_DATA: 0x05,
  STATUS_COMMAND: 0x06,
  PALETTE_INDEX: 0x07,
  PALETTE_DATA_LOW: 0x08,
  PALETTE_DATA_HIGH: 0x09,
  BULK_FIFO: 0x0a,
} as const;

export const ESP32_VDP_REGISTER = {
  MODE: 0x00,
  BORDER_INDEX: 0x01,
  SPRITE_TRANSPARENT_INDEX: 0x02,
  INTERRUPT_ENABLE: 0x03,
  VRAM_INCREMENT_LOW: 0x04,
  VRAM_INCREMENT_HIGH: 0x05,
  PALETTE_CONTROL: 0x06,
  BITMAP_BASE_LOW: 0x10,
  BITMAP_BASE_MIDDLE: 0x11,
  BITMAP_BASE_HIGH: 0x12,
  BITMAP_PITCH_LOW: 0x13,
  BITMAP_PITCH_HIGH: 0x14,
} as const;

export const ESP32_VDP_PALETTE_CONTROL = { AUTO_INCREMENT: 0x01 } as const;

export const ESP32_VDP_MODE = {
  BLANK: 0,
  INDEXED_BITMAP: 1,
  INDEXED_TILE: 2,
  TEXT: 3,
  HIGH_RESOLUTION_RGB565_BITMAP: 4,
  DIRECT_RGB332_BITMAP: 5,
} as const;

export const ESP32_VDP_INTERRUPT = { VBLANK: 0x01, RASTER: 0x02 } as const;

export const ESP32_VDP_STATUS = {
  VBLANK: 0x01,
  RASTER_INTERRUPT: 0x02,
  COMMAND_BUSY: 0x04,
  VRAM_TRANSFER_READY: 0x08,
  SPRITE_OVERLOAD: 0x10,
  TRANSPORT_ERROR: 0x20,
  DEVICE_ERROR: 0x40,
  INTERRUPT_PENDING: 0x80,
} as const;

export const ESP32_VDP_COMMAND = {
  ACKNOWLEDGE_VBLANK: 0x01,
  ACKNOWLEDGE_RASTER: 0x02,
  ACKNOWLEDGE_INTERRUPTS: 0x03,
  QUEUE_FRAME: 0x10,
  CLEAR_ERRORS: 0x20,
} as const;

export interface Esp32FrameConfiguration {
  mode: number;
  borderIndex: number;
  bitmapBase: number;
  /** Source bytes between successive logical rows. */
  bitmapPitch: number;
}

export interface Esp32VdpErrors {
  address: boolean;
  configuration: boolean;
  transport: boolean;
}

export interface Esp32VdpSnapshot {
  active: boolean;
  frameCount: number;
  vblank: boolean;
  status: number;
  interruptAsserted: boolean;
  vramAddress: number;
  vramIncrement: number;
  selectedRegister: number;
  paletteIndex: number;
  paletteDirty: boolean;
  registers: number[];
  programmedPalette: Uint16Array;
  activePalette: Uint16Array;
  errors: Esp32VdpErrors;
  programmedFrame: Esp32FrameConfiguration;
  pendingFrame: Esp32FrameConfiguration | null;
  activeFrame: Esp32FrameConfiguration;
  vram: Uint8Array;
}

export interface Esp32RenderedFrame {
  width: number;
  height: number;
  /** Packed RGB565 scanout pixels. */
  pixels: Uint16Array;
}

export interface Esp32VdpDevice {
  readPort(offset: number): number;
  writePort(offset: number, value: number): void;
  beginVblank(): void;
  endVblank(): void;
  interruptAsserted(): boolean;
  reportTransportError(): void;
  renderFrame(): Esp32RenderedFrame;
  reset(): void;
  setActive(active: boolean): void;
  snapshot(): Esp32VdpSnapshot;
}
