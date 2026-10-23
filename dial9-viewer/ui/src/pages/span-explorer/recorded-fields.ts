import { html, nothing } from "lit-html";

export interface RecordedFields {
  attributes?: readonly (readonly [string, string])[] | null;
  attributesOmitted?: number | null;
}

/** Render original strings without interpreting values or collapsing duplicate keys. */
export function renderRecordedFields(record: RecordedFields) {
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

/** Keep a bounded popover inside the visible detail viewport. */
export function tooltipPosition(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  bounds: { left: number; top: number; right: number; bottom: number },
) {
  const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
  return {
    left: clamp(anchor.x + 10, bounds.left, bounds.right - size.width),
    top: clamp(anchor.y + 10 + size.height > bounds.bottom ? anchor.y - size.height - 10 : anchor.y + 10,
      bounds.top, bounds.bottom - size.height),
  };
}
