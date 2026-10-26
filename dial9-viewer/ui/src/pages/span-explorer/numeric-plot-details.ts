import { html, nothing, render } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import type { TailRecord, TailSignal, TailValueAxis } from "../../lib/trace/span-tail-analysis.js";
import { densityCellSegments, duration, fieldValue, number } from "./numeric-presentation.js";

interface NumericPlotDetailsModel {
  signal: Pick<TailSignal, "key" | "points" | "density">;
  axis: TailValueAxis;
  interval: { lowerMs: number; upperMs: number | null };
  onJump: (record: TailRecord) => void;
}

/** Own details for one plotted report. Marks identify their point/cell indices. */
export function numericPlotDetails(model: NumericPlotDetailsModel) {
  let dispose = () => {};
  let generation = 0;
  return ref(element => {
    dispose();
    dispose = () => {};
    const current = ++generation;
    if (!element) return;
    (element as HTMLElement).hidden = true;
    // Lit calls refs before insertion; clipping ancestors exist after the commit.
    queueMicrotask(() => {
      if (current === generation && element.isConnected) {
        // Imperative details belong to this plotted report and its handlers.
        dispose = mountDetails(element as HTMLElement, model);
      }
    });
  });
}

/** Render original strings without interpreting values or collapsing duplicate keys. */
function recordedFields(record: TailRecord) {
  if (record.attributes == null) return html`<small>Recorded fields unavailable</small>`;
  const omitted = record.attributesOmitted;
  return html`<div class="tail-recorded-fields-heading">Recorded fields · original values</div>
    ${record.attributes.length ? html`<div class="tail-recorded-fields" tabindex="0" role="region" aria-label="Recorded fields">
      <dl>${record.attributes.map(([key, value]) => html`<dt>${key}</dt><dd>${value}</dd>`)}</dl>
    </div>` : html`<small>${omitted === 0 ? "No recorded fields"
      : omitted != null && omitted > 0 ? "All recorded fields omitted by response limits" : "No recorded fields included"}</small>`}
    ${omitted == null ? html`<small>Additional field count unavailable</small>`
      : omitted > 0 ? html`<small>${omitted} ${record.attributes.length ? "additional " : ""}recorded ${omitted === 1 ? "field" : "fields"} omitted · inspect the trace for more</small>` : nothing}`;
}

/** Dismiss placements when their viewport or anchor geometry becomes stale. */
function observeGeometry(elements: readonly Element[], onChange: () => void): () => void {
  const view = elements[0]?.ownerDocument.defaultView;
  if (!view) return () => {};
  const geometry = () => elements.map(element => {
    const { left, top, width, height } = element.getBoundingClientRect();
    return `${left},${top},${width},${height}`;
  }).join(";");
  let previous = geometry();
  let active = true;
  const viewportChanged = () => { if (active) { previous = geometry(); onChange(); } };
  const observer = typeof view.ResizeObserver === "function" ? new view.ResizeObserver(() => {
    if (!active) return;
    const next = geometry();
    // ResizeObserver also sends an initial notification, before any change.
    if (next === previous) return;
    previous = next;
    onChange();
  }) : null;
  elements.forEach(element => observer?.observe(element));
  view.addEventListener("resize", viewportChanged);
  view.visualViewport?.addEventListener("resize", viewportChanged);
  view.visualViewport?.addEventListener("scroll", viewportChanged);
  return () => {
    active = false;
    observer?.disconnect();
    view.removeEventListener("resize", viewportChanged);
    view.visualViewport?.removeEventListener("resize", viewportChanged);
    view.visualViewport?.removeEventListener("scroll", viewportChanged);
  };
}

function mountDetails(tooltip: HTMLElement, model: NumericPlotDetailsModel): () => void {
  const plot = tooltip.parentElement;
  const svg = plot?.querySelector<SVGSVGElement>(".tail-scatter");
  const view = tooltip.ownerDocument.defaultView;
  if (!plot || !svg || !view) return () => {};
  const { signal, axis, interval, onJump } = model;
  const density = signal.density;
  const xBins = density ? density.elapsedEdgesMs.length - 1 : 0;
  const yBins = density ? density.valueEdges.length - 1 : 0;
  const points = () => svg.querySelectorAll<SVGCircleElement>(".tail-trace-point");
  // Lit may reuse circles whose tabindex was changed by the previous report.
  const entry = Array.from(points()).find(point => point === tooltip.ownerDocument.activeElement)
    ?? svg.querySelector<SVGCircleElement>(".tail-trace-point[tabindex='0']") ?? points()[0];
  points().forEach(point => point.setAttribute("tabindex", point === entry ? "0" : "-1"));
  let trigger: Element | null = null;
  let hideTimer: number | null = null;
  let focusFrame: number | null = null;
  let restoringFocus = false;
  let keyboardCell = density ? Math.max(0, density.counts.indexOf(density.maxCount)) : 0;
  const retain = () => { if (hideTimer != null) view.clearTimeout(hideTimer); hideTimer = null; };
  const cancelFocus = () => {
    if (focusFrame != null) view.cancelAnimationFrame(focusFrame);
    focusFrame = null;
  };
  const hide = (restoreFocus = false) => {
    retain();
    cancelFocus();
    if (restoreFocus && trigger?.isConnected) {
      restoringFocus = true;
      (trigger as HTMLElement).focus({ preventScroll: true });
      restoringFocus = false;
    }
    tooltip.hidden = true;
  };
  const leave = () => {
    retain();
    hideTimer = view.setTimeout(() => {
      hideTimer = null;
      const focused = tooltip.ownerDocument.activeElement;
      if (!tooltip.contains(focused) && focused !== trigger) hide();
    }, 180);
  };
  const show = (element: Element, content: unknown, keyboard: boolean, interactive = false) => {
    retain();
    cancelFocus();
    trigger = element;
    render(content, tooltip);
    tooltip.hidden = false;
    const svgRect = svg.getBoundingClientRect();
    const above = Math.max(0, Math.min(view.innerHeight - 16, svgRect.top - 16));
    const below = Math.max(0, Math.min(view.innerHeight - 16, view.innerHeight - svgRect.bottom - 16));
    const useAbove = above >= 160 || above >= below;
    const width = Math.min(330, view.innerWidth - 16);
    const height = Math.min(280, useAbove ? above : below);
    /** Keep a bounded inspector outside the SVG, independent of sample or content. */
    tooltip.style.width = `${width}px`;
    tooltip.style.height = `${height}px`;
    tooltip.style.left = `${Math.max(8, Math.min(svgRect.left, view.innerWidth - 8 - width))}px`;
    tooltip.style.top = `${useAbove
      ? Math.max(8, Math.min(svgRect.top - 8 - height, view.innerHeight - 8 - height))
      : Math.max(8, svgRect.bottom + 8)}px`;
    tooltip.setAttribute("role", interactive ? "dialog" : "tooltip");
    tooltip.setAttribute("aria-label", interactive ? "Recorded span details" : "Density cell count");
    tooltip.setAttribute("aria-live", keyboard ? "polite" : "off");
  };
  const showPoint = (element: SVGCircleElement, keyboard: boolean) => {
    const point = signal.points[Number(element.dataset.pointIndex)];
    if (!point) return;
    const [elapsed, raw, row] = point;
    show(element, html`<strong>${duration(elapsed)} elapsed</strong>
      <span>${signal.key}: ${fieldValue(raw * axis.multiplier, axis.unit)}</span>
      <button type="button" class="tail-tooltip-trace" @click=${() => onJump(row)}>Open trace focused on this span ↗</button>
      ${recordedFields(row)}
      ${keyboard ? html`<small>Left/right choose samples · Enter opens the trace · Tab inspects fields</small>` : nothing}`,
    keyboard, true);
  };
  const showCell = (element: Element, index: number, keyboard: boolean) => {
    if (!density) return;
    const x = index % xBins, y = Math.floor(index / xBins);
    const count = density.counts[index];
    if (count == null) return;
    const edges = density.elapsedEdgesMs;
    const split = densityCellSegments(edges, x, interval.lowerMs, interval.upperMs).length > 1;
    show(element, html`<strong>${number(count)} ${count === 1 ? "span" : "spans"} in whole cell</strong>
      <span>${duration(edges[x]!)}–${duration(edges[x + 1]!)} elapsed</span>
      <span>${signal.key}: ${fieldValue(density.valueEdges[y]!, axis.unit)}–${fieldValue(density.valueEdges[y + 1]!, axis.unit)}</span>
      <small>${split ? "Colors split at the cutoff; the count covers both parts. " : ""}Upper bounds ${x === xBins - 1 && y === yBins - 1 ? "included" : "excluded except final bins"}</small>`,
    keyboard);
  };
  const pointTarget = (event: Event) => event.target instanceof view.SVGCircleElement
    && event.target.matches(".tail-trace-point") ? event.target : null;
  const enter = (event: Event) => {
    const point = pointTarget(event);
    if (point) showPoint(point, false);
    else if (event.target instanceof view.Element && event.target.matches(".tail-density-cell")) {
      // Crossing the grid on the way to the inspector keeps the sampled span.
      if (!tooltip.hidden && trigger?.matches(".tail-trace-point")) retain();
      else showCell(event.target, Number(event.target.getAttribute("data-cell-index")), false);
    } else if (event.target === svg || event.target === tooltip) retain();
  };
  const pointerLeave = (event: Event) => {
    if (event.target === svg || event.target === tooltip) leave();
  };
  const focus = (event: Event) => {
    const point = pointTarget(event);
    if (point) {
      points().forEach(other => other.setAttribute("tabindex", other === point ? "0" : "-1"));
    }
    if (!restoringFocus && (point || event.target === svg)) {
      hide();
      const element = point ?? svg;
      // Native focus may scroll a clipped mark; place details after that scroll.
      focusFrame = view.requestAnimationFrame(() => {
        focusFrame = null;
        if (!element.isConnected || tooltip.ownerDocument.activeElement !== element) return;
        if (point) showPoint(point, true);
        else showCell(svg, keyboardCell, true);
      });
    }
  };
  const blur = (event: Event) => {
    cancelFocus();
    if ((pointTarget(event) || event.target === svg || tooltip.contains(event.target as Node))
      && !tooltip.contains((event as FocusEvent).relatedTarget as Node | null)) hide();
  };
  const click = (event: Event) => {
    const point = pointTarget(event);
    const row = point && signal.points[Number(point.dataset.pointIndex)]?.[2];
    if (row) onJump(row);
  };
  const keydown = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (tooltip.contains(event.target as Node)) {
      if (key === "Escape") { hide(true); event.preventDefault(); event.stopPropagation(); }
      return;
    }
    const point = pointTarget(event);
    if (point) {
      const index = Number(point.dataset.pointIndex);
      if (key === "Escape") { hide(); return; }
      if (key === "Enter") {
        const row = signal.points[index]?.[2];
        if (row) onJump(row);
      } else {
        // One Tab entry per plot; arrow keys move through the bounded trace sample.
        const next = key === "Home" ? 0 : key === "End" ? signal.points.length - 1
          : key === "ArrowLeft" ? Math.max(0, index - 1)
          : key === "ArrowRight" ? Math.min(signal.points.length - 1, index + 1) : null;
        if (next == null) return;
        points()[next]?.focus({ preventScroll: true });
      }
      event.preventDefault();
    } else if (event.target === svg && density) {
      let x = keyboardCell % xBins, y = Math.floor(keyboardCell / xBins);
      if (key === "ArrowLeft") x = Math.max(0, x - 1);
      else if (key === "ArrowRight") x = Math.min(xBins - 1, x + 1);
      else if (key === "ArrowUp") y = Math.min(yBins - 1, y + 1);
      else if (key === "ArrowDown") y = Math.max(0, y - 1);
      else if (key === "Escape") { hide(); return; }
      else return;
      keyboardCell = y * xBins + x;
      showCell(svg, keyboardCell, true);
      event.preventDefault();
    }
  };
  const listeners = { pointerenter: enter, pointerleave: pointerLeave, focus, blur, click, keydown };
  Object.entries(listeners).forEach(([type, listener]) => plot.addEventListener(type, listener, true));
  const targets = [plot, svg, plot.closest(".tail-plot-dialog, .detail-panel")]
    .filter((target): target is Element => target != null);
  const dismiss = () => {
    if (!tooltip.hidden) hide(tooltip.contains(tooltip.ownerDocument.activeElement));
  };
  const scroll = (event: Event) => {
    if (!(event.target instanceof view.Node && tooltip.contains(event.target))) dismiss();
  };
  const disposeGeometry = observeGeometry(targets, dismiss);
  view.addEventListener("scroll", scroll, true);
  return () => {
    retain();
    disposeGeometry();
    view.removeEventListener("scroll", scroll, true);
    Object.entries(listeners).forEach(([type, listener]) => plot.removeEventListener(type, listener, true));
    hide(tooltip.contains(tooltip.ownerDocument.activeElement));
    render(nothing, tooltip);
    trigger = null;
  };
}
