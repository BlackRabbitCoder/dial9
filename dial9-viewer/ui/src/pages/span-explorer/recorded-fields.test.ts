import { describe, expect, it } from "vitest";
import { renderRecordedFields, tooltipPosition } from "./recorded-fields.js";

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value != null && typeof value === "object" && "strings" in value && "values" in value) {
    const template = value as { strings: readonly string[]; values: unknown[] };
    return template.strings.map((part, i) => part + text(template.values[i])).join("");
  }
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}

describe("recorded point fields", () => {
  it("distinguishes unavailable metadata from an explicitly empty record", () => {
    expect(text(renderRecordedFields({}))).toContain("Recorded fields unavailable");
    expect(text(renderRecordedFields({ attributes: null, attributesOmitted: null }))).toContain("Recorded fields unavailable");
    expect(text(renderRecordedFields({ attributes: [], attributesOmitted: 0 }))).toContain("No recorded fields");
    expect(text(renderRecordedFields({ attributes: [], attributesOmitted: 0 }))).not.toContain("unavailable");
  });

  it("keeps duplicate keys, raw strings, order, and long values without inference or UI truncation", () => {
    const fields: [string, string][] = [["status", "001"], ["status", "false"], ["payload", "x".repeat(8000)]];
    const markup = text(renderRecordedFields({ attributes: fields, attributesOmitted: 0 }));
    expect(markup.indexOf("001")).toBeLessThan(markup.indexOf("false"));
    expect(markup.match(/<dt>status/g)).toHaveLength(2);
    expect(markup).toContain("x".repeat(8000));
    expect(markup).toContain('aria-label="Recorded fields"');
    expect(markup).toContain('tabindex="0"');
  });

  it("makes backend omissions explicit without claiming empty source fields", () => {
    const markup = text(renderRecordedFields({ attributes: [], attributesOmitted: 12 }));
    expect(markup).toContain("All recorded fields omitted by response limits");
    expect(markup).toContain("12 recorded fields omitted");
    expect(text(renderRecordedFields({ attributes: [["key", "value"]] }))).toContain("Additional field count unavailable");
  });
});

describe("popover placement", () => {
  it("fits long mobile content above a low-right point", () => {
    const size = { width: 330, height: 280 };
    const position = tooltipPosition({ x: 370, y: 800 }, size, { left: 8, top: 88, right: 382, bottom: 836 });
    expect(position.left).toBe(52);
    expect(position.top).toBe(510);
    expect(position.left + size.width).toBeLessThanOrEqual(382);
    expect(position.top + size.height).toBeLessThanOrEqual(836);
  });

  it("keeps an upper-left point's content below it inside the detail viewport", () => {
    expect(tooltipPosition({ x: 0, y: 100 }, { width: 300, height: 220 },
      { left: 16, top: 88, right: 1384, bottom: 984 })).toEqual({ left: 16, top: 110 });
  });
});
