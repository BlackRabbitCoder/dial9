import { html, svg } from "lit-html";
import type { CategoricalHistogram, CategoryLatency } from "../../lib/trace/span-tail-analysis.js";

const colors = ["#64c9f3", "#d6a0ff", "#f5bc64", "#79d6af", "#f78da7", "#96a8ff"];
const number = (n: number, digits = 3) => n.toLocaleString(undefined, { maximumFractionDigits: digits });
const ms = (n: number) => `${number(n, n < .001 ? 6 : 3)} ms`;
const percent = (n: number) => `${number(n * 100, 1)}%`;

function legend(value: CategoryLatency, color: string) {
  return html`<div class="tail-category-value">
    <span class="tail-category-name"><i style="background:${color}"></i><strong>${value.value}</strong>
      <span class="tail-muted">${number(value.count, 0)} spans</span></span>
    <span class="tail-category-p99" title="Observed 99th percentile within this value; ties included. Median: ${ms(value.medianMs)}">
      p99 <strong style="color:${color}">${ms(value.p99Ms)}</strong>
    </span>
    ${value.count < 20 ? html`<span class="tail-badge">Few spans</span>` : ""}
  </div>`;
}

function plot(histogram: CategoricalHistogram, series: { value: CategoryLatency; color: string }[], compact: boolean, axis: boolean) {
  const bins = histogram.binEdgesMs.length - 1;
  const maximum = Math.min(1, Math.ceil(histogram.maxShare * 10) / 10);
  const low = histogram.binEdgesMs[1]!;
  const high = histogram.binEdgesMs[bins]!;
  const lowExponent = Math.round(Math.log10(low));
  const highExponent = Math.round(Math.log10(high));
  const exponentStep = Math.max(1, Math.ceil((highExponent - lowExponent) / 4));
  // Mark powers of ten rather than arbitrary bucket edges. The first bucket
  // is the explicit zero-inclusive range before the logarithmic buckets.
  const ticks = [{ position: 0, label: `0–${number(low, low < .001 ? 6 : 3)}` }];
  for (let exponent = lowExponent + exponentStep; exponent <= highExponent; exponent += exponentStep) {
    const latency = 10 ** exponent;
    ticks.push({
      position: 1 + (exponent - lowExponent) / (highExponent - lowExponent) * (bins - 1),
      label: number(latency, latency < .001 ? 6 : 3),
    });
  }
  if (ticks.at(-1)!.position < bins) ticks.push({ position: bins, label: number(high, high < .001 ? 6 : 3) });
  const step = (shares: number[]) => {
    let path = "M0 1";
    shares.forEach((share, i) => { path += `V${1 - share / maximum}H${i + 1}`; });
    return `${path}V1Z`;
  };
  return html`<div class="tail-category-plot ${compact ? "compact" : ""} ${axis ? "with-axis" : ""}">
    <div class="tail-category-y"><span>${percent(maximum)}</span><span>${percent(maximum / 2)}</span><span>0%</span></div>
    <div class="tail-category-canvas">
      <svg viewBox="0 0 ${bins} 1" preserveAspectRatio="none" role="img"
        aria-label="${histogram.key}: ${series.map(s => s.value.value).join(" versus ")} latency distributions. Percent of spans within each value; elapsed milliseconds in shared logarithmic bins.">
        ${[0, .5, 1].map(y => svg`<path d="M0 ${y}H${bins}" class="tail-category-grid"></path>`)}
        ${ticks.map(t => svg`<path d="M${t.position} 0V1" class="tail-category-grid"></path>`)}
        ${series.map((s, i) => svg`<path style="stroke-width:${series.length > 1 && i === 0 ? 3 : 1.8}" class="tail-category-distribution" d=${step(s.value.shares)} fill=${s.color} stroke=${s.color} fill-opacity=${series.length > 1 ? .14 : .3}></path>`)}
        ${Array.from({ length: bins }, (_, i) => svg`<rect class="tail-category-bin" x=${i} y="0" width="1" height="1">
          <title>${ms(histogram.binEdgesMs[i]!)}–${ms(histogram.binEdgesMs[i + 1]!)}${i === bins - 1 ? " (upper bound included)" : " (upper bound excluded)"}${series.map(s => `\n${s.value.value}: ${percent(s.value.shares[i]!)} of its spans`).join("")}</title>
        </rect>`)}
      </svg>
      ${axis ? html`<div class="tail-category-x">
        ${ticks.map((tick, t) => html`<span class="${t === 0 ? "first" : t === ticks.length - 1 ? "last" : ""}" style="left:${tick.position / bins * 100}%">${tick.label}</span>`)}
      </div><div class="tail-category-axis-label">Elapsed (ms · log bins) →</div>` : ""}
    </div>
  </div>`;
}

/** Draws backend-computed distributions with shared X/Y scales. */
export function renderCategoricalHistogram(histogram: CategoricalHistogram) {
  const series = histogram.values.map((value, i) => ({ value, color: colors[i % colors.length]! }));
  const overlay = series.length === 2;
  return html`<section class="tail-category-chart ${overlay ? "overlay" : "stack"}">
    <div class="tail-category-caption"><span>% of spans within each value</span>
      ${histogram.missingCount ? html`<span>${number(histogram.missingCount, 0)} missing values excluded</span>` : ""}
    </div>
    ${overlay ? html`<div class="tail-category-overlay-legend">${series.map(s => legend(s.value, s.color))}</div>
      ${plot(histogram, series, false, true)}` : series.map((s, i) => html`<div class="tail-category-row">
        ${legend(s.value, s.color)}${plot(histogram, [s], true, i === series.length - 1)}
      </div>`)}
  </section>`;
}
