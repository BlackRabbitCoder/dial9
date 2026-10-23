import type { CategoryLatency } from "../../lib/trace/span-tail-analysis.js";

export interface HistogramRange {
  minMs: number | null;
  maxMs: number | null;
}

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

/**
 * Histogram columns have equal screen widths. The zero-inclusive first
 * column is linear; positive columns interpolate logarithmically.
 */
export function latencyToHistogramPosition(
  edges: readonly number[],
  latencyMs: number,
): number {
  const bins = edges.length - 1;
  if (bins < 1) return 0;
  if (latencyMs <= edges[0]!) return 0;
  if (latencyMs >= edges[bins]!) return bins;
  const bin = edges.findIndex((upper, i) => i > 0 && upper >= latencyMs) - 1;
  const lower = edges[bin]!;
  const upper = edges[bin + 1]!;
  const fraction = lower === 0
    ? latencyMs / upper
    : Math.log(latencyMs / lower) / Math.log(upper / lower);
  return bin + clamp(fraction, 0, 1);
}

export function histogramPositionToLatency(
  edges: readonly number[],
  position: number,
): number {
  const bins = edges.length - 1;
  const bounded = clamp(position, 0, bins);
  const bin = Math.min(bins - 1, Math.floor(bounded));
  const fraction = bounded - bin;
  const lower = edges[bin]!;
  const upper = edges[bin + 1]!;
  return lower === 0
    ? upper * fraction
    : lower * (upper / lower) ** fraction;
}

/** An edge-to-edge brush represents the complete duration range. */
export function histogramBrushRange(
  edges: readonly number[],
  from: number,
  to: number,
): HistogramRange {
  const bins = edges.length - 1;
  const lower = clamp(Math.min(from, to), 0, bins);
  const upper = clamp(Math.max(from, to), 0, bins);
  return {
    minMs: lower === 0 ? null : histogramPositionToLatency(edges, lower),
    maxMs: upper === bins ? null : histogramPositionToLatency(edges, upper),
  };
}

/**
 * New reports carry exact bin counts. The previous wire format contains their
 * unrounded ratio, so multiplication recovers counts in cached older reports.
 */
export function categoryBinCount(
  value: CategoryLatency & { binCounts?: readonly number[] },
  bin: number,
): number | null {
  const exact = value.binCounts?.[bin];
  if (exact != null) return exact;
  const share = value.shares[bin];
  return share == null ? null : Math.round(share * value.count);
}

/** Keep same-position percentile labels distinguishable in narrow charts. */
export function histogramMarkerRows(positions: readonly number[]): number[] {
  const rows: number[] = [];
  const rowEnds: number[] = [];
  const order = positions.map((position, index) => ({ position, index }))
    .sort((a, b) => a.position - b.position);
  for (const { position, index } of order) {
    // A fixed quarter of the chart keeps short labels apart on mobile too.
    let row = rowEnds.findIndex(end => position - end >= .25);
    if (row < 0) row = rowEnds.length;
    rowEnds[row] = position;
    rows[index] = row;
  }
  return rows;
}
