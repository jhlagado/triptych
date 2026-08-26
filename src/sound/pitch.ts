/**
 * @file Z80-side table generation helpers for direct DDS phase increments.
 */

import { ESP32_SOUND_SAMPLE_RATE } from "./constants.js";

const PHASE_RANGE = 0x1_0000_0000;

/** Converts an audible frequency to the nearest 32-bit phase increment. */
export function phaseIncrementForFrequency(frequencyHz: number): number {
  if (
    !Number.isFinite(frequencyHz) ||
    frequencyHz < 0 ||
    frequencyHz > ESP32_SOUND_SAMPLE_RATE / 2
  ) {
    throw new RangeError(
      "frequencyHz must be between 0 and the 24 kHz Nyquist limit",
    );
  }
  return (
    Math.round((frequencyHz * PHASE_RANGE) / ESP32_SOUND_SAMPLE_RATE) >>> 0
  );
}

/** Reports the exact fundamental represented by a 32-bit phase increment. */
export function frequencyForPhaseIncrement(phaseIncrement: number): number {
  if (
    !Number.isInteger(phaseIncrement) ||
    phaseIncrement < 0 ||
    phaseIncrement > 0xffff_ffff
  ) {
    throw new RangeError("phaseIncrement must be an unsigned 32-bit integer");
  }
  return (phaseIncrement * ESP32_SOUND_SAMPLE_RATE) / PHASE_RANGE;
}
