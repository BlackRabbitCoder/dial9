import { html, nothing, svg } from "lit-html";
import type { TailRecord, TailSignal, TailValueAxis } from "../../lib/trace/span-tail-analysis.js";
import { latencyToHistogramPosition } from "./categorical-histogram-scale.js";
import { axisNumber, densityCellSegments, duration, fieldValue, number, numericAxisTick } from "./numeric-presentation.js";
import { numericPlotDetails } from "./numeric-plot-details.js";

export { densityCellSegments, numericAxisTick } from "./numeric-presentation.js";

export interface NumericPlotOptions {
  signals: readonly TailSignal[];
  boundaryMs: number;
  percentile: number;
  minMs: number | null;
  maxMs: number | null;
  large: boolean;
  onJump: (record: TailRecord) => void;
}

/** Older cached reports have no full-observation axis or density grid. */
export function numericValueAxis(signal: TailSignal): TailValueAxis {
  if (signal.valueAxis) return signal.valueAxis;
  let minimum = 0, maximum = 0;
  for (const [, value] of signal.points) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return { unit: signal.unit, multiplier: 1, minimum, maximum: maximum > minimum ? maximum : minimum + 1 };
}

/** Count colors use the returned maximum; a sampled point never adds density. */
export function densityColor(count: number, maxCount: number, selected = false): string {
  if (count <= 0) return "transparent";
  const amount = maxCount <= 1 ? 1 : Math.log1p(count) / Math.log1p(maxCount);
  return `hsl(${selected ? 31 : 194} 80% ${18 + amount * 42}%)`;
}

function elapsedEdges(signal: TailSignal, options: NumericPlotOptions): readonly number[] {
  if (signal.density) return signal.density.elapsedEdgesMs;
  // A display-only fallback for old reports. It does not infer missing density.
  const times = options.signals.flatMap(s => s.points.map(([elapsed]) => elapsed)).filter(n => n > 0);
  const low = times.length ? 10 ** Math.floor(Math.log10(Math.min(...times))) : 1e-6;
  const maximum = Math.max(low, options.boundaryMs, options.maxMs ?? 0, ...times);
  const high = Math.max(low * 10, 10 ** Math.ceil(Math.log10(maximum)));
  return [0, ...Array.from({ length: 37 }, (_, i) => low * (high / low) ** (i / 36))];
}

/** Renders backend count cells and a distinct bounded sample of trace links. */
export function renderNumericPlot(signal: TailSignal, options: NumericPlotOptions) {
  if (!signal.points.length && !signal.density?.count) {
    return html`<div class="tail-empty-plot">No recorded values available</div>`;
  }
  const density = signal.density;
  const axis = numericValueAxis(signal);
  const edges = elapsedEdges(signal, options);
  const xBins = edges.length - 1;
  const yBins = density ? density.valueEdges.length - 1 : 0;
  const band = options.minMs != null || options.maxMs != null;
  const width = options.large ? 700 : 400, height = options.large ? 340 : 225;
  const left = options.large ? 82 : 58, right = width - 18, top = band ? 46 : 32, bottom = height - 43;
  const px = (x: number) => left + latencyToHistogramPosition(edges, x) / xBins * (right - left);
  const py = (y: number) => bottom - (y - axis.minimum) / (axis.maximum - axis.minimum) * (bottom - top);
  const tickStart = Math.ceil(Math.log10(edges[1]!));
  const tickEnd = Math.floor(Math.log10(edges.at(-1)!));
  const tickStride = Math.max(1, Math.ceil((tickEnd - tickStart + 1) / 4));
  const ticks = [0];
  for (let exponent = tickStart; exponent <= tickEnd; exponent += tickStride) ticks.push(10 ** exponent);
  if (ticks.at(-1)! < edges.at(-1)!) ticks.push(edges.at(-1)!);
  const marker = (elapsed: number, label: string, y: number) => {
    if (elapsed < edges[0]! || elapsed > edges.at(-1)!) {
      return svg`<text class="tail-cutoff-label" x=${elapsed < edges[0]! ? left : right} y=${y}
        text-anchor=${elapsed < edges[0]! ? "start" : "end"}>${label} · off scale</text>`;
    }
    const end = px(elapsed) > (left + right) / 2;
    return svg`<g class="tail-boundary">
      <path d="M${px(elapsed)} ${top}V${bottom}" stroke="#f6ae65" stroke-dasharray="3 4" opacity=".85"></path>
      <text class="tail-cutoff-label" x=${end ? px(elapsed) - 4 : px(elapsed) + 4} y=${y} text-anchor=${end ? "end" : "start"}>${label}</text>
    </g>`;
  };
  return html`<div class="tail-plot">
    <svg class="tail-scatter" viewBox="0 0 ${width} ${height}" role="group" tabindex=${density ? "0" : "-1"}
      aria-label="${signal.key}; ${axis.unit ?? "unit not recorded"} against span elapsed time; logarithmic elapsed axis, linear value axis. ${density ? `${number(density.count)} observations in the density grid; arrow keys inspect cells.` : "Trace-linked point sample; density unavailable in this cached report."}">
      ${[0, .5, 1].map(f => svg`<text x=${left - 6} y=${py(axis.minimum + f * (axis.maximum - axis.minimum)) + 4} text-anchor="end">${numericAxisTick(axis.minimum + f * (axis.maximum - axis.minimum), axis.unit)}</text>`)}
      ${density ? density.counts.map((count, index) => {
        if (!count) return nothing;
        const x = index % xBins, y = Math.floor(index / xBins);
        const cellY = py(density.valueEdges[y + 1]!);
        const cellHeight = (density.valueEdges[y + 1]! - density.valueEdges[y]!) / (axis.maximum - axis.minimum) * (bottom - top) + .1;
        return svg`<rect class="tail-density-cell" x=${left + x / xBins * (right - left)}
          y=${cellY} width=${(right - left) / xBins}
          height=${cellHeight} fill=${densityColor(count, density.maxCount)}
          data-count=${count} data-cell-index=${index}></rect>
          ${densityCellSegments(edges, x, options.boundaryMs, options.maxMs).filter(segment => segment.selected).map(segment => svg`
          <rect class="tail-density-selected" x=${left + segment.start / xBins * (right - left)}
          y=${cellY} width=${(segment.end - segment.start) / xBins * (right - left)}
          height=${cellHeight} fill=${densityColor(count, density.maxCount, true)}
          data-cell-index=${index} pointer-events="none"></rect>`)}`;
      }) : nothing}
      ${[0, .5, 1].map(f => svg`<path d="M${left} ${py(axis.minimum + f * (axis.maximum - axis.minimum))}H${right}" stroke="#516475" stroke-opacity=".55" stroke-dasharray="2 3" pointer-events="none"></path>`)}
      ${ticks.map((elapsed, i) => svg`<text x=${px(elapsed)} y=${bottom + 17} text-anchor=${i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}>${elapsed === 0 ? "0" : axisNumber(elapsed)}</text>`)}
      <path d="M${left} ${top}V${bottom}H${right}" fill="none" stroke="#687584" pointer-events="none"></path>
      <text x=${left} y="13" class="tail-axis-unit">${axis.unit ?? "unit not recorded"}</text>
      ${marker(options.boundaryMs, band ? `Start: ${duration(options.boundaryMs)}` : `p${options.percentile}: ${duration(options.boundaryMs)}`, 27)}
      ${band && options.maxMs != null ? marker(options.maxMs, `End: ${duration(options.maxMs)}`, 41) : nothing}
      ${signal.points.map(([elapsed, raw], index) => svg`<circle class="tail-trace-point"
        cx=${px(elapsed)} cy=${py(raw * axis.multiplier)} r=${options.large ? 3 : 2.5} fill="#121c27"
        stroke=${densityColor(1, 1, elapsed >= options.boundaryMs && (options.maxMs == null || elapsed <= options.maxMs))}
        stroke-width="1.4" tabindex=${index === 0 ? "0" : "-1"} role="link"
        aria-keyshortcuts="ArrowLeft ArrowRight Home End Enter Escape"
        aria-label="${duration(elapsed)} elapsed; ${signal.key} ${fieldValue(raw * axis.multiplier, axis.unit)}. Open trace focused on this span."
        data-point-index=${index}></circle>`)}
      <text x=${(left + right) / 2} y=${height - 3} text-anchor="middle">Span elapsed (ms · log scale) →</text>
    </svg>
    <div class="tail-plot-tooltip" role="tooltip" hidden
      ${numericPlotDetails({
        signal, axis,
        interval: { lowerMs: options.boundaryMs, upperMs: options.maxMs },
        onJump: options.onJump,
      })}></div>
    <div class="tail-density-legend">${density ? html`
      <span>${number(density.count)} recorded spans</span>
      <span class="tail-density-key"><i style="background-image:linear-gradient(to right,${densityColor(1, density.maxCount)},${densityColor(density.maxCount, density.maxCount)}),linear-gradient(to right,${densityColor(1, density.maxCount, true)},${densityColor(density.maxCount, density.maxCount, true)})"></i>1–${number(density.maxCount)} / cell</span>
      <span class="tail-trace-key">○ ${number(signal.points.length)} trace links</span>` : html`<span class="tail-trace-key">○ ${number(signal.points.length)} trace links</span>`}
    </div>
  </div>`;
}
