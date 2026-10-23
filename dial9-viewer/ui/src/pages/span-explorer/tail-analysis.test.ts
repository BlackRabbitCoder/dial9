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
      const hasLabel = value.strings[i + 1]?.includes(`>${label}</button>`)
        || (value.strings[i + 1] === ">" && value.values[i + 1] === label && value.strings[i + 2]?.includes("</button>"));
      if (value.strings[i]?.endsWith("@click=") && hasLabel) {
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
  const showModal = vi.fn();
  const container = { closest: () => panel, scrollIntoView: vi.fn(), querySelector: () => ({ showModal }) } as unknown as HTMLElement;
  const context = {
    spanType: { span_type_uid: "request-uid", name: "request" } as SpanTypeStats,
    scope: readScope(new URLSearchParams("api=1&data_dir=demo")),
    view: { startNs: null, endNs: null, selectedUid: "request-uid", bandMinNs: null, bandMaxNs: null, attrFilters: [], maxFiles: null },
    headers: {}, onClearBand: vi.fn(), onBand: vi.fn(),
  };
  const analysis = new SpanTailAnalysis();
  const latest = () => vi.mocked(render).mock.calls.filter(c => c[1] === container).at(-1)?.[0];
  analysis.mount(container, context);
  return { analysis, context, container, classToggle, latest, showModal };
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
    expect(rendered).toContain("Property histogram view");
    expect(rendered).toContain("Displayed property");
    expect(rendered).not.toContain("pairs");
    expect(classToggle).toHaveBeenLastCalledWith("tail-analysis-ready", true);
  });

  it("keeps a distinct numeric section when no meaningful properties remain", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(report({ histograms: [] }))));
    const { latest } = setup();
    click(latest(), "Analyse source traces")();
    await vi.waitFor(() => expect(text(latest())).toContain("work_bytes"));
    expect(text(latest())).toContain('aria-label="Numeric fields"');
    expect(text(latest())).not.toContain('tail-property-heading');
  });

  it("keeps elapsed aliases hidden after expanding an older report", async () => {
    const field = report().signals[0]!;
    const signals = [1, 2, 3, 4].map(n => ({ ...field, key: `field_${n}` }));
    signals.splice(1, 0, { ...field, key: "ElapsedAliasOnly", duplicatesLatency: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(report({ signals }))));
    const { latest } = setup();
    click(latest(), "Analyse source traces")();
    await vi.waitFor(() => expect(text(latest())).toContain("field_1"));
    expect(text(latest())).not.toContain("ElapsedAliasOnly");
    expect(text(latest())).toContain("Show all 4 fields");
    click(latest(), "Show all 4 fields")();
    expect(text(latest())).toContain("field_4");
    expect(text(latest())).not.toContain("ElapsedAliasOnly");
  });

  it("shows qualitative correlation and explains observation limits on click", async () => {
    const field = { ...report().signals[0]!, correlation: 1, typicalCount: 5, typicalCoverage: .1 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(report({ signals: [field] }))));
    const { latest, showModal } = setup();
    click(latest(), "Analyse source traces")();
    await vi.waitFor(() => expect(text(latest())).toContain("Perfectly correlated"));
    expect(text(latest())).not.toContain("Spearman");
    const handler = bindings(latest(), "@click=").find(value => typeof value === "function" && String(value).includes("Limited observations")) as (event: unknown) => void;
    const trigger = { focus: vi.fn() };
    handler({ currentTarget: trigger });
    expect(showModal).toHaveBeenCalledOnce();
    expect(text(latest())).toContain("Typical has 5 recorded values; at least 20 are required.");
    expect(text(latest())).toContain("at least 50% coverage is required.");
    expect(trigger.focus).toHaveBeenCalled();
  });

  it("normalizes Greek-mu microseconds in displayed means", async () => {
    const field = { ...report().signals[0]!, unit: "μs", typical: 2000, slow: 8000 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(report({ signals: [field] }))));
    const { latest } = setup();
    click(latest(), "Analyse source traces")();
    await vi.waitFor(() => expect(text(latest())).toContain("work_bytes"));
    expect(text(latest())).toContain("2ms");
    expect(text(latest())).toContain("8ms");
    expect(text(latest())).not.toContain("2,000 μs");
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

  it("does not cache bytes from a superseded raw-trace request", async () => {
    const pending = deferred<Response>();
    const oldBytes = new Uint8Array([1, 1]).buffer;
    const currentBytes = new Uint8Array([2, 2]).buffer;
    const readOldBytes = vi.fn().mockResolvedValue(oldBytes);
    const fetch = vi.fn().mockImplementation((url: URL, options: RequestInit) => {
      if (url.pathname === "/old.bin") return pending.promise;
      if (url.pathname === "/current.bin") return Promise.resolve(new Response(currentBytes));
      expect(options.body).toEqual(currentBytes);
      return Promise.resolve(response(report()));
    });
    vi.stubGlobal("fetch", fetch);
    const { analysis, context, container, latest } = setup();
    analysis.mount(container, { ...context, scope: { ...context.scope, trace: "/old.bin" } });
    click(latest(), "Analyse source traces")();
    analysis.mount(container, { ...context, scope: { ...context.scope, trace: "/current.bin" } });
    expect(fetch.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    pending.resolve({ ok: true, arrayBuffer: readOldBytes } as unknown as Response);
    await vi.waitFor(() => expect(readOldBytes).toHaveBeenCalledOnce());
    click(latest(), "Analyse source traces")();
    await vi.waitFor(() => expect(text(latest())).toContain("work_bytes"));
    expect(fetch.mock.calls.map(call => call[0].pathname)).toEqual(["/old.bin", "/current.bin", "/api/span-tail"]);
  });
});
