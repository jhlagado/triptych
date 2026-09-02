import { describe, expect, it } from "vitest";

import {
  canonicalCpuConformanceTranscript,
  digestCpuConformanceResult,
  loadCpuConformanceFixture,
  runCpuConformanceFixture,
} from "../support/cpu-conformance.js";

const FIXTURES = [
  "boot-overlay-serial",
  "cold-boot-disk-persistence",
  "reset-defined-state",
  "flags-conditional-timing",
  "interrupt-im1",
  "serial-read-order",
].map((name) => ({
  name,
  url: new URL(`../conformance/fixtures/${name}.json`, import.meta.url),
}));

describe("Triptych CPU language-neutral conformance", () => {
  it.each(FIXTURES)("matches $name", ({ url }) => {
    const fixture = loadCpuConformanceFixture(url);
    const result = runCpuConformanceFixture(fixture);

    expect(result).toEqual(fixture.expected.result);
    expect(digestCpuConformanceResult(result)).toBe(fixture.expected.digest);
    expect(canonicalCpuConformanceTranscript(result)).toMatchSnapshot(
      fixture.id,
    );
  });
});
