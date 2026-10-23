import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit-html";
import { SpanTailAnalysis } from "./tail-analysis.js";
import { readScope } from "./scope.js";
import type { SpanTypeStats } from "../../lib/trace/index.js";
import type { TailReport, TailResponse } from "../../lib/trace/span-tail-analysis.js";

vi.mock("lit-html", async (original) => ({
  ...await original<typeof import("lit-html")>(),
  render: vi.fn(),
}));

interface Template {
  strings: readonly string[];
  values: unknown[];
}

function isTemplate(value: unknown): value is Template {
  return value != null && typeof value === "object" && "strings" in value && "values" in value;
}

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (!isTemplate(value)) return typeof value === "string" || typeof value === "number" ? String(value) : "";
  return value.strings.map((s, i) => s + text(value.values[i])).join("");
}

function click(value: unknown, label: string): () => void {
  if (Array.isArray(value)) {
    for (const child of value) {
      try { return click(child, label); } catch { /* Keep looking in sibling templates. */ }
    }
  } else if (isTemplate(value)) {
    for (let i = 0; i < value.values.length; i++) {
      if (value.strings[i]?.endsWith("@click=") && value.strings[i + 1]?.includes(`>${label}</button>`)) {
        return value.values[i] as () => void;
      }
      try { return click(value.values[i], label); } catch { /* Keep looking in sibling templates. */ }
    }
  }
  throw new Error(`No button labelled ${label}`);
}

function bindings(value: unknown, attribute: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap(child => bindings(child, attribute));
  if (!isTemplate(value)) return [];
  return value.values.flatMap((child, i) => [
    ...(value.strings[i]?.endsWith(attribute) ? [child] : []),
    ...bindings(child, attribute),
  ]);
}

function report(overrides: Partial<TailReport> = {}): TailReport {
  return {
    count: 100, typicalCount: 50, slowCount: 20, medianMs: 1, boundaryMs: 10,
    typicalElapsedMs: 1, slowElapsedMs: 12, typicalInsideMs: null, slowInsideMs: null,
    typicalOutsideMs: null, slowOutsideMs: null, typicalAttributed: 0, slowAttributed: 0,
    typicalComposition: null, slowComposition: null, groups: [], mixChanges: [], examples: [],
    histograms: [{
      key: "cache_hit", count: 100, missingCount: 0, binEdgesMs: [0, 1, 10, 100], maxShare: 1,
      values: [
        { value: "true", count: 50, shares: [.9, .1, 0], medianMs: .5, p99Ms: 2 },
        { value: "false", count: 50, shares: [0, .5, .5], medianMs: 8, p99Ms: 80 },
      ],
    }],
    signals: [{
      key: "work_bytes", unit: "bytes", typical: 10, slow: 80, typicalCount: 50, slowCount: 20,
      typicalCoverage: 1, slowCoverage: 1, separation: .8, correlation: .8, correlationCount: 100,
      duplicatesLatency: false, filesCompared: 1, filesAgree: 1, points: [],
    }],
    ...overrides,
  };
}

function response(value: TailReport): Response {
  const body: TailResponse = { report: value, filesUsed: 1, filesMatched: 1, truncated: false, fieldsTruncated: false };
  return new Response(JSON.stringify(body), { status: 200 });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function setup() {
  const classToggle = vi.fn();
  const examples = {} as HTMLElement;
  const panel = { classList: { toggle: classToggle }, querySelector: () => examples };
  const container = { closest: () => panel, scrollIntoView: vi.fn() } as unknown as HTMLElement;
  const context = {
    spanType: { span_type_uid: "request-uid", name: "request" } as SpanTypeStats,
    scope: readScope(new URLSearchParams("api=1&data_dir=demo")),
    view: { startNs: null, endNs: null, selectedUid: "request-uid", bandMinNs: null, bandMaxNs: null, attrFilters: [], maxFiles: null },
    headers: {}, onClearBand: vi.fn(), onBand: vi.fn(),
  };
  const analysis = new SpanTailAnalysis();
  const latest = () => vi.mocked(render).mock.calls.filter(c => c[1] === container).at(-1)?.[0];
  analysis.mount(container, context);
  return { analysis, context, container, classToggle, latest };
}

beforeEach(() => {
  vi.mocked(render).mockClear();
  vi.stubGlobal("location", { origin: "http://viewer.example" });
});

afterEach(() => vi.unstubAllGlobals());

describe("Span Explorer investigation", () => {
  it("shows properties and numeric results together without a chart tab", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(report())));
    const { latest, classToggle } = setup();
    click(latest(), "Analyse source traces")();
    await vi.waitFor(() => expect(text(latest())).toContain("work_bytes"));
    const rendered = text(latest());
    expect(rendered.indexOf("cache_hit")).toBeLessThan(rendered.indexOf("Numeric fields against elapsed time"));
    expect(rendered).not.toContain("tail-chart-tabs");
    expect(classToggle).toHaveBeenLastCalledWith("tail-analysis-ready", true);
  });

  it("keeps a distinct numeric section when no meaningful properties remain", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(report({ histograms: [] }))));
    const { latest } = setup();
    click(latest(), "Analyse source traces")();
    await vi.waitFor(() => expect(text(latest())).toContain("work_bytes"));
    expect(text(latest())).toContain('aria-label="Numeric fields"');
    expect(text(latest())).not.toContain('aria-label="Properties"');
  });

  it("makes previous graphs inert while recomputing and clears them on failure", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(report())).mockReturnValueOnce(pending.promise));
    const { analysis, context, container, latest, classToggle } = setup();
    click(latest(), "Analyse source traces")();
    await vi.waitFor(() => expect(text(latest())).toContain("work_bytes"));
    analysis.mount(container, { ...context, view: { ...context.view, bandMinNs: 5e6, bandMaxNs: 20e6 } });
    expect(text(latest())).toContain("Computing latency comparison");
    expect(text(latest())).toContain("recomputing");
    expect(bindings(latest(), "?inert=")).toContain(true);
    pending.resolve(new Response("Synthetic backend error", { status: 500 }));
    await vi.waitFor(() => expect(text(latest())).toContain("Backend analysis failed (500)"));
    expect(text(latest())).not.toContain("work_bytes");
    expect(classToggle).toHaveBeenLastCalledWith("tail-analysis-ready", false);
    expect(() => click(latest(), "Analyse source traces")).not.toThrow();
  });

  it("cancels recomputation and ignores a late response from that request", async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response(report())).mockReturnValueOnce(pending.promise);
    vi.stubGlobal("fetch", fetch);
    const { analysis, context, container, latest, classToggle } = setup();
    click(latest(), "Analyse source traces")();
    await vi.waitFor(() => expect(text(latest())).toContain("work_bytes"));
    analysis.mount(container, { ...context, view: { ...context.view, bandMinNs: 5e6, bandMaxNs: 20e6 } });
    click(latest(), "Cancel")();
    expect(fetch.mock.calls[1]?.[1]?.signal.aborted).toBe(true);
    expect(text(latest())).toContain("Analysis cancelled.");
    expect(text(latest())).not.toContain("work_bytes");
    pending.resolve(response(report()));
    await pending.promise;
    await Promise.resolve();
    expect(text(latest())).toContain("Analysis cancelled.");
    expect(classToggle).toHaveBeenLastCalledWith("tail-analysis-ready", false);
  });
});
