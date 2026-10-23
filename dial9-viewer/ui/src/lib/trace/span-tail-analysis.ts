/** Wire types returned by the Rust /api/span-tail analysis endpoint. */
export interface TailRecord {
  elapsedMs: number;
  insideMs: number | null;
  startNs: string;
  endNs: string;
  sourceUrl: string;
  requestId: string | null;
}
export interface NumericField {
  key: string;
  unit: string | null;
}
export interface TailSelection {
  percentile: number;
  groupKey: string | null;
  groupValue: string | null;
  minMs: number | null;
  maxMs: number | null;
}
export interface TailSignal {
  key: string;
  unit: string | null;
  typical: number | null;
  slow: number | null;
  typicalCount: number;
  slowCount: number;
  typicalCoverage: number;
  slowCoverage: number;
  separation: number | null;
  correlation: number | null;
  correlationCount: number;
  duplicatesLatency: boolean;
  filesCompared: number;
  filesAgree: number;
  points: [number, number, TailRecord][];
}
export interface TailComposition {
  count: number;
  detailedCount: number;
  detailedCoverage: number;
  categories: { key: string; share: number; meanMs: number }[];
}
export interface CategoryLatency {
  value: string;
  count: number;
  shares: number[];
  medianMs: number;
  p99Ms: number;
}
export interface CategoricalHistogram {
  key: string;
  count: number;
  missingCount: number;
  binEdgesMs: number[];
  maxShare: number;
  values: CategoryLatency[];
}
export interface TailReport {
  count: number;
  typicalCount: number;
  slowCount: number;
  boundaryMs: number;
  medianMs: number;
  typicalElapsedMs: number | null;
  slowElapsedMs: number | null;
  typicalInsideMs: number | null;
  slowInsideMs: number | null;
  typicalOutsideMs: number | null;
  slowOutsideMs: number | null;
  typicalAttributed: number;
  slowAttributed: number;
  typicalComposition: TailComposition | null;
  slowComposition: TailComposition | null;
  signals: TailSignal[];
  groups: { key: string; values: string[]; typical: Record<string, number>; slow: Record<string, number> }[];
  histograms: CategoricalHistogram[];
  mixChanges: { key: string; value: string; typical: number; slow: number }[];
  examples: TailRecord[];
}

export interface TailResponse {
  report: TailReport;
  filesUsed: number;
  filesMatched: number;
  truncated: boolean;
  fieldsTruncated: boolean;
}
