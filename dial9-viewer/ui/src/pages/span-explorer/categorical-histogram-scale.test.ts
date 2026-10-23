import { describe, expect, it } from "vitest";
import {
  categoryBinCount,
  histogramBrushRange,
  histogramMarkerRows,
  histogramPositionToLatency,
  latencyToHistogramPosition,
} from "./categorical-histogram-scale.js";

const edges = [0, .01, .1, 1, 10, 100];

describe("Property histogram positions and selections", () => {
  it("keeps zero measurable and interpolates the zero-inclusive bucket linearly", () => {
    expect(latencyToHistogramPosition(edges, 0)).toBe(0);
    expect(latencyToHistogramPosition(edges, .005)).toBe(.5);
    expect(histogramPositionToLatency(edges, .5)).toBe(.005);
  });

  it("places p99 and brush boundaries on the same logarithmic columns", () => {
    const duration = Math.sqrt(10);
    expect(latencyToHistogramPosition(edges, duration)).toBeCloseTo(3.5);
    expect(histogramPositionToLatency(edges, 3.5)).toBeCloseTo(duration);
    expect(histogramBrushRange(edges, 3.5, 4)).toEqual({ minMs: duration, maxMs: 10 });
  });

  it("round-trips duration positions across sub-nanosecond and wide log domains", () => {
    for (const domain of [[0, 1e-8, 1e-6, .0001, .01], edges, [0, 1, 100, 10_000]]) {
      for (let position = 0; position <= domain.length - 1; position += .125) {
        expect(latencyToHistogramPosition(domain, histogramPositionToLatency(domain, position))).toBeCloseTo(position);
      }
    }
  });

  it("clamps reversed out-of-bounds brushes and represents the entire range", () => {
    expect(histogramBrushRange(edges, 7, -2)).toEqual({ minMs: null, maxMs: null });
    expect(histogramBrushRange(edges, 4, 2)).toEqual({ minMs: .1, maxMs: 10 });
  });

  it("keeps coincident p99 labels separate without changing their positions", () => {
    expect(histogramMarkerRows([.2, .2, .2, .6])).toEqual([0, 1, 2, 0]);
    expect(histogramMarkerRows([.6, .2, .4])).toEqual([0, 0, 1]);
  });
});

describe("Property histogram raw counts", () => {
  const value = { value: "hit", count: 3, shares: [1 / 3, 2 / 3], medianMs: 1, p99Ms: 2 };

  it("uses exact wire counts, including zero-count bins", () => {
    expect(categoryBinCount({ ...value, binCounts: [0, 3] }, 0)).toBe(0);
    expect(categoryBinCount({ ...value, binCounts: [0, 3] }, 1)).toBe(3);
  });

  it("recovers integer counts from unrounded shares in cached older reports", () => {
    expect(categoryBinCount(value, 0)).toBe(1);
    expect(categoryBinCount(value, 1)).toBe(2);
    expect(categoryBinCount({ ...value, count: 1_000_000, shares: [123457 / 1_000_000] }, 0)).toBe(123457);
  });

  it("does not invent a count for a missing bin", () => {
    expect(categoryBinCount(value, 2)).toBeNull();
  });
});
