import { html, nothing, render, svg } from "lit-html";
import {
  buildExemplarViewerUrl,
  TIME_CATEGORIES,
} from "../../lib/trace/index.js";
import type { SpanTypeStats } from "../../lib/trace/index.js";
import type {
  TailRecord,
  TailReport,
  TailSelection,
  TailSignal,
  TailResponse,
  TailComposition,
} from "../../lib/trace/span-tail-analysis.js";
import { buildApiUrl, type PageScope, type ViewState } from "./scope.js";
import { fetchRawTraceBytes } from "./raw.js";
import { renderCategoricalHistogram } from "./categorical-histograms.js";
import "./tail-analysis.css";

interface Context {
  spanType: SpanTypeStats;
  scope: PageScope;
  view: ViewState;
  headers: Record<string, string>;
  onClearBand: () => void;
  onBand: (minMs: number | null, maxMs: number | null) => void;
}
const number = (n: number | null, digits = 2) =>
  n == null || !Number.isFinite(n) ? "unavailable" : n.toLocaleString(undefined, { maximumFractionDigits: digits });
const ms = (n: number | null) => `${number(n, 3)}${n == null ? "" : " ms"}`;
const percent = (n: number) => `${number(n * 100, 1)}%`;
function value(n: number | null, unit: string | null): string {
  if (n == null) return "unavailable";
  if (unit === "ns") return ms(n / 1e6);
  if (unit === "us" || unit === "µs") return ms(n / 1000);
  if (unit === "ms") return ms(n);
  if (unit === "s") return ms(n * 1000);
  if (unit === "bytes") return n >= 1e6 ? `${number(n / 1e6)} MB` : n >= 1000 ? `${number(n / 1000)} kB` : `${number(n)} bytes`;
  return `${number(n)}${unit ? ` ${unit}` : ""}`;
}

/** Requests server-computed reports and renders them for the selected span type. */
export class SpanTailAnalysis {
  private container: HTMLElement | null = null;
  private context: Context | null = null;
  private key = "";
  private request: AbortController | null = null;
  private rawBytes: ArrayBuffer | null = null;
  private fieldsTruncated = false;
  private generation = 0;
  private report: TailReport | null = null;
  private status = "";
  private busy = false;
  private more = false;
  private categoryKey = "";
  private categoryMode: "overlay" | "stacked" = "overlay";
  private expandedKey: string | null = null;
  private sourceCount = 0;
  private sourceUsed = 0;
  private truncated = false;
  private selection: TailSelection = { percentile: 99, groupKey: null, groupValue: null, minMs: null, maxMs: null };

  mount(container: HTMLElement | null, context: Context | null): void {
    const key = context ? JSON.stringify([
      context.spanType.span_type_uid, context.scope,
      context.view.startNs, context.view.endNs, context.view.attrFilters,
    ]) : "";
    if (key !== this.key) {
      this.request?.abort();
      this.request = null;
      this.rawBytes = null;
      this.generation++;
      this.report = null;
      this.status = "";
      this.busy = false;
      this.more = false;
      this.categoryKey = "";
      this.categoryMode = "overlay";
      this.expandedKey = null;
      this.key = key;
      this.selection = { percentile: 99, groupKey: null, groupValue: null, minMs: null, maxMs: null };
    }
    this.container = container;
    this.context = context;
    const minMs = context?.view.bandMinNs == null ? null : context.view.bandMinNs / 1e6;
    const maxMs = context?.view.bandMaxNs == null ? null : context.view.bandMaxNs / 1e6;
    if (minMs !== this.selection.minMs || maxMs !== this.selection.maxMs) {
      this.selection.minMs = minMs;
      this.selection.maxMs = maxMs;
      if (this.report) this.compare();
    }
    this.draw();
  }

  private cancel(): void {
    this.generation++;
    this.request?.abort();
    this.request = null;
    this.busy = false;
    this.report = null;
    this.status = "Analysis cancelled.";
    this.draw();
  }

  private async load(): Promise<void> {
    const context = this.context;
    if (!context) return;
    const generation = ++this.generation;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    const firstReport = this.report == null;
    this.expandedKey = null;
    this.busy = true;
    this.status = "Computing latency comparison…";
    this.draw();
    try {
      const url = new URL(buildApiUrl("comparison", context.scope, context.view, location.origin));
      url.pathname = "/api/span-tail";
      url.searchParams.delete("folded_only");
      url.searchParams.set("span_type_uid", context.spanType.span_type_uid);
      url.searchParams.set("max_files", String(Math.min(context.view.maxFiles ?? 24, 24)));
      url.searchParams.set("slow_percentile", String(this.selection.percentile));
      if (this.selection.minMs != null) url.searchParams.set("min_span_ns", String(Math.round(this.selection.minMs * 1e6)));
      if (this.selection.maxMs != null) url.searchParams.set("max_span_ns", String(Math.round(this.selection.maxMs * 1e6)));
      if (this.selection.groupKey != null && this.selection.groupValue != null) {
        url.searchParams.set("group_key", this.selection.groupKey);
        url.searchParams.set("group_value", this.selection.groupValue);
      }
      let options: RequestInit = { headers: context.headers, signal: request.signal };
      if (context.scope.trace) {
        if (!this.rawBytes) this.rawBytes = await fetchRawTraceBytes(context.scope.trace, location.origin, context.headers);
        if (generation !== this.generation) return;
        // A raw trace has its own complete scope. Its bytes are decoded by Rust.
        url.searchParams.delete("start_ns");
        url.searchParams.delete("end_ns");
        options = { method: "POST", headers: { "content-type": "application/octet-stream" }, body: this.rawBytes, signal: request.signal };
      }
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(`Backend analysis failed (${response.status}): ${await response.text()}`);
      const reply: TailResponse = await response.json();
      if (generation !== this.generation) return;
      this.report = reply.report;
      this.sourceUsed = reply.filesUsed;
      this.sourceCount = reply.filesMatched;
      this.truncated = reply.truncated;
      this.fieldsTruncated = reply.fieldsTruncated;
      this.busy = false;
      this.status = "";
      this.draw();
      if (firstReport) this.container?.scrollIntoView({ block: "start" });
    } catch (error) {
      if (generation !== this.generation) return;
      // A failed request cannot leave a previous comparison under new labels.
      this.report = null;
      this.status = error instanceof Error ? error.message : String(error);
      this.busy = false;
      this.draw();
    }
  }

  private compare(): void {
    if (this.report) void this.load();
  }

  private jump(row: TailRecord): void {
    if (!this.context) return;
    const url = buildExemplarViewerUrl({
      source: this.context.scope.source, trace: this.context.scope.trace ?? new URL(row.sourceUrl, location.origin).href,
      exemplar: { start_ns: row.startNs, end_ns: row.endNs, span_name: this.context.spanType.name },
      service: this.context.scope.service,
    });
    // Retain the same tab-scoped session inheritance as existing exemplar links.
    window.open(url, "_blank");
  }

  private expand(signal: TailSignal): void {
    this.expandedKey = signal.key;
    this.draw();
    this.container?.querySelector<HTMLDialogElement>(".tail-plot-dialog")?.showModal();
  }

  private plot(signal: TailSignal, large = false) {
    const points = signal.points;
    if (!points.length) return html`<div class="tail-empty-plot">No trace-linked points available</div>`;
    let maxX = this.report?.examples[0]?.elapsedMs ?? 1e-9, minY = 0, maxY = 1e-9;
    // The same elapsed-time scale across panels makes their shapes comparable.
    for (const field of this.report?.signals ?? []) {
      for (const [x] of field.points) maxX = Math.max(maxX, x);
    }
    // A bounded point sample can end before the requested comparison range.
    maxX = Math.max(maxX, this.report!.boundaryMs, this.selection.maxMs ?? 0);
    for (const [, y] of points) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const band = this.selection.minMs != null || this.selection.maxMs != null;
    const width = large ? 700 : 400, height = large ? 330 : 205;
    const left = large ? 80 : 57, right = width - 18, top = band ? 46 : 32, bottom = height - 39;
    const px = (x: number) => left + x / maxX * (right - left);
    const py = (y: number) => bottom - (y - minY) / (maxY - minY) * (bottom - top);
    const boundary = this.report!.boundaryMs;
    const marker = (x: number, label: string, y: number) => {
      if (x > maxX) return nothing;
      const end = px(x) > (left + right) / 2;
      return svg`<g class="tail-boundary">
        <path d="M${px(x)} ${top}V${bottom}" stroke="#f6ae65" stroke-dasharray="3 4" opacity=".8"></path>
        <text class="tail-cutoff-label" x=${end ? px(x) - 4 : Math.max(left + 28, px(x) + 4)} y=${y} text-anchor=${end ? "end" : "start"}>${label}</text>
      </g>`;
    };
    return html`<svg class="tail-scatter" viewBox="0 0 ${width} ${height}" role="img"
      aria-label="${signal.key} (${signal.unit ?? "unit not recorded"}) against total span elapsed time in milliseconds; linear axes; ${band ? `custom selection from ${ms(boundary)} to ${this.selection.maxMs == null ? "∞" : ms(this.selection.maxMs)}` : `p${this.selection.percentile} cutoff at ${ms(boundary)}`}">
      ${[0, 0.5, 1].map(f => svg`
        <path d="M${left} ${py(minY + f * (maxY - minY))}H${right}" stroke="#344354" stroke-dasharray="2 3"></path>
        <text x=${px(f * maxX)} y=${bottom + 18} text-anchor="middle">${number(f * maxX, maxX < 1 ? 3 : 1)}</text>
        <text x=${left - 6} y=${py(minY + f * (maxY - minY)) + 4} text-anchor="end">${signal.unit === "bytes" ? value(minY + f * (maxY - minY), "bytes") : number(minY + f * (maxY - minY), maxY < 1 ? 3 : 1)}</text>`)}
      <path d="M${left} ${top}V${bottom}H${right}" fill="none" stroke="#687584"></path>
      <text x=${left} y="13" class="tail-axis-unit">${signal.unit ?? "unit not recorded"}</text>
      ${marker(boundary, band ? `Start: ${ms(boundary)}` : `p${this.selection.percentile} cutoff: ${ms(boundary)}`, 27)}
      ${band && this.selection.maxMs != null ? marker(this.selection.maxMs, `End: ${ms(this.selection.maxMs)}`, 41) : nothing}
      ${points.map(([x, y, row]) => svg`<circle cx=${px(x)} cy=${py(y)} r=${large ? 3 : 2.4}
        fill=${x >= boundary && (this.selection.maxMs == null || x <= this.selection.maxMs) ? "#f6ae65" : "#71869c"}
        opacity="0.7" tabindex="0" role="link"
        aria-label=${`Inspect span: ${ms(x)}, ${signal.key} ${value(y, signal.unit)}`}
        @click=${() => this.jump(row)}
        @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") this.jump(row); }}>
        <title>${ms(x)} elapsed · ${signal.key}: ${value(y, signal.unit)} · inspect trace</title>
      </circle>`)}
      <text x=${(left + right) / 2} y=${height - 3} text-anchor="middle">Span elapsed (ms) →</text>
    </svg>`;
  }

  private signal(signal: TailSignal, i: number) {
    const band = this.selection.minMs != null || this.selection.maxMs != null;
    const limited = Math.min(signal.typicalCount, signal.slowCount) < 20 || Math.min(signal.typicalCoverage, signal.slowCoverage) < 0.5;
    const probability = signal.separation == null ? null : (Math.abs(signal.separation) + 1) / 2;
    const score = probability == null ? "unavailable" : probability < 1 && probability > .999 ? ">99.9%" : percent(probability);
    return html`<article class="tail-field">
      <div class="tail-field-heading"><h4><span class="tail-rank">${i + 1}</span>${signal.key}</h4>
        <button class="tail-expand" aria-label="Enlarge ${signal.key} plot" title="Enlarge plot" @click=${() => this.expand(signal)}>⤢</button>
      </div>
      <div class="tail-field-means"><span><span class="tail-dot typical"></span>Typical <strong>${value(signal.typical, signal.unit)}</strong></span>
        <span><span class="tail-dot slow"></span>${band ? "Selected" : "Slow"} <strong>${value(signal.slow, signal.unit)}</strong></span></div>
      ${this.plot(signal)}
      <div class="tail-signal-stats">
        <span title="How often a compared-span value is higher or lower than a typical-span value, with ties split equally. See Reading these charts.">${signal.separation == null ? "No comparison" : html`${signal.separation >= 0 ? "Higher" : "Lower"} in ${band ? "selection" : "slow"} <strong>${score}</strong> pairs`}</span>
        <span title="Spearman rank correlation: larger values and longer spans rising together. +1 rises together; 0 has no consistent monotonic trend; −1 moves in opposite directions. Based on up to 2,048 sampled observations.">Spearman <strong>${number(signal.correlation, 2)}</strong></span>
      </div>
      <div class="tail-signal-meta">
        <span title="Source files with the same direction as the overall difference; each qualifying file has at least five values in both groups. This is repetition, not a significance test.">${signal.filesCompared ? `${signal.filesAgree}/${signal.filesCompared} files agree` : "File check unavailable"}</span>
        ${signal.typicalCoverage < 1 || signal.slowCoverage < 1 ? html`<span title="Recorded-value coverage: typical / slow. Missing values are excluded, never treated as zero.">${percent(signal.typicalCoverage)} / ${percent(signal.slowCoverage)} coverage</span>` : nothing}
      </div>
      ${signal.duplicatesLatency ? html`<span class="tail-badge">Repeats elapsed time</span>` : limited ? html`<span class="tail-badge">Limited observations</span>` : nothing}
    </article>`;
  }

  private compositionRow(label: string, composition: TailComposition | null | undefined, elapsed: number | null) {
    return html`<div class="tail-composition-row">
      <div class="tail-composition-label">${label}
        ${composition && composition.detailedCoverage < 1 ? html`<span class="tail-composition-quality" title="${number(composition.detailedCount, 0)}/${number(composition.count, 0)} spans have complete detail">${composition.detailedCoverage > .9995 ? "<100%" : percent(composition.detailedCoverage)} detailed</span>` : nothing}
      </div>
      ${composition ? html`<div class="tail-composition-bar" role="img" aria-label="${label} time breakdown: ${composition.categories.map(c => `${TIME_CATEGORIES.find(cat => cat.key === c.key)?.label ?? c.key} ${percent(c.share)}`).join(", ")}">
        ${composition.categories.filter(c => c.share > 0).map(c => {
          const category = TIME_CATEGORIES.find(cat => cat.key === c.key)!;
          return html`<span class="tail-composition-segment" style="width:${c.share * 100}%;background:${category.color};color:${c.key === "on_cpu" || c.key === "sched_delay" ? "#0d1117" : "#fff"}"
            title="${category.label}: ${percent(c.share)} average share · ${ms(c.meanMs)} per span">${c.share >= .18 ? html`<span class="tail-composition-segment-name">${category.label}</span>` : nothing}${c.share >= .07 ? percent(c.share) : nothing}</span>`;
        })}
      </div>` : html`<span class="tail-note">${composition === null ? "No matching spans" : "Time breakdown unavailable"}</span>`}
      <strong class="tail-composition-duration">${ms(elapsed)}</strong>
    </div>`;
  }

  private draw(): void {
    if (!this.container || !this.context) return;
    const r = this.report;
    const band = this.selection.minMs != null || this.selection.maxMs != null;
    const changes = r?.mixChanges ?? [];
    const expanded = r?.signals.find(s => s.key === this.expandedKey);
    const histograms = r?.histograms ?? [];
    const histogram = histograms.find(h => h.key === this.categoryKey) ?? histograms[0];
    this.container.closest(".detail-panel")?.classList.toggle("tail-analysis-ready", r != null);
    render(html`<section class="span-tail-analysis" aria-busy=${this.busy}>
      <div class="tail-heading"><h3>How are slow spans different?</h3>
        ${!r && !this.busy ? html`<button @click=${() => void this.load()}>Analyse source traces</button>` : r ? html`<span class="tail-source-count">${number(r.count, 0)} spans · ${this.sourceUsed}/${this.sourceCount} files</span>` : nothing}
      </div>
      ${!r ? html`<p class="tail-note">Compare the faster half with the slowest instances, then follow a lead into its trace.</p>` : nothing}
      ${this.status ? html`<p class="tail-status ${this.busy ? "computing" : ""}" role="status">
        ${this.busy ? html`<span class="tail-loading-spinner" aria-hidden="true"></span>` : nothing}${this.status}
        ${this.busy ? html`<button class="secondary" @click=${() => this.cancel()}>Cancel</button>` : nothing}</p>` : nothing}
      ${r ? html`
        <div class="tail-results ${this.busy ? "recomputing" : ""}" ?inert=${this.busy} aria-hidden=${this.busy}>
        <div class="tail-controls">
          <label>Comparison group <select .value=${band ? "custom" : String(this.selection.percentile)} ?disabled=${this.busy}
            @change=${(e: Event) => {
              const selected = (e.target as HTMLSelectElement).value;
              if (selected === "custom") return;
              this.selection.percentile = Number(selected);
              if (band) this.context?.onClearBand();
              else this.compare();
            }}>
            ${band ? html`<option value="custom">Custom selection: ${ms(this.selection.minMs ?? 0)} to ${this.selection.maxMs == null ? "∞" : ms(this.selection.maxMs)}</option>` : nothing}
            <option value="95">p95+ · slowest 5%</option><option value="99">p99+ · slowest 1%</option><option value="99.9">p99.9+ · slowest 0.1%</option>
          </select></label>
          <label>Compare similar spans <select .value=${this.selection.groupKey ? JSON.stringify([this.selection.groupKey, this.selection.groupValue]) : ""} ?disabled=${this.busy}
            @change=${(e: Event) => { const v = (e.target as HTMLSelectElement).value; [this.selection.groupKey, this.selection.groupValue] = v ? JSON.parse(v) as [string, string] : [null, null]; this.compare(); }}>
            <option value="">All instances</option>
            ${r.groups.map(g => g.values.map(v => html`<option value=${JSON.stringify([g.key, v])}>${g.key} = ${v}</option>`))}
          </select></label>
        </div>
        <div class="tail-cohorts">
          <span title="All boundary ties are included."><span class="tail-dot typical"></span><strong>Typical</strong> ≤ median ${ms(r.medianMs)} · ${number(r.typicalCount, 0)}</span>
          <span><span class="tail-dot slow"></span><strong>${band ? "Selected" : `Slow p${this.selection.percentile}+`}</strong> ${band ? `${ms(r.boundaryMs)}–${this.selection.maxMs == null ? "∞" : ms(this.selection.maxMs)}` : `≥ ${ms(r.boundaryMs)}`} · ${number(r.slowCount, 0)}</span>
        </div>
        ${this.sourceUsed < this.sourceCount || this.truncated || this.fieldsTruncated ? html`<p class="tail-warning">Partial sample · ${this.sourceUsed}/${this.sourceCount} files. ${this.truncated ? "One million span limit reached." : ""} ${this.fieldsTruncated ? "Field discovery limit reached." : ""}</p>` : nothing}
        ${r.slowCount < 20 ? html`<p class="tail-warning">Only ${r.slowCount} ${band ? "selected" : "slow"} spans · widen the group or time window before relying on these differences.</p>` : nothing}
        ${changes.length && !this.selection.groupKey ? html`<div class="tail-mix"><strong>Mix shift</strong>
          ${changes.map(g => html`<span title=${g.key}>${g.value} ${percent(g.typical)} → ${percent(g.slow)}</span>`)}
          <span class="tail-muted">Compare the same group above.</span></div>` : nothing}
        ${histogram ? html`<section class="tail-properties" aria-label="Properties"><div class="tail-chart-heading"><h4>Latency by property</h4>
          ${histograms.length > 1 ? html`<select class="tail-category-select" aria-label="Categorical field" .value=${histogram.key}
            @change=${(e: Event) => { this.categoryKey = (e.target as HTMLSelectElement).value; this.draw(); }}>
            ${histograms.map(h => html`<option value=${h.key}>${h.key}</option>`)}
          </select>` : html`<h4 class="tail-category-field-name">${histogram.key}</h4>`}
        </div>${renderCategoricalHistogram(histogram)}</section>` : nothing}
        <section class="tail-numeric" aria-label="Numeric fields"><div class="tail-chart-heading"><h4>Numeric fields against elapsed time</h4>
          <span class="tail-legend"><span class="tail-dot typical"></span>Other spans <span class="tail-dot slow"></span>${band ? "Selected" : "Slow"}</span>
          <details class="tail-chart-help"><summary>Reading these charts</summary><div id="tail-chart-guide">
            <p>Each dot is one span; click it to inspect the trace. X is total elapsed time in milliseconds. Y is the field value in its recorded unit. Orange dashed lines mark the labelled percentile cutoff, or the start and end of a custom selection. Axes are linear; all panels share the X scale. Up to 330 sampled points are drawn per field.</p>
            <p><strong>Higher/lower</strong> is the fraction of ${band ? "selected" : "slow"}-versus-typical pairs in that direction, splitting ties equally. Near 50% means similar distributions; near 100% means strong separation. This score orders the fields, with low coverage and repeated latency placed last.</p>
            <p><strong>Spearman</strong> compares the ordering of field values and elapsed time: +1 rises together, 0 has no consistent monotonic trend, −1 moves in opposite directions. It uses up to 2,048 observations sampled across latency ranks. Near zero can still hide separate clusters.</p>
            <p><strong>Files agree</strong> checks whether the direction repeats in files with at least five recorded values in both groups. None of these measures proves causation or supplies a significance test.</p>
          </div></details>
        </div>
        <div class="tail-grid">${r.signals.length ? r.signals.slice(0, this.more ? undefined : 3).map((s, i) => this.signal(s, i)) : html`<p>No varying numeric fields recorded.</p>`}</div>
        ${r.signals.length > 3 ? html`<button class="secondary tail-more" @click=${() => { this.more = !this.more; this.draw(); }}>${this.more ? "Show fewer fields" : `Show all ${r.signals.length} fields`}</button>` : nothing}
        </section>
        <section class="tail-composition">
          <div class="tail-composition-heading"><h4>Time breakdown</h4><span class="tail-note">Estimated · average share per span</span><span class="tail-note tail-composition-mean-label">Mean elapsed</span></div>
          ${this.compositionRow("Typical", r.typicalComposition, r.typicalElapsedMs)}
          ${this.compositionRow(band ? "Selected" : `Slow p${this.selection.percentile}+`, r.slowComposition, r.slowElapsedMs)}
          <div class="tail-composition-legend">${TIME_CATEGORIES.map(cat => {
            const a = r.typicalComposition?.categories.find(c => c.key === cat.key);
            const b = r.slowComposition?.categories.find(c => c.key === cat.key);
            return html`<span style="opacity:${a?.share || b?.share ? 1 : .4}" title="${cat.label} · Typical: ${a ? `${percent(a.share)}, ${ms(a.meanMs)} per span` : "unavailable"} · ${band ? "Selected" : "Slow"}: ${b ? `${percent(b.share)}, ${ms(b.meanMs)} per span` : "unavailable"}"><span class="tail-composition-swatch" style="background:${cat.color}"></span>${cat.label}</span>`;
          })}</div>
        </section>
        <details class="tail-method"><summary>Limits and interpretation</summary>
          <p>These are leads, not proven causes. Request type, payload size, time, or load can change together. Compare similar spans, inspect the shapes, and open traces to test a hypothesis. Producer timers may overlap and are not added as contributions.</p>
          <p>Percentiles are recalculated within the chosen group and include threshold ties. A band overlapping the faster half creates overlapping cohorts. Missing values are excluded from means and comparisons. Catalog percentiles may use a different coverage or approximation.</p>
          <p>The backend analyses at most 24 files and one million matching spans, discovering up to 32 numeric fields or categorical keys. Missing or conflicting units are never guessed.</p>
        </details>
        </div>
      ` : nothing}
      ${expanded ? html`<dialog class="tail-plot-dialog" @close=${() => { this.expandedKey = null; }}>
        <div class="tail-dialog-heading"><h3>${expanded.key}</h3><button @click=${(e: Event) => (e.target as HTMLElement).closest("dialog")?.close()}>Close</button></div>
        <div class="tail-field-means"><span>Typical <strong>${value(expanded.typical, expanded.unit)}</strong></span><span>${band ? "Selected" : "Slow"} <strong>${value(expanded.slow, expanded.unit)}</strong></span></div>
        ${this.plot(expanded, true)}<p class="tail-note">Click a dot to inspect its trace · orange = ${band ? "selected" : "slow"} · linear axes</p>
      </dialog>` : nothing}
    </section>`, this.container);
    const examplesMount = this.container.closest(".detail-panel")?.querySelector<HTMLElement>(".span-tail-examples-mount");
    if (examplesMount) {
      render(r ? html`<div class="tail-examples ${this.busy ? "recomputing" : ""}" ?inert=${this.busy} aria-hidden=${this.busy}>
        <h4>${band ? "Selected" : "Slow"} examples</h4>
        ${r.examples.map(row => html`<button class="secondary" @click=${() => this.jump(row)} title=${row.requestId ?? row.startNs}>${ms(row.elapsedMs)} ↗</button>`)}
      </div>` : nothing, examplesMount);
    }
  }
}
