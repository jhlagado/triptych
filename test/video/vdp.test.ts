import { describe, expect, it } from "vitest";
import {
  ESP32_VDP_COMMAND,
  ESP32_VDP_INTERRUPT,
  ESP32_VDP_MODE,
  ESP32_VDP_PALETTE_CONTROL,
  ESP32_VDP_PHYSICAL_HEIGHT,
  ESP32_VDP_PHYSICAL_WIDTH,
  ESP32_VDP_PORT,
  ESP32_VDP_REGISTER,
  ESP32_VDP_STATUS,
  ESP32_VDP_WIDTH,
  createEsp32Vdp,
  rgb332ToRgb565,
  rgb332ToRgb888,
} from "../../src/video/vdp.js";

function setAddress(
  vdp: ReturnType<typeof createEsp32Vdp>,
  address: number,
): void {
  vdp.writePort(ESP32_VDP_PORT.VRAM_ADDRESS_LOW, address);
  vdp.writePort(ESP32_VDP_PORT.VRAM_ADDRESS_MIDDLE, address >> 8);
  vdp.writePort(ESP32_VDP_PORT.VRAM_ADDRESS_HIGH, address >> 16);
}

function writeRegister(
  vdp: ReturnType<typeof createEsp32Vdp>,
  register: number,
  value: number,
): void {
  vdp.writePort(ESP32_VDP_PORT.REGISTER_SELECT, register);
  vdp.writePort(ESP32_VDP_PORT.REGISTER_DATA, value);
}

function configureBitmap(
  vdp: ReturnType<typeof createEsp32Vdp>,
  base: number,
  pitch: number = ESP32_VDP_WIDTH,
  mode: number = ESP32_VDP_MODE.INDEXED_BITMAP,
): void {
  writeRegister(vdp, ESP32_VDP_REGISTER.MODE, mode);
  writeRegister(vdp, ESP32_VDP_REGISTER.BITMAP_BASE_LOW, base);
  writeRegister(vdp, ESP32_VDP_REGISTER.BITMAP_BASE_MIDDLE, base >> 8);
  writeRegister(vdp, ESP32_VDP_REGISTER.BITMAP_BASE_HIGH, base >> 16);
  writeRegister(vdp, ESP32_VDP_REGISTER.BITMAP_PITCH_LOW, pitch);
  writeRegister(vdp, ESP32_VDP_REGISTER.BITMAP_PITCH_HIGH, pitch >> 8);
}

function writePaletteEntry(
  vdp: ReturnType<typeof createEsp32Vdp>,
  index: number,
  rgb565: number,
): void {
  vdp.writePort(ESP32_VDP_PORT.PALETTE_INDEX, index);
  vdp.writePort(ESP32_VDP_PORT.PALETTE_DATA_LOW, rgb565);
  vdp.writePort(ESP32_VDP_PORT.PALETTE_DATA_HIGH, rgb565 >> 8);
}

describe("ESP32 indexed-colour VDP logical interface", () => {
  it("writes and reads VRAM with carry across all three address bytes", () => {
    const vdp = createEsp32Vdp();
    setAddress(vdp, 0x00ffff);

    vdp.writePort(ESP32_VDP_PORT.VRAM_DATA, 0x12);
    vdp.writePort(ESP32_VDP_PORT.VRAM_DATA, 0x34);
    expect(vdp.snapshot().vramAddress).toBe(0x010001);

    setAddress(vdp, 0x00ffff);
    expect(vdp.readPort(ESP32_VDP_PORT.VRAM_DATA)).toBe(0x12);
    expect(vdp.readPort(ESP32_VDP_PORT.VRAM_DATA)).toBe(0x34);
  });

  it("supports zero and structured VRAM increments after a high-byte commit", () => {
    const vdp = createEsp32Vdp();
    writeRegister(vdp, ESP32_VDP_REGISTER.VRAM_INCREMENT_LOW, 0x40);
    expect(vdp.snapshot().vramIncrement).toBe(1);
    writeRegister(vdp, ESP32_VDP_REGISTER.VRAM_INCREMENT_HIGH, 0x00);
    expect(vdp.snapshot().vramIncrement).toBe(0x40);

    setAddress(vdp, 0x200);
    vdp.writePort(ESP32_VDP_PORT.VRAM_DATA, 0xaa);
    vdp.writePort(ESP32_VDP_PORT.VRAM_DATA, 0xbb);
    expect(vdp.snapshot().vram[0x200]).toBe(0xaa);
    expect(vdp.snapshot().vram[0x240]).toBe(0xbb);

    writeRegister(vdp, ESP32_VDP_REGISTER.VRAM_INCREMENT_LOW, 0);
    writeRegister(vdp, ESP32_VDP_REGISTER.VRAM_INCREMENT_HIGH, 0);
    setAddress(vdp, 0x300);
    vdp.writePort(ESP32_VDP_PORT.VRAM_DATA, 0x11);
    vdp.writePort(ESP32_VDP_PORT.VRAM_DATA, 0x22);
    expect(vdp.snapshot().vram[0x300]).toBe(0x22);
  });

  it("reports accesses beyond installed VRAM without aliasing the address", () => {
    const vdp = createEsp32Vdp({ vramSize: 0x100 });
    setAddress(vdp, 0xff);
    vdp.writePort(ESP32_VDP_PORT.VRAM_DATA, 0x5a);
    vdp.writePort(ESP32_VDP_PORT.VRAM_DATA, 0xa5);

    expect(vdp.snapshot().vram[0xff]).toBe(0x5a);
    expect(vdp.snapshot().vramAddress).toBe(0x101);
    expect(
      vdp.readPort(ESP32_VDP_PORT.STATUS_COMMAND) &
        ESP32_VDP_STATUS.DEVICE_ERROR,
    ).toBe(ESP32_VDP_STATUS.DEVICE_ERROR);
  });

  it("reports a port outside the sixteen-offset window without aliasing it", () => {
    const vdp = createEsp32Vdp();
    vdp.writePort(0x100, 0x5a);

    expect(vdp.snapshot().vram[0]).toBe(0);
    expect(
      vdp.readPort(ESP32_VDP_PORT.STATUS_COMMAND) &
        ESP32_VDP_STATUS.TRANSPORT_ERROR,
    ).toBe(ESP32_VDP_STATUS.TRANSPORT_ERROR);
  });

  it("publishes multi-byte bitmap registers only when their high byte is written", () => {
    const vdp = createEsp32Vdp();
    writeRegister(vdp, ESP32_VDP_REGISTER.BITMAP_BASE_LOW, 0x56);
    writeRegister(vdp, ESP32_VDP_REGISTER.BITMAP_BASE_MIDDLE, 0x34);
    expect(vdp.snapshot().programmedFrame.bitmapBase).toBe(0);

    writeRegister(vdp, ESP32_VDP_REGISTER.BITMAP_BASE_HIGH, 0x02);
    expect(vdp.snapshot().programmedFrame.bitmapBase).toBe(0x023456);
  });

  it("commits palette entries atomically and publishes them only at vertical blank", () => {
    const vdp = createEsp32Vdp();
    const resetColour = rgb332ToRgb565(0x2a);
    vdp.writePort(ESP32_VDP_PORT.PALETTE_INDEX, 0x2a);
    vdp.writePort(ESP32_VDP_PORT.PALETTE_DATA_LOW, 0x34);

    expect(vdp.snapshot().programmedPalette[0x2a]).toBe(resetColour);
    expect(vdp.snapshot().activePalette[0x2a]).toBe(resetColour);

    vdp.writePort(ESP32_VDP_PORT.PALETTE_DATA_HIGH, 0x12);
    const committed = vdp.snapshot();
    expect(committed.programmedPalette[0x2a]).toBe(0x1234);
    expect(committed.activePalette[0x2a]).toBe(resetColour);
    expect(committed.paletteIndex).toBe(0x2b);
    expect(committed.paletteDirty).toBe(true);

    vdp.beginVblank();
    expect(vdp.snapshot().activePalette[0x2a]).toBe(0x1234);
    expect(vdp.snapshot().paletteDirty).toBe(false);
  });

  it("can disable palette auto-increment and wraps it when enabled", () => {
    const vdp = createEsp32Vdp();
    writeRegister(vdp, ESP32_VDP_REGISTER.PALETTE_CONTROL, 0);
    writePaletteEntry(vdp, 0x40, 0xabcd);
    expect(vdp.readPort(ESP32_VDP_PORT.PALETTE_INDEX)).toBe(0x40);
    expect(vdp.readPort(ESP32_VDP_PORT.PALETTE_DATA_LOW)).toBe(0xcd);
    expect(vdp.readPort(ESP32_VDP_PORT.PALETTE_DATA_HIGH)).toBe(0xab);

    writeRegister(
      vdp,
      ESP32_VDP_REGISTER.PALETTE_CONTROL,
      ESP32_VDP_PALETTE_CONTROL.AUTO_INCREMENT,
    );
    writePaletteEntry(vdp, 0xff, 0x5678);
    expect(vdp.readPort(ESP32_VDP_PORT.PALETTE_INDEX)).toBe(0);
  });

  it("renders indexed bytes through the active RGB565 palette", () => {
    const vdp = createEsp32Vdp();
    configureBitmap(vdp, 0x100);
    setAddress(vdp, 0x100);
    for (let pixel = 0; pixel < ESP32_VDP_WIDTH; pixel += 1) {
      vdp.writePort(ESP32_VDP_PORT.VRAM_DATA, pixel);
    }
    writePaletteEntry(vdp, 0, 0xbeef);

    vdp.writePort(ESP32_VDP_PORT.STATUS_COMMAND, ESP32_VDP_COMMAND.QUEUE_FRAME);
    expect(
      vdp.readPort(ESP32_VDP_PORT.STATUS_COMMAND) &
        ESP32_VDP_STATUS.COMMAND_BUSY,
    ).toBe(ESP32_VDP_STATUS.COMMAND_BUSY);
    expect(new Set(vdp.renderFrame().pixels)).toEqual(new Set([0]));

    vdp.beginVblank();
    const frame = vdp.renderFrame();
    expect(frame.width).toBe(320);
    expect(frame.height).toBe(240);
    expect(frame.pixels[0]).toBe(0xbeef);
    expect(frame.pixels[1]).toBe(rgb332ToRgb565(1));
    expect(frame.pixels[0xff]).toBe(rgb332ToRgb565(0xff));
    expect(
      vdp.readPort(ESP32_VDP_PORT.STATUS_COMMAND) &
        ESP32_VDP_STATUS.COMMAND_BUSY,
    ).toBe(0);
  });

  it("keeps palette index zero visible in the background layer", () => {
    const vdp = createEsp32Vdp();
    configureBitmap(vdp, 0);
    writePaletteEntry(vdp, 0, 0xf81f);
    vdp.writePort(ESP32_VDP_PORT.STATUS_COMMAND, ESP32_VDP_COMMAND.QUEUE_FRAME);
    vdp.beginVblank();

    expect(vdp.renderFrame().pixels[0]).toBe(0xf81f);
  });

  it("retains direct RGB332 as a separate compatibility mode", () => {
    const vdp = createEsp32Vdp();
    configureBitmap(
      vdp,
      0,
      ESP32_VDP_WIDTH,
      ESP32_VDP_MODE.DIRECT_RGB332_BITMAP,
    );
    setAddress(vdp, 0);
    for (const pixel of [0x00, 0xe0, 0x1c, 0x03, 0xff]) {
      vdp.writePort(ESP32_VDP_PORT.VRAM_DATA, pixel);
    }
    writePaletteEntry(vdp, 0xe0, 0x1234);
    vdp.writePort(ESP32_VDP_PORT.STATUS_COMMAND, ESP32_VDP_COMMAND.QUEUE_FRAME);
    vdp.beginVblank();

    expect(Array.from(vdp.renderFrame().pixels.slice(0, 5))).toEqual([
      0x0000, 0xf800, 0x07e0, 0x001f, 0xffff,
    ]);
  });

  it("rejects an overrunning indexed bitmap atomically", () => {
    const vdp = createEsp32Vdp({ vramSize: 320 * 240 });
    configureBitmap(vdp, 1);
    vdp.writePort(ESP32_VDP_PORT.STATUS_COMMAND, ESP32_VDP_COMMAND.QUEUE_FRAME);

    expect(vdp.snapshot().pendingFrame).toBeNull();
    expect(vdp.snapshot().errors.configuration).toBe(true);
    vdp.beginVblank();
    expect(vdp.snapshot().activeFrame.mode).toBe(ESP32_VDP_MODE.BLANK);
  });

  it("renders native 640x480 RGB565 at its exact byte boundary", () => {
    const pixelCount = ESP32_VDP_PHYSICAL_WIDTH * ESP32_VDP_PHYSICAL_HEIGHT;
    const frameBytes = pixelCount * 2;
    const vramSize = 0x10_0000;
    const base = vramSize - frameBytes;
    const pitch = ESP32_VDP_PHYSICAL_WIDTH * 2;
    const vdp = createEsp32Vdp({ vramSize });
    configureBitmap(
      vdp,
      base,
      pitch,
      ESP32_VDP_MODE.HIGH_RESOLUTION_RGB565_BITMAP,
    );
    setAddress(vdp, base);
    vdp.writePort(ESP32_VDP_PORT.VRAM_DATA, 0x34);
    vdp.writePort(ESP32_VDP_PORT.VRAM_DATA, 0x12);
    setAddress(vdp, vramSize - 2);
    vdp.writePort(ESP32_VDP_PORT.VRAM_DATA, 0xcd);
    vdp.writePort(ESP32_VDP_PORT.VRAM_DATA, 0xab);
    vdp.writePort(ESP32_VDP_PORT.STATUS_COMMAND, ESP32_VDP_COMMAND.QUEUE_FRAME);
    vdp.beginVblank();

    const frame = vdp.renderFrame();
    expect(frame.width).toBe(ESP32_VDP_PHYSICAL_WIDTH);
    expect(frame.height).toBe(ESP32_VDP_PHYSICAL_HEIGHT);
    expect(frame.pixels.length).toBe(pixelCount);
    expect(frame.pixels[0]).toBe(0x1234);
    expect(frame.pixels[pixelCount - 1]).toBe(0xabcd);

    configureBitmap(
      vdp,
      base + 1,
      pitch,
      ESP32_VDP_MODE.HIGH_RESOLUTION_RGB565_BITMAP,
    );
    vdp.writePort(ESP32_VDP_PORT.STATUS_COMMAND, ESP32_VDP_COMMAND.QUEUE_FRAME);
    expect(vdp.snapshot().pendingFrame).toBeNull();
    expect(vdp.snapshot().activeFrame.bitmapBase).toBe(base);
  });

  it("does not acknowledge an interrupt when status is read", () => {
    const vdp = createEsp32Vdp();
    writeRegister(
      vdp,
      ESP32_VDP_REGISTER.INTERRUPT_ENABLE,
      ESP32_VDP_INTERRUPT.VBLANK,
    );
    vdp.beginVblank();

    expect(
      vdp.readPort(ESP32_VDP_PORT.STATUS_COMMAND) &
        ESP32_VDP_STATUS.INTERRUPT_PENDING,
    ).toBe(ESP32_VDP_STATUS.INTERRUPT_PENDING);
    expect(vdp.interruptAsserted()).toBe(true);
    expect(vdp.interruptAsserted()).toBe(true);

    vdp.writePort(
      ESP32_VDP_PORT.STATUS_COMMAND,
      ESP32_VDP_COMMAND.ACKNOWLEDGE_VBLANK,
    );
    expect(vdp.interruptAsserted()).toBe(false);
    expect(
      vdp.readPort(ESP32_VDP_PORT.STATUS_COMMAND) & ESP32_VDP_STATUS.VBLANK,
    ).toBe(ESP32_VDP_STATUS.VBLANK);
  });

  it("maps every RGB332 byte to a distinct RGB888 colour", () => {
    const colours = Array.from({ length: 256 }, (_, value) =>
      rgb332ToRgb888(value),
    );
    expect(new Set(colours).size).toBe(256);
    expect(rgb332ToRgb888(0x00)).toBe(0x000000);
    expect(rgb332ToRgb888(0xe0)).toBe(0xff0000);
    expect(rgb332ToRgb888(0x1c)).toBe(0x00ff00);
    expect(rgb332ToRgb888(0x03)).toBe(0x0000ff);
    expect(rgb332ToRgb888(0xff)).toBe(0xffffff);
  });

  it("maps every RGB332 byte to a distinct RGB565 value", () => {
    const colours = Array.from({ length: 256 }, (_, value) =>
      rgb332ToRgb565(value),
    );
    expect(new Set(colours).size).toBe(256);
    expect(rgb332ToRgb565(0x00)).toBe(0x0000);
    expect(rgb332ToRgb565(0xe0)).toBe(0xf800);
    expect(rgb332ToRgb565(0x1c)).toBe(0x07e0);
    expect(rgb332ToRgb565(0x03)).toBe(0x001f);
    expect(rgb332ToRgb565(0xff)).toBe(0xffff);
  });
});
