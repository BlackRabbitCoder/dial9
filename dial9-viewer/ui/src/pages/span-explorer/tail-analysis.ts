import { html, nothing, render, type TemplateResult } from "lit-html";
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
import { renderPropertyHistograms } from "./categorical-histograms.js";
import { correlationLabel } from "./correlation-label.js";
import { renderNumericPlot } from "./numeric-plot.js";
import { renderPropertyCohorts } from "./property-cohorts.js";
import { formatHumanDuration } from "../../lib/trace/api_format.js";
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
  n == null || !Number.isFinite(n) ? "unavailable"
    : n !== 0 && Math.abs(n) < 10 ** -digits ? n.toPrecision(3)
    : n.toLocaleString(undefined, { maximumFractionDigits: digits });
const ms = (n: number | null) => n == null ? "unavailable" : formatHumanDuration(n * 1e6);
const percent = (n: number) => `${number(n * 100, 1)}%`;
function value(n: number | null, unit: string | null): string {
  if (n == null) return "unavailable";
  if (unit === "ns") return ms(n / 1e6);
  if (unit === "us" || unit === "µs" || unit === "μs") return ms(n / 1000);
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
  private info: { title: string; body: TemplateResult; trigger: HTMLElement } | null = null;
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
      this.info = null;
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
    this.info = null;
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
        const rawBytes = this.rawBytes ?? await fetchRawTraceBytes(context.scope.trace, location.origin, context.headers,
          (url, init) => fetch(url, { ...init, signal: request.signal }));
        if (generation !== this.generation) return;
        this.rawBytes = rawBytes;
        // A raw trace has its own complete scope. Its bytes are decoded by Rust.
        url.searchParams.delete("start_ns");
        url.searchParams.delete("end_ns");
        options = { method: "POST", headers: { "content-type": "application/octet-stream" }, body: rawBytes, signal: request.signal };
      }
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(`Backend analysis failed (${response.status}): ${await response.text()}`);
      const reply: TailResponse = await response.json();
      if (generation !== this.generation) return;
      // Old cached reports may still include fields that repeat elapsed time.
      this.report = { ...reply.report, signals: reply.report.signals.filter(signal => !signal.duplicatesLatency) };
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

  private explain(event: Event, title: string, body: TemplateResult): void {
    const trigger = event.currentTarget as HTMLElement;
    trigger.focus();
    this.info = { title, body, trigger };
    this.draw();
    this.container?.querySelector<HTMLDialogElement>(".tail-info-dialog")?.showModal();
  }

  private observationExplanation(signal: TailSignal): TemplateResult {
    const selected = this.selection.minMs != null || this.selection.maxMs != null;
    const groups = [
      { name: "Typical", count: signal.typicalCount, coverage: signal.typicalCoverage },
      { name: selected ? "Selected" : "Slow", count: signal.slowCount, coverage: signal.slowCoverage },
    ];
    return html`<p>${signal.key}</p>
      <dl class="tail-info-values">${groups.map(group => html`<dt>${group.name}</dt>
        <dd>${number(group.count, 0)} recorded values · ${percent(group.coverage)} coverage</dd>`)}</dl>
      <ul>${groups.flatMap(group => [
        group.count < 20 ? html`<li>${group.name} has ${group.count} recorded values; at least 20 are required.</li>` : nothing,
        group.coverage < .5 ? html`<li>${group.name} records this field for ${percent(group.coverage)} of spans; at least 50% coverage is required.</li>` : nothing,
      ])}</ul>
      <p>The badge appears below either threshold in either group. Missing values are excluded; they are never treated as zero. The visible difference can be unstable with few observations or selective recording.</p>`;
  }

  private plot(signal: TailSignal, large = false) {
    return renderNumericPlot(signal, {
      signals: this.report?.signals ?? [],
      boundaryMs: this.report!.boundaryMs,
      percentile: this.selection.percentile,
      minMs: this.selection.minMs,
      maxMs: this.selection.maxMs,
      large,
      onJump: row => this.jump(row),
    });
  }

  private signal(signal: TailSignal, i: number) {
    const band = this.selection.minMs != null || this.selection.maxMs != null;
    const limited = Math.min(signal.typicalCount, signal.slowCount) < 20 || Math.min(signal.typicalCoverage, signal.slowCoverage) < 0.5;
    return html`<article class="tail-field">
      <div class="tail-field-heading"><h4><span class="tail-rank" title="Ordered by the backend's comparison of group distributions; limited observations come last.">${i + 1}</span>${signal.key}</h4>
        <button class="tail-expand" aria-label="Enlarge ${signal.key} plot" title="Enlarge plot" @click=${() => this.expand(signal)}>⤢</button>
      </div>
      <div class="tail-field-means"><span><span class="tail-dot typical"></span>Typical <strong>${value(signal.typical, signal.unit)}</strong></span>
        <span><span class="tail-dot slow"></span>${band ? "Selected" : "Slow"} <strong>${value(signal.slow, signal.unit)}</strong></span></div>
      ${this.plot(signal)}
      <div class="tail-signal-stats">
        <button class="tail-correlation" type="button" aria-label="${correlationLabel(signal.correlation)}: explain ${signal.key} correlation"
          @click=${(event: Event) => this.explain(event, correlationLabel(signal.correlation), html`
            <dl class="tail-info-values"><dt>Spearman rank correlation</dt><dd>${number(signal.correlation, 4)}</dd>
              <dt>Recorded spans compared</dt><dd>${number(signal.correlationCount, 0)}</dd></dl>
            <p>Spearman compares the order of field values with the order of elapsed times. +1 means both orders match perfectly; −1 means they are perfectly reversed. Near zero means no consistent increase or decrease; separate clusters can still exist.</p>
            <p>The backend compares up to 2,048 recorded observations sampled across latency ranks. Labels use the magnitude: below 0.1 not correlated, 0.1–0.3 weak, 0.3–0.7 moderate, and 0.7–1 high. Only exactly +1 or −1 is called perfect. This is descriptive and does not prove a cause.</p>`)}>
          ${correlationLabel(signal.correlation)} <span aria-hidden="true">ⓘ</span>
        </button>
      </div>
      <div class="tail-signal-meta">
        <button class="tail-meta-button" type="button" @click=${(event: Event) => this.explain(event, "Repetition across source files", html`
          <p>${signal.key}: ${signal.filesAgree} of ${signal.filesCompared} qualifying files reproduce the overall direction of the typical/slow value comparison: higher or lower values.</p>
          <p>A file qualifies with at least five recorded values in both groups. ${signal.filesCompared ? "Agreement is repetition, not a significance test or a cause." : "No files met that threshold; repetition cannot be checked."}</p>`)}>
          ${signal.filesCompared ? `${signal.filesAgree}/${signal.filesCompared} files agree` : "File check unavailable"} <span aria-hidden="true">ⓘ</span>
        </button>
        ${signal.typicalCoverage < 1 || signal.slowCoverage < 1 ? html`<span title="Recorded-value coverage: typical / slow. Missing values are excluded, never treated as zero.">${percent(signal.typicalCoverage)} / ${percent(signal.slowCoverage)} coverage</span>` : nothing}
      </div>
      ${limited ? html`<button class="tail-badge" type="button" aria-label="Explain limited observations for ${signal.key}"
        @click=${(event: Event) => this.explain(event, "Limited observations", this.observationExplanation(signal))}>Limited observations <span aria-hidden="true">ⓘ</span></button>` : nothing}
    </article>`;
  }

  private compositionRow(label: string, composition: TailComposition | null | undefined, elapsed: number | null) {
    return html`<div class="tail-composition-row">
      <div class="tail-composition-label">${label}
        ${composition && composition.detailedCoverage < 1 ? html`<button class="tail-composition-quality" type="button"
          @click=${(event: Event) => this.explain(event, `${label} time detail`, html`
            <p>${number(composition.detailedCount, 0)} of ${number(composition.count, 0)} spans have complete time detail (${percent(composition.detailedCoverage)}).</p>
            <p>Missing composition contributes Unknown. The bar shows the average share per span, while the category durations are means across the group. These are estimates of recorded time, not the cause of a wait.</p>`)}>
          ${composition.detailedCoverage > .9995 ? "<100%" : percent(composition.detailedCoverage)} detailed <span aria-hidden="true">ⓘ</span>
        </button>` : nothing}
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
    const info = this.info;
    const expanded = r?.signals.find(s => s.key === this.expandedKey);
    const histograms = r?.histograms ?? [];
    const histogram = histograms.find(h => h.key === this.categoryKey) ?? histograms[0];
    const group = r?.groups.find(g => g.key === histogram?.key);
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
        ${this.sourceUsed < this.sourceCount || this.truncated || this.fieldsTruncated ? html`<button class="tail-warning tail-warning-button" type="button"
          @click=${(event: Event) => this.explain(event, "Partial source coverage", html`
            <dl class="tail-info-values"><dt>Source files read</dt><dd>${this.sourceUsed} of ${this.sourceCount}</dd>
              <dt>Matching spans analysed</dt><dd>${number(r.count, 0)}</dd></dl>
            <p>The backend reads at most 24 files and one million matching spans.${this.truncated ? " The one-million-span cap was reached." : ""}${this.fieldsTruncated ? " A numeric or categorical field limit was reached." : ""}</p>
            <p>These graphs describe the loaded scope. Unread files or unrecorded fields may contain different patterns.</p>`)}>
          Partial sample · ${this.sourceUsed}/${this.sourceCount} files <span aria-hidden="true">ⓘ</span>
        </button>` : nothing}
        ${r.slowCount < 20 ? html`<button class="tail-warning tail-warning-button" type="button" @click=${(event: Event) => this.explain(event, "Few comparison spans", html`
          <p>${number(r.slowCount, 0)} ${band ? "selected" : "slow"} spans are compared with ${number(r.typicalCount, 0)} typical spans. At least 20 recorded values in each group are needed to avoid the limited-observation badge on a field.</p>
          <p>Widen the group or time window before relying on this difference. A small observed tail can change substantially when more spans arrive.</p>`)}>
          Only ${r.slowCount} ${band ? "selected" : "slow"} spans <span aria-hidden="true">ⓘ</span>
        </button>` : nothing}
        ${renderPropertyHistograms(histograms, {
          selectedKey: this.categoryKey,
          mode: this.categoryMode,
          selection: band ? { minMs: this.selection.minMs, maxMs: this.selection.maxMs } : null,
          onSelectProperty: key => { this.categoryKey = key; this.draw(); },
          onModeChange: mode => { this.categoryMode = mode; this.draw(); },
          onSelectRange: (minMs, maxMs) => this.context?.onBand(minMs, maxMs),
        })}
        ${r.propertyScreen?.examined ? html`<details class="tail-property-screen"><summary>
          ${r.propertyScreen.shown}/${r.propertyScreen.examined} properties show differences
        </summary><div>
          <p>${r.propertyScreen.similarDistributions} show no clear difference in this sample; ${r.propertyScreen.limitedObservations} lack enough observations; ${r.propertyScreen.limitedCoverage} have limited recorded coverage.</p>
          <p>The backend requires at least ${r.propertyScreen.minimumSamples} spans per compared value and ${percent(r.propertyScreen.minimumCoverage)} property coverage. It keeps distribution gaps above ${percent(r.propertyScreen.minimumCdfGap)} after a sampling margin, or p99 ratios above ${number(r.propertyScreen.minimumTailRatio)}× with at least ${r.propertyScreen.minimumTailSamples} spans per value.</p>
          ${histogram?.relevance ? html`<p>${histogram.key}: ${histogram.relevance.reason === "tail"
            ? `p99 difference; conservative ratio ${number(histogram.relevance.tailRatioLowerBound)}×`
            : `distribution gap ${percent(histogram.relevance.cdfGap)} with ${percent(histogram.relevance.cdfMargin)} sampling margin`}.</p>` : nothing}
          <p>${r.propertyScreen.interpretation}</p>
        </div></details>` : nothing}
        ${group ? renderPropertyCohorts(group, r, band, histogram?.values.map(value => value.value)) : nothing}
        <section class="tail-numeric" aria-label="Numeric fields"><div class="tail-chart-heading"><h4>Numeric fields against elapsed time</h4>
          <span class="tail-legend"><span class="tail-dot typical"></span>Other spans <span class="tail-dot slow"></span>${band ? "Selected" : "Slow"}</span>
          <details class="tail-chart-help"><summary>Reading these charts</summary><div id="tail-chart-guide">
            <p>Blue marks other spans; orange marks ${band ? "the selection" : "slow spans"}. Brighter cells contain more observations. Colors split at the cutoff; counts cover whole cells. Hover or focus the plot and use arrow keys for counts. Outlined dots are trace samples; hover or focus one before opening its trace.</p>
            <p>X uses logarithmic elapsed time with a zero-inclusive first bin. Y is linear in the displayed unit. The backend shares limits across fields with the same unit and converts declared time units to milliseconds. Unknown units stay separate. Orange dashed lines mark the labelled slow cutoff or selection endpoints.</p>
            <p>Fields are ordered by the backend's comparison of group distributions, with limited observations last. Correlation describes a separate pattern. These are associations, not causes; click a badge for its definition and recorded counts.</p>
          </div></details>
        </div>
        ${r.signals.some(signal => !signal.density) ? html`<button class="tail-badge tail-cached-plots" type="button"
          @click=${(event: Event) => this.explain(event, "Cached point samples", html`
            <p>These fields have no full-observation density grid in this cached report: ${r.signals.filter(signal => !signal.density).map(signal => signal.key).join(", ")}.</p>
            <p>The outlined dots are bounded trace samples and cannot show how dense the underlying data is. Reports from the current backend include exact cell counts and shared unit axes; no missing density or unit information is inferred here.</p>`)}>
          Point samples · density unavailable in cached result <span aria-hidden="true">ⓘ</span>
        </button>` : nothing}
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
          <p>The backend analyses at most 24 files and one million matching spans, discovering up to 128 numeric candidates, reporting up to 32 numeric fields, and retaining up to 32 categorical keys. Missing or conflicting units are never guessed.</p>
        </details>
        </div>
      ` : nothing}
      ${expanded ? html`<dialog class="tail-plot-dialog" @close=${() => { this.expandedKey = null; }}>
        <div class="tail-dialog-heading"><h3>${expanded.key}</h3><button @click=${(e: Event) => (e.target as HTMLElement).closest("dialog")?.close()}>Close</button></div>
        <div class="tail-field-means"><span>Typical <strong>${value(expanded.typical, expanded.unit)}</strong></span><span>${band ? "Selected" : "Slow"} <strong>${value(expanded.slow, expanded.unit)}</strong></span></div>
        ${this.plot(expanded, true)}<p class="tail-note">Click a dot to inspect its trace · orange = ${band ? "selected" : "slow"} · logarithmic elapsed axis</p>
      </dialog>` : nothing}
      ${info ? html`<dialog class="tail-info-dialog" aria-labelledby="tail-info-title" @close=${() => {
        if (this.info !== info) return;
        this.info = null;
        this.draw();
        info.trigger.focus();
      }}>
        <div class="tail-dialog-heading"><h3 id="tail-info-title">${info.title}</h3>
          <button type="button" @click=${(event: Event) => (event.currentTarget as HTMLElement).closest("dialog")?.close()}>Close</button></div>
        ${info.body}
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
