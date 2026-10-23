import { html, nothing, render, svg } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import type { TailRecord, TailSignal, TailValueAxis } from "../../lib/trace/span-tail-analysis.js";
import { formatHumanDuration } from "../../lib/trace/api_format.js";
import { latencyToHistogramPosition } from "./categorical-histogram-scale.js";
import { renderRecordedFields, tooltipPosition } from "./recorded-fields.js";
import { observePopoverGeometry } from "./popover-geometry.js";

export interface NumericPlotOptions {
  signals: readonly TailSignal[];
  boundaryMs: number;
  percentile: number;
  minMs: number | null;
  maxMs: number | null;
  large: boolean;
  onJump: (record: TailRecord) => void;
}

const number = (n: number) => n !== 0 && Math.abs(n) < .001
  ? n.toPrecision(3) : n.toLocaleString(undefined, { maximumFractionDigits: 3 });
const duration = (ms: number) => formatHumanDuration(ms * 1e6);
const axisNumber = (n: number) => n !== 0 && (Math.abs(n) < .001 || Math.abs(n) >= 1e5)
  ? n.toExponential(1).replace("e+", "e") : number(n);
export function numericAxisTick(n: number, unit: string | null): string {
  if (unit !== "bytes" || Math.abs(n) < 1e3 || Math.abs(n) >= 1e21) return axisNumber(n);
  const prefixes = ["kB", "MB", "GB", "TB", "PB", "EB"];
  const power = Math.min(prefixes.length, Math.floor(Math.log10(Math.abs(n)) / 3));
  const amount = Number((n / 1000 ** power).toPrecision(3));
  return `${amount} ${prefixes[power - 1]}`;
}
const fieldValue = (n: number, unit: string | null) => unit === "bytes" && Math.abs(n) >= 1e3
  ? numericAxisTick(n, unit) : `${number(n)}${unit ? ` ${unit}` : " (unit not recorded)"}`;

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

/** Split at exact display positions without inventing counts within a cell. */
export function densityCellSegments(
  edges: readonly number[], bin: number, lowerMs: number, upperMs: number | null,
): { start: number; end: number; selected: boolean }[] {
  const lower = latencyToHistogramPosition(edges, lowerMs);
  const upper = upperMs == null ? edges.length - 1 : latencyToHistogramPosition(edges, upperMs);
  const cuts = [bin, ...[lower, upper].filter(n => n > bin && n < bin + 1), bin + 1];
  const sorted = [...new Set(cuts)].sort((a, b) => a - b);
  return sorted.slice(0, -1).map((start, index) => {
    const end = sorted[index + 1]!;
    return { start, end, selected: start >= lower && end <= upper };
  });
}

/** One Tab entry per plot; arrow keys move through the bounded trace sample. */
export function traceSampleIndex(current: number, key: string, count: number): number | null {
  if (count < 1) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowLeft") return Math.max(0, current - 1);
  if (key === "ArrowRight") return Math.min(count - 1, current + 1);
  return null;
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
  const tooltipFor = (element: Element) => element.closest(".tail-plot")!.querySelector<HTMLElement>(".tail-plot-tooltip")!;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let tooltipTrigger: Element | null = null;
  let disposeGeometry = () => {};
  const retainTooltip = () => { if (hideTimer != null) clearTimeout(hideTimer); hideTimer = null; };
  const hideTooltip = (event: Event) => { retainTooltip(); tooltipFor(event.currentTarget as Element).hidden = true; };
  const leaveTooltip = (event: Event) => {
    retainTooltip();
    const tooltip = tooltipFor(event.currentTarget as Element);
    hideTimer = setTimeout(() => {
      if (!tooltip.contains(document.activeElement) && document.activeElement !== tooltipTrigger) tooltip.hidden = true;
    }, 180);
  };
  const blurTooltip = (event: FocusEvent) => {
    const tooltip = tooltipFor(event.currentTarget as Element);
    if (!tooltip.contains(event.relatedTarget as Node | null)) hideTooltip(event);
  };
  const showTooltip = (element: Element, content: unknown, x: number, y: number, keyboard: boolean, interactive = false) => {
    retainTooltip();
    tooltipTrigger = element;
    const tooltip = tooltipFor(element);
    render(content, tooltip);
    tooltip.hidden = false;
    const plot = element.closest(".tail-plot")!;
    const plotRect = plot.getBoundingClientRect();
    const svgRect = plot.querySelector("svg")!.getBoundingClientRect();
    const clip = plot.closest(".tail-plot-dialog, .detail-panel")?.getBoundingClientRect();
    const bounds = {
      left: Math.max(8, (clip?.left ?? 0) + 8), top: Math.max(8, (clip?.top ?? 0) + 8),
      right: Math.min(window.innerWidth - 8, (clip?.right ?? window.innerWidth) - 8),
      bottom: Math.min(window.innerHeight - 8, (clip?.bottom ?? window.innerHeight) - 8),
    };
    tooltip.style.maxWidth = `${Math.min(330, bounds.right - bounds.left)}px`;
    tooltip.style.maxHeight = `${bounds.bottom - bounds.top}px`;
    const position = tooltipPosition(
      { x: svgRect.left + x / width * svgRect.width, y: svgRect.top + y / height * svgRect.height },
      tooltip.getBoundingClientRect(), bounds);
    tooltip.style.left = `${position.left - plotRect.left}px`;
    tooltip.style.right = "auto";
    tooltip.style.top = `${position.top - plotRect.top}px`;
    tooltip.setAttribute("role", interactive ? "dialog" : "tooltip");
    tooltip.setAttribute("aria-label", interactive ? "Recorded span details" : "Density cell count");
    tooltip.setAttribute("aria-live", keyboard ? "polite" : "off");
  };
  const pointTooltip = (element: Element, elapsed: number, raw: number, row: TailRecord, keyboard: boolean) => showTooltip(element, html`
    <strong>${duration(elapsed)} elapsed</strong>
    <span>${signal.key}: ${fieldValue(raw * axis.multiplier, axis.unit)}</span>
    <button type="button" class="tail-tooltip-trace" @click=${() => options.onJump(row)}>Open trace focused on this span ↗</button>
    ${renderRecordedFields(row)}
    ${keyboard ? html`<small>Left/right choose samples · Enter opens the trace · Tab inspects fields</small>` : nothing}`, px(elapsed), py(raw * axis.multiplier), keyboard, true);
  const cellTooltip = (element: Element, x: number, y: number, keyboard: boolean) => {
    if (!density) return;
    const count = density.counts[y * xBins + x]!;
    const split = densityCellSegments(edges, x, options.boundaryMs, options.maxMs).length > 1;
    showTooltip(element, html`<strong>${number(count)} ${count === 1 ? "span" : "spans"} in whole cell</strong>
      <span>${duration(edges[x]!)}–${duration(edges[x + 1]!)} elapsed</span>
      <span>${signal.key}: ${fieldValue(density.valueEdges[y]!, axis.unit)}–${fieldValue(density.valueEdges[y + 1]!, axis.unit)}</span>
      <small>${split ? "Colors split at the cutoff; the count covers both parts. " : ""}Upper bounds ${x === xBins - 1 && y === yBins - 1 ? "included" : "excluded except final bins"}</small>`,
    left + (x + .5) / xBins * (right - left), py(density.valueEdges[y + 1]!), keyboard);
  };
  let keyboardCell = density ? Math.max(0, density.counts.indexOf(density.maxCount)) : 0;
  const keydown = (event: KeyboardEvent) => {
    if (!density || event.target !== event.currentTarget) return;
    let x = keyboardCell % xBins, y = Math.floor(keyboardCell / xBins);
    if (event.key === "ArrowLeft") x = Math.max(0, x - 1);
    else if (event.key === "ArrowRight") x = Math.min(xBins - 1, x + 1);
    else if (event.key === "ArrowUp") y = Math.min(yBins - 1, y + 1);
    else if (event.key === "ArrowDown") y = Math.max(0, y - 1);
    else if (event.key === "Escape") { hideTooltip(event); return; }
    else return;
    keyboardCell = y * xBins + x;
    cellTooltip(event.currentTarget as Element, x, y, true);
    event.preventDefault();
  };
  return html`<div class="tail-plot">
    <svg class="tail-scatter" viewBox="0 0 ${width} ${height}" role="group" tabindex=${density ? "0" : "-1"}
      aria-label="${signal.key}; ${axis.unit ?? "unit not recorded"} against span elapsed time; logarithmic elapsed axis, linear value axis. ${density ? `${number(density.count)} observations in the density grid; arrow keys inspect cells.` : "Trace-linked point sample; density unavailable in this cached report."}"
      @keydown=${keydown}
      @focus=${(event: FocusEvent) => { if (density) cellTooltip(event.currentTarget as Element, keyboardCell % xBins, Math.floor(keyboardCell / xBins), true); }}
      @blur=${blurTooltip} @pointerleave=${leaveTooltip}>
      ${[0, .5, 1].map(f => svg`<text x=${left - 6} y=${py(axis.minimum + f * (axis.maximum - axis.minimum)) + 4} text-anchor="end">${numericAxisTick(axis.minimum + f * (axis.maximum - axis.minimum), axis.unit)}</text>`)}
      ${density ? density.counts.map((count, index) => {
        if (!count) return nothing;
        const x = index % xBins, y = Math.floor(index / xBins);
        const cellY = py(density.valueEdges[y + 1]!);
        const cellHeight = (density.valueEdges[y + 1]! - density.valueEdges[y]!) / (axis.maximum - axis.minimum) * (bottom - top) + .1;
        return svg`<rect class="tail-density-cell" x=${left + x / xBins * (right - left)}
          y=${cellY} width=${(right - left) / xBins}
          height=${cellHeight} fill=${densityColor(count, density.maxCount)}
          data-count=${count} data-cell-index=${index}
          @pointerenter=${(event: PointerEvent) => cellTooltip(event.currentTarget as Element, x, y, false)}></rect>
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
      ${signal.points.map(([elapsed, raw, row], index) => svg`<circle class="tail-trace-point"
        cx=${px(elapsed)} cy=${py(raw * axis.multiplier)} r=${options.large ? 3 : 2.5} fill="#121c27"
        stroke=${densityColor(1, 1, elapsed >= options.boundaryMs && (options.maxMs == null || elapsed <= options.maxMs))}
        stroke-width="1.4" tabindex=${index === 0 ? "0" : "-1"} role="link"
        aria-keyshortcuts="ArrowLeft ArrowRight Home End Enter Escape"
        aria-label="${duration(elapsed)} elapsed; ${signal.key} ${fieldValue(raw * axis.multiplier, axis.unit)}. Open trace focused on this span."
        @pointerenter=${(event: PointerEvent) => pointTooltip(event.currentTarget as Element, elapsed, raw, row, false)}
        @pointerleave=${leaveTooltip}
        @focus=${(event: FocusEvent) => {
          const element = event.currentTarget as SVGCircleElement;
          element.ownerSVGElement!.querySelectorAll(".tail-trace-point").forEach(point => point.setAttribute("tabindex", point === element ? "0" : "-1"));
          pointTooltip(element, elapsed, raw, row, true);
        }}
        @blur=${blurTooltip}
        @click=${() => options.onJump(row)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Enter") { event.preventDefault(); options.onJump(row); }
          else if (event.key === "Escape") hideTooltip(event);
          else {
            const next = traceSampleIndex(index, event.key, signal.points.length);
            if (next == null) return;
            (event.currentTarget as SVGCircleElement).ownerSVGElement!.querySelectorAll<SVGCircleElement>(".tail-trace-point")[next]?.focus();
            event.preventDefault();
          }
        }}></circle>`)}
      <text x=${(left + right) / 2} y=${height - 3} text-anchor="middle">Span elapsed (ms · log scale) →</text>
    </svg>
    <div class="tail-plot-tooltip" role="tooltip" hidden
      ${ref(element => {
        // Imperative details belong to this plotted report and its handlers.
        disposeGeometry();
        disposeGeometry = () => {};
        retainTooltip();
        if (!element) return;
        const tooltip = element as HTMLElement;
        tooltip.hidden = true;
        const plot = element.closest(".tail-plot")!;
        const targets = [plot, plot.querySelector("svg"), plot.closest(".tail-plot-dialog, .detail-panel")]
          .filter((target): target is Element => target != null);
        disposeGeometry = observePopoverGeometry(targets, () => {
          if (tooltip.hidden) return;
          retainTooltip();
          if (tooltip.contains(document.activeElement)) (tooltipTrigger as HTMLElement | null)?.focus({ preventScroll: true });
          tooltip.hidden = true;
        });
      })}
      @pointerenter=${retainTooltip} @pointerleave=${leaveTooltip} @focusout=${blurTooltip}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        (tooltipTrigger as HTMLElement | null)?.focus({ preventScroll: true });
        hideTooltip(event);
        event.preventDefault();
        event.stopPropagation();
      }}></div>
    <div class="tail-density-legend">${density ? html`
      <span>${number(density.count)} recorded spans</span>
      <span class="tail-density-key"><i style="background-image:linear-gradient(to right,${densityColor(1, density.maxCount)},${densityColor(density.maxCount, density.maxCount)}),linear-gradient(to right,${densityColor(1, density.maxCount, true)},${densityColor(density.maxCount, density.maxCount, true)})"></i>1–${number(density.maxCount)} / cell</span>
      <span class="tail-trace-key">○ ${number(signal.points.length)} trace links</span>` : html`<span class="tail-trace-key">○ ${number(signal.points.length)} trace links</span>`}
    </div>
  </div>`;
}
