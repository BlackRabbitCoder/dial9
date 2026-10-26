import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { TailRecord } from "../../lib/trace/span-tail-analysis.js";
import type {} from "../../../live-checks/fixtures/numeric-plot-harness.js";

let vite: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let baseUrl: string;
let errors: string[];

beforeAll(async () => {
  const env = { ...process.env };
  delete env.VITEST;
  // The browser requires Vite's existing dev CJS interop, skipped under Vitest.
  vite = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createServer } from "vite";
    const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
    await server.listen();
    process.send(server.httpServer.address().port);
    const close = async () => { await server.close(); process.exit(); };
    process.on("message", close);
    process.on("disconnect", close);
  `], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)), env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  vite.stdout?.on("data", chunk => { output += String(chunk); });
  vite.stderr?.on("data", chunk => { output += String(chunk); });
  const port = await new Promise<number>((resolve, reject) => {
    vite.once("message", value => resolve(Number(value)));
    vite.once("error", reject);
    vite.once("exit", () => reject(new Error(`Browser fixture server exited before readiness:\n${output}`)));
  });
  baseUrl = `http://127.0.0.1:${port}`;
  try {
    browser = await chromium.launch({
      ...(process.env.DIAL9_TEST_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.DIAL9_TEST_CHROMIUM_EXECUTABLE } : {}),
    });
  } catch (error) {
    throw new Error("Numeric plot browser tests require Chromium. Run `npx playwright install chromium`, "
      + "or set DIAL9_TEST_CHROMIUM_EXECUTABLE to an installed Chromium executable.", { cause: error });
  }
});
afterAll(async () => {
  await browser?.close();
  if (vite?.connected) {
    const exited = once(vite, "exit");
    vite.send("close");
    await exited;
  }
});
beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  errors = [];
  page.on("pageerror", error => errors.push(error.message));
  // Install before the fixture wraps timers to observe their disposal.
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.goto(`${baseUrl}/live-checks/fixtures/numeric-plot-harness.html`);
  await page.waitForFunction(() => window.numericPlotHarness?.resources.observers === 1);
});
afterEach(async () => {
  await context?.close();
  expect(errors).toEqual([]);
});

const points = () => page.locator("#plots .tail-trace-point");
const tooltip = () => page.locator("#plots .tail-plot-tooltip").first();
async function visible(expected = true) {
  await expect.poll(() => tooltip().isVisible()).toBe(expected);
}
async function focused(selector: string) {
  await expect.poll(() => page.locator(selector).evaluate(element => element === document.activeElement)).toBe(true);
}
async function resources(observers: number, hideTimers = 0) {
  await expect.poll(() => page.evaluate(() => window.numericPlotHarness.resources)).toEqual({ observers, hideTimers });
}
async function report() {
  const body = await page.evaluate(() => window.numericPlotHarness.reportResponse());
  await page.route("**/api/span-tail?**", route => route.fulfill({ json: body }));
  await page.evaluate(() => window.numericPlotHarness.mountReport());
  await page.waitForSelector("#reports .tail-trace-point");
  await resources(1);
}

describe("mounted numeric plot details", () => {
  it("keeps backend counts, sampled marks, exact readouts, and distinct roles", async () => {
    expect(await points().count()).toBe(3);
    const cells = page.locator(".tail-density-cell");
    expect(await cells.count()).toBe(3);
    expect(await cells.evaluateAll(elements => elements.reduce((sum, e) => sum + Number(e.getAttribute("data-count")), 0))).toBe(10000);
    await page.locator("#plots .tail-scatter").focus();
    await visible();
    expect(await tooltip().getAttribute("role")).toBe("tooltip");
    expect(await tooltip().getAttribute("aria-label")).toBe("Density cell count");
    expect(await tooltip().getAttribute("aria-live")).toBe("polite");
    expect(await tooltip().textContent()).toContain("9,000 spans in whole cell");
    expect(await tooltip().textContent()).toContain("0ns–1ms elapsed");
    expect(await tooltip().textContent()).toContain("work_time: 0 ms–6 ms");
    await page.keyboard.press("ArrowUp");
    expect(await tooltip().textContent()).toContain("0 spans in whole cell");
    await page.keyboard.press("ArrowRight");
    expect(await tooltip().textContent()).toContain("500 spans in whole cell");
    expect(await tooltip().textContent()).toContain("1ms–100ms elapsed");
    expect(await tooltip().textContent()).toContain("work_time: 6 ms–12 ms");
    expect(await tooltip().textContent()).toContain("Colors split at the cutoff; the count covers both parts.");
    expect(await tooltip().textContent()).toContain("Upper bounds included");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowRight");
    expect(await tooltip().textContent()).toContain("500 spans in whole cell");
    await page.keyboard.press("Escape");
    await visible(false);
    await points().nth(1).focus();
    await visible();
    expect(await tooltip().getAttribute("role")).toBe("dialog");
    expect(await tooltip().getAttribute("aria-label")).toBe("Recorded span details");
    expect(await tooltip().textContent()).toContain("10ms elapsed");
    expect(await tooltip().textContent()).toContain("work_time: 6 ms");
    await page.locator("#outside").focus();
    await page.locator(".tail-density-cell").first().hover();
    expect(await tooltip().getAttribute("role")).toBe("tooltip");
    expect(await tooltip().getAttribute("aria-live")).toBe("off");
  });

  it("preserves original strings, duplicate order, safe text, and scrollable long values", async () => {
    const literal = '<img src="x" onerror="throw new Error(\'unsafe\')">';
    await page.evaluate(({ literal }) => window.numericPlotHarness.draw({
      fields: { attributes: [["status", "001"], ["status", "false"], ["html", literal], ["payload", "x".repeat(8000)]],
        attributesOmitted: 1 },
    }), { literal });
    await resources(1);
    await points().first().focus();
    await visible();
    expect(await tooltip().locator("dt").allTextContents()).toEqual(["status", "status", "html", "payload"]);
    expect(await tooltip().locator("dd").allTextContents()).toEqual(["001", "false", literal, "x".repeat(8000)]);
    expect(await tooltip().locator("img").count()).toBe(0);
    expect(await tooltip().textContent()).toContain("1 additional recorded field omitted");
    const fields = tooltip().getByRole("region", { name: "Recorded fields" });
    expect(await fields.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await fields.focus();
    await fields.evaluate(element => { element.scrollTop = 100; });
    await visible();
  });

  it.each<[Pick<TailRecord, "attributes" | "attributesOmitted">, string]>([
    [{}, "Recorded fields unavailable"],
    [{ attributes: null, attributesOmitted: null }, "Recorded fields unavailable"],
    [{ attributes: [], attributesOmitted: 0 }, "No recorded fields"],
    [{ attributes: [], attributesOmitted: 12 }, "All recorded fields omitted by response limits"],
    [{ attributes: [], attributesOmitted: null }, "No recorded fields included"],
    [{ attributes: [["key", "value"]] }, "Additional field count unavailable"],
  ])("distinguishes recorded metadata state %#", async (fields, expected) => {
    await page.evaluate(fields => window.numericPlotHarness.draw({ fields: structuredClone(fields) }), fields);
    await resources(1);
    await points().first().focus();
    await visible();
    expect(await tooltip().textContent()).toContain(expected);
    if (fields.attributes == null) expect(await tooltip().textContent()).not.toContain("No recorded fields");
    if (fields.attributes?.length === 0 && fields.attributesOmitted === 0) {
      expect(await tooltip().textContent()).not.toContain("unavailable");
      expect(await tooltip().textContent()).not.toContain("omitted");
    }
    if ("attributesOmitted" in fields && fields.attributesOmitted === 12) {
      expect(await tooltip().textContent()).toContain("12 recorded fields omitted");
    }
  });

  it("roves 330 samples, opens the exact trace, and uses native Tab and Escape", async () => {
    await page.evaluate(() => window.numericPlotHarness.draw({ points: 330 }));
    await resources(1);
    expect(await page.locator(".tail-trace-point[tabindex='0']").count()).toBe(1);
    await points().first().focus();
    await page.keyboard.press("ArrowLeft");
    await focused(".tail-trace-point[data-point-index='0']");
    await page.keyboard.press("ArrowRight");
    await focused(".tail-trace-point[data-point-index='1']");
    await page.keyboard.press("End");
    await focused(".tail-trace-point[data-point-index='329']");
    await page.keyboard.press("ArrowRight");
    await focused(".tail-trace-point[data-point-index='329']");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.numericPlotHarness.jumps.map(row => row.requestId))).toEqual(["request-329"]);
    await page.keyboard.press("Home");
    await focused(".tail-trace-point[data-point-index='0']");
    await visible();
    await page.keyboard.press("Tab");
    await focused(".tail-tooltip-trace");
    await visible();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await focused(".tail-recorded-fields");
    await page.keyboard.press("Escape");
    await visible(false);
    await focused(".tail-trace-point[data-point-index='0']");
    await page.evaluate(() => window.numericPlotHarness.draw());
    await resources(1);
    await points().nth(2).click();
    expect(await page.evaluate(() => window.numericPlotHarness.jumps.map(row => row.requestId)))
      .toEqual(["request-329", "request-0", "request-2"]);
    await tooltip().locator(".tail-tooltip-trace").click();
    expect(await page.evaluate(() => window.numericPlotHarness.jumps.at(-1)?.requestId)).toBe("request-2");
    expect(await page.locator(".tail-trace-point[tabindex='0']").count()).toBe(1);
  });

  it("retains pointer transfer and closes at 180 ms while keeping focused details", async () => {
    // Fixture startup can take longer than a second on CI.
    await page.clock.setFixedTime(new Date("2026-01-01T00:00:00Z"));
    await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
    await points().first().hover();
    await visible();
    expect(await tooltip().getAttribute("role")).toBe("dialog");
    expect(await tooltip().getAttribute("aria-live")).toBe("off");
    await page.mouse.move(1400, 950);
    await resources(1, 1);
    await page.clock.runFor(179);
    await visible();
    await page.clock.runFor(1);
    await visible(false);
    await resources(1);
    await points().first().hover();
    await page.mouse.move(1400, 950);
    await page.clock.runFor(100);
    await tooltip().hover();
    await page.clock.runFor(180);
    await visible();
    await tooltip().locator(".tail-tooltip-trace").focus();
    await page.mouse.move(1400, 950);
    await page.clock.runFor(180);
    await visible();
    await page.locator("#outside").focus();
    await visible(false);
  });

  it.each([false, true])("keeps a sampled span across the grid to the inspector with enlarged=%s", async large => {
    await page.evaluate(large => {
      window.numericPlotHarness.draw({ large });
      if (!large) document.querySelector<HTMLElement>("#plots .detail-panel")!.style.marginTop = "360px";
    }, large);
    await resources(1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.clock.setFixedTime(new Date("2026-01-01T00:00:00Z"));
    await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
    await points().first().hover();
    const original = await tooltip().textContent();
    const bounds = await tooltip().boundingBox();
    const cell = await page.locator("#plots .tail-density-cell").last().boundingBox();
    await page.mouse.move(cell!.x + cell!.width / 2, cell!.y + cell!.height / 2, { steps: 12 });
    await page.clock.runFor(200);
    await visible();
    await resources(1);
    expect(await tooltip().textContent()).toBe(original);
    expect(await tooltip().boundingBox()).toEqual(bounds);
    await tooltip().locator(".tail-tooltip-trace").hover();
    await page.clock.runFor(200);
    await visible();
    expect(await tooltip().textContent()).toBe(original);
    await tooltip().locator(".tail-tooltip-trace").click();
    expect(await page.evaluate(() => window.numericPlotHarness.jumps.at(-1)?.requestId)).toBe("request-0");
  });

  it("keeps older reports sample-only with unknown units and no invented density", async () => {
    await page.evaluate(() => window.numericPlotHarness.draw({ oldReport: true, signal: { unit: null } }));
    await resources(1);
    expect(await page.locator(".tail-density-cell").count()).toBe(0);
    expect(await page.locator(".tail-density-selected").count()).toBe(0);
    expect(await page.locator(".tail-scatter").getAttribute("aria-label")).toContain("density unavailable in this cached report");
    await points().first().focus();
    await visible();
    expect(await tooltip().textContent()).toContain("1,000,000 (unit not recorded)");
    expect(await tooltip().getAttribute("role")).toBe("dialog");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.numericPlotHarness.jumps.at(-1)?.requestId)).toBe("request-1");
  });

  it("renders full-observation density without a navigation sample", async () => {
    await page.evaluate(() => window.numericPlotHarness.draw({ points: 0 }));
    await resources(1);
    expect(await points().count()).toBe(0);
    expect(await page.locator(".tail-density-cell").count()).toBe(3);
    expect(await page.locator(".tail-density-legend").textContent()).toContain("10,000 recorded spans");
    await page.locator(".tail-scatter").focus();
    await visible();
    expect(await tooltip().textContent()).toContain("9,000 spans in whole cell");
    expect(await tooltip().getAttribute("role")).toBe("tooltip");
  });

  it("dismisses real geometry and viewport changes and restores details focus", async () => {
    await points().first().focus();
    await visible();
    await page.keyboard.press("Tab");
    await page.setViewportSize({ width: 1440, height: 900 });
    await visible(false);
    await focused(".tail-trace-point[data-point-index='0']");
    await points().nth(1).focus();
    await visible();
    await page.keyboard.press("Tab");
    await page.locator("#plots .detail-panel").evaluate(element => { (element as HTMLElement).style.width = "600px"; });
    await visible(false);
    await focused(".tail-trace-point[data-point-index='1']");
    for (const event of ["resize", "scroll"]) {
      await page.locator("#outside").focus();
      await points().first().focus();
      await visible();
      await page.keyboard.press("Tab");
      await page.evaluate(event => window.visualViewport!.dispatchEvent(new Event(event)), event);
      await visible(false);
      await focused(".tail-trace-point[data-point-index='0']");
    }
    // An unchanged initial observer notification must leave newly shown details open.
    await page.evaluate(() => window.numericPlotHarness.draw());
    await resources(1);
    await page.locator("#outside").focus();
    await points().first().focus();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await visible();
  });

  it.each([
    { large: false, width: 1440, height: 1000 },
    { large: true, width: 1440, height: 1000 },
    { large: false, width: 390, height: 844 },
    { large: true, width: 390, height: 844 },
  ])("docks outside the SVG with stable metadata placement %#", async ({ large, width, height }) => {
    await page.setViewportSize({ width, height });
    await page.evaluate(large => window.numericPlotHarness.draw({ large, fieldsByPoint: [
      { attributes: [["short", "original"]], attributesOmitted: 0 },
      { attributes: null },
      { attributes: [["payload", "x".repeat(8000)], ["duplicate", "001"], ["duplicate", "false"]], attributesOmitted: 12 },
    ] }), large);
    await resources(1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const graph = await page.locator("#plots .tail-scatter").boundingBox();
    await points().first().hover();
    await visible();
    const bounds = await tooltip().evaluate(element => {
      const popup = element.getBoundingClientRect();
      const svg = element.parentElement!.querySelector(".tail-scatter")!.getBoundingClientRect();
      const dialog = element.closest(".tail-plot-dialog")?.getBoundingClientRect();
      const hit = document.elementFromPoint(popup.left + 20, popup.top + 20);
      return { left: popup.left, top: popup.top, right: popup.right, bottom: popup.bottom,
        svgTop: svg.top, svgBottom: svg.bottom, dialogTop: dialog?.top, dialogBottom: dialog?.bottom,
        painted: hit === element || element.contains(hit) };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(8);
    expect(bounds.top).toBeGreaterThanOrEqual(8);
    expect(bounds.right).toBeLessThanOrEqual(width - 8);
    expect(bounds.bottom).toBeLessThanOrEqual(height - 8);
    expect(bounds.bottom <= bounds.svgTop - 8 || bounds.top >= bounds.svgBottom + 8).toBe(true);
    expect(bounds.painted).toBe(true);
    if (bounds.svgTop >= 176) expect(bounds.bottom).toBeLessThanOrEqual(bounds.svgTop - 8);
    if (large) expect(bounds.top).toBeLessThan(bounds.dialogTop!);
    const dock = await tooltip().boundingBox();
    expect(await tooltip().locator("dd").allTextContents()).toEqual(["original"]);
    await points().nth(1).hover();
    expect(await tooltip().textContent()).toContain("Recorded fields unavailable");
    expect(await tooltip().boundingBox()).toEqual(dock);
    await points().last().hover();
    expect(await tooltip().locator("dt").allTextContents()).toEqual(["payload", "duplicate", "duplicate"]);
    expect(await tooltip().locator("dd").allTextContents()).toEqual(["x".repeat(8000), "001", "false"]);
    expect(await tooltip().boundingBox()).toEqual(dock);
    expect(await page.locator("#plots .tail-scatter").boundingBox()).toEqual(graph);
    expect(await points().evaluateAll(elements => elements.every(element => {
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === element;
    }))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });

  it.each([false, true])("keeps controls and fields outside the SVG in a short viewport with enlarged=%s", async large => {
    await page.setViewportSize({ width: 1200, height: 320 });
    await page.evaluate(large => window.numericPlotHarness.draw({ large,
      fields: { attributes: [["payload", "x".repeat(8000)]], attributesOmitted: 0 },
    }), large);
    await resources(1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await points().count()).toBe(3);
    expect(await page.locator(".tail-density-cell").count()).toBe(3);
    const graph = await page.locator("#plots .tail-scatter").boundingBox();
    expect(graph!.height).toBeLessThanOrEqual(160);
    await points().first().focus();
    await visible();
    const bounds = await tooltip().boundingBox();
    expect(bounds!.height).toBeLessThan(100);
    expect(bounds!.y).toBeGreaterThanOrEqual(8);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(312);
    expect(bounds!.y + bounds!.height <= graph!.y - 8 || bounds!.y >= graph!.y + graph!.height + 8).toBe(true);
    expect(await tooltip().evaluate(element => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + 20, rect.top + 20);
      return hit === element || element.contains(hit);
    })).toBe(true);
    await page.keyboard.press("Tab");
    await focused(".tail-tooltip-trace");
    expect(await tooltip().locator(".tail-tooltip-trace").evaluate(element => {
      const control = element.getBoundingClientRect(), dock = element.parentElement!.getBoundingClientRect();
      return control.top >= dock.top && control.bottom <= dock.bottom;
    })).toBe(true);
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.numericPlotHarness.jumps.at(-1)?.requestId)).toBe("request-0");
    await page.keyboard.press("Tab");
    await focused(".tail-recorded-fields");
    await tooltip().getByRole("region", { name: "Recorded fields" }).evaluate(element => { element.scrollTop = 80; });
    await expect.poll(() => tooltip().getByRole("region", { name: "Recorded fields" }).evaluate(element => element.scrollTop)).toBe(80);
    await visible();
    expect(await tooltip().boundingBox()).toEqual(bounds);
    expect(await page.locator("#plots .tail-scatter").boundingBox()).toEqual(graph);
    await page.keyboard.press("Escape");
    await visible(false);
    await focused(".tail-trace-point[data-point-index='0']");
  });

  it("dismisses ancestor and page scrolling while retaining internal field scrolling", async () => {
    await page.evaluate(() => {
      window.numericPlotHarness.draw({ fields: { attributes: [["payload", "x".repeat(8000)]], attributesOmitted: 0 } });
      const plots = document.querySelector<HTMLElement>("#plots")!;
      plots.style.height = "360px";
      plots.style.overflow = "auto";
      document.body.style.minHeight = "1800px";
    });
    await resources(1);
    await points().first().focus();
    await visible();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const fields = tooltip().getByRole("region", { name: "Recorded fields" });
    await fields.evaluate(element => { element.scrollTop = 80; });
    await expect.poll(() => fields.evaluate(element => element.scrollTop)).toBe(80);
    await visible();
    await tooltip().evaluate(element => { element.scrollTop = 40; });
    await expect.poll(() => tooltip().evaluate(element => element.scrollTop)).toBe(40);
    await visible();
    await page.locator("#plots").evaluate(element => { element.scrollTop = 40; });
    await visible(false);
    await focused(".tail-trace-point[data-point-index='0']");
    await points().nth(1).focus();
    await visible();
    await page.evaluate(() => window.scrollTo(0, 30));
    await visible(false);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => window.numericPlotHarness.clear());
    await resources(0);
    await page.evaluate(() => window.scrollTo(0, 50));
  });

  it("places details after native Tab scrolls a clipped sample into view", async () => {
    await page.evaluate(() => {
      window.numericPlotHarness.draw({ fieldsByPoint: [
        { attributes: [["sample", "0"], ["payload", "x".repeat(8000)]], attributesOmitted: 0 },
        { attributes: [["sample", "1"]], attributesOmitted: 0 },
      ] });
      const panel = document.querySelector<HTMLElement>("#plots .detail-panel")!;
      panel.style.minHeight = "0";
      panel.style.height = "240px";
      panel.style.overflow = "auto";
    });
    await resources(1);
    await page.evaluate(() => document.querySelector<SVGSVGElement>("#plots .tail-scatter")!.focus({ preventScroll: true }));
    await visible();
    const owner = page.locator("#plots .detail-panel");
    const clipped = await points().first().boundingBox();
    const clip = await owner.boundingBox();
    expect(clipped!.y + clipped!.height).toBeGreaterThan(clip!.y + clip!.height);
    expect(await owner.evaluate(element => element.scrollTop)).toBe(0);
    await page.keyboard.press("Tab");
    await focused(".tail-trace-point[data-point-index='0']");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const scrolled = await owner.evaluate(element => element.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
    await visible();
    expect(await tooltip().locator("dd").allTextContents()).toEqual(["0", "x".repeat(8000)]);
    const dock = await tooltip().boundingBox();
    const graph = await page.locator("#plots .tail-scatter").boundingBox();
    expect(dock!.y + dock!.height <= graph!.y - 8 || dock!.y >= graph!.y + graph!.height + 8).toBe(true);
    await page.keyboard.press("Tab");
    await focused(".tail-tooltip-trace");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.numericPlotHarness.jumps.at(-1)?.requestId)).toBe("request-0");
    await page.keyboard.press("Tab");
    await focused(".tail-recorded-fields");
    const fields = tooltip().getByRole("region", { name: "Recorded fields" });
    await fields.evaluate(element => { element.scrollTop = 80; });
    await expect.poll(() => fields.evaluate(element => element.scrollTop)).toBe(80);
    await visible();
    await page.keyboard.press("Escape");
    await focused(".tail-trace-point[data-point-index='0']");
    expect(await owner.evaluate(element => element.scrollTop)).toBe(scrolled);
    await page.keyboard.press("ArrowRight");
    await visible();
    expect(await tooltip().locator("dd").allTextContents()).toEqual(["1"]);
    expect(await tooltip().boundingBox()).toEqual(dock);
    expect(await owner.evaluate(element => element.scrollTop)).toBe(scrolled);
    await page.keyboard.press("Tab");
    await owner.evaluate(element => { element.scrollTop -= 20; });
    await visible(false);
    await focused(".tail-trace-point[data-point-index='1']");
  });

  it("roves clipped samples without scrolling their owner or dismissing the inspector", async () => {
    await page.evaluate(() => {
      window.numericPlotHarness.draw({ points: 12,
        fieldsByPoint: Array.from({ length: 12 }, (_, index) => ({
          attributes: [["sample", String(index)], ["payload", "x".repeat(8000)]], attributesOmitted: 0,
        })) });
      const panel = document.querySelector<HTMLElement>("#plots .detail-panel")!;
      panel.style.minHeight = "0";
      panel.style.height = "240px";
      panel.style.overflow = "auto";
    });
    await resources(1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const owner = page.locator("#plots .detail-panel");
    const graph = await page.locator("#plots .tail-scatter").boundingBox();
    const clip = await owner.boundingBox();
    expect(graph!.y + graph!.height).toBeGreaterThan(clip!.y + clip!.height);
    const clippedPoint = await points().first().boundingBox();
    expect(clippedPoint!.y + clippedPoint!.height).toBeGreaterThan(clip!.y + clip!.height);
    await points().last().focus();
    await visible();
    expect(await owner.evaluate(element => element.scrollTop)).toBe(0);
    const dock = await tooltip().boundingBox();
    for (const [key, index] of [
      ["Home", 0], ["ArrowRight", 1], ["End", 11], ["ArrowLeft", 10],
      ["Home", 0], ["ArrowLeft", 0], ["ArrowRight", 1],
    ] as const) {
      await page.keyboard.press(key);
      await focused(`.tail-trace-point[data-point-index='${index}']`);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await owner.evaluate(element => element.scrollTop)).toBe(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await visible();
      expect(await tooltip().boundingBox()).toEqual(dock);
      expect(await tooltip().getAttribute("role")).toBe("dialog");
      expect(await tooltip().locator("dd").allTextContents()).toEqual([String(index), "x".repeat(8000)]);
    }
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await focused(".tail-tooltip-trace");
    expect(await tooltip().locator(".tail-tooltip-trace").evaluate(element => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === element || element.contains(hit);
    })).toBe(true);
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.numericPlotHarness.jumps.map(row => row.requestId)))
      .toEqual(["request-1", "request-1"]);
    await page.keyboard.press("Tab");
    await focused(".tail-recorded-fields");
    const fields = tooltip().getByRole("region", { name: "Recorded fields" });
    await fields.evaluate(element => { element.scrollTop = 80; });
    await expect.poll(() => fields.evaluate(element => element.scrollTop)).toBe(80);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await visible();
    expect(await owner.evaluate(element => element.scrollTop)).toBe(0);
    await page.keyboard.press("Escape");
    await visible(false);
    await focused(".tail-trace-point[data-point-index='1']");
    await page.keyboard.press("End");
    await visible();
    await page.keyboard.press("Tab");
    await focused(".tail-tooltip-trace");
    await owner.evaluate(element => { element.scrollTop = 20; });
    await visible(false);
    await focused(".tail-trace-point[data-point-index='11']");
    expect(await owner.evaluate(element => element.scrollTop)).toBe(20);
  });

  it.each(["blur", "Escape", "replace", "remove", "disconnect"])("cancels pending focus placement on %s", async action => {
    await page.clock.setFixedTime(new Date("2026-01-01T00:00:00Z"));
    await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
    const oldTooltip = await tooltip().elementHandle();
    await points().first().focus();
    await visible(false);
    if (action === "blur") await page.locator("#outside").focus();
    else if (action === "Escape") await page.keyboard.press("Escape");
    else await page.evaluate(action => {
      if (action === "replace") window.numericPlotHarness.draw();
      else if (action === "remove") window.numericPlotHarness.clear();
      else window.numericPlotHarness.connect(false);
    }, action);
    await page.clock.runFor(32);
    await resources(action === "remove" || action === "disconnect" ? 0 : 1);
    expect(await oldTooltip!.evaluate(element => (element as HTMLElement).hidden)).toBe(true);
    expect(await oldTooltip!.textContent()).toBe("");
    await oldTooltip!.dispose();
  });

  it.each(["point", "cell"])("keeps a newer pointer %s readout after cancelling focus placement", async target => {
    const mark = target === "point" ? points().last() : page.locator("#plots .tail-density-cell").last();
    const rect = await mark.boundingBox();
    await page.clock.setFixedTime(new Date("2026-01-01T00:00:00Z"));
    await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
    await points().first().focus();
    await visible(false);
    await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
    await visible();
    const current = await tooltip().textContent();
    expect(current).toContain(target === "point" ? "100ms elapsed" : "500 spans in whole cell");
    await page.clock.runFor(32);
    expect(await tooltip().textContent()).toBe(current);
    expect(await tooltip().getAttribute("aria-live")).toBe("off");
    expect(await tooltip().getAttribute("role")).toBe(target === "point" ? "dialog" : "tooltip");
  });

  it("keeps only the latest graph focus placement", async () => {
    await page.clock.setFixedTime(new Date("2026-01-01T00:00:00Z"));
    await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
    await points().first().focus();
    await points().last().focus();
    await visible(false);
    await page.clock.runFor(32);
    await visible();
    expect(await tooltip().textContent()).toContain("100ms elapsed");
    expect(await tooltip().getAttribute("aria-live")).toBe("polite");
  });

  it("disposes pending focus placement during the real report host handoff and null context", async () => {
    await report();
    await page.clock.setFixedTime(new Date("2026-01-01T00:00:00Z"));
    await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
    const oldTooltip = await page.locator("#reports .tail-plot-tooltip").elementHandle();
    await page.locator("#reports .tail-trace-point").first().focus();
    await page.evaluate(() => window.numericPlotHarness.replaceReport());
    await resources(1);
    await page.clock.runFor(32);
    expect(await page.evaluate(() => window.numericPlotHarness.previousReportEmpty)).toBe(true);
    expect(await oldTooltip!.textContent()).toBe("");
    expect(await page.locator("#reports .tail-plot-tooltip").isVisible()).toBe(false);
    const newTooltip = await page.locator("#reports .tail-plot-tooltip").elementHandle();
    await page.locator("#reports .tail-trace-point").first().focus();
    await page.evaluate(() => window.numericPlotHarness.clearReport(true));
    await page.clock.runFor(32);
    await resources(0);
    expect(await page.evaluate(() => window.numericPlotHarness.previousReportEmpty)).toBe(true);
    expect(await newTooltip!.textContent()).toBe("");
    await oldTooltip!.dispose();
    await newTooltip!.dispose();
  });

  it("replaces, disconnects, reconnects, and removes queued attachment without leaking", async () => {
    await points().first().focus();
    await visible();
    await page.keyboard.press("Tab");
    await page.evaluate(() => window.numericPlotHarness.draw());
    await resources(1);
    await visible(false);
    await focused(".tail-trace-point[data-point-index='0']");
    await points().nth(1).focus();
    await page.evaluate(() => window.numericPlotHarness.connect(false));
    await resources(0);
    await visible(false);
    await page.evaluate(() => window.numericPlotHarness.connect(true));
    await resources(1);
    await points().first().focus();
    await visible();
    await page.evaluate(() => window.numericPlotHarness.clear());
    await resources(0);
    await page.evaluate(() => window.numericPlotHarness.queuedRemoval());
    await resources(0);
    expect(await points().count()).toBe(0);
    await page.evaluate(() => window.numericPlotHarness.draw({ points: 1 }));
    await resources(1);
    await points().first().focus();
    await page.keyboard.press("End");
    await focused(".tail-trace-point[data-point-index='0']");
    await page.evaluate(() => window.numericPlotHarness.draw({ points: 330 }));
    await resources(1);
    await points().last().focus();
    await page.evaluate(() => window.numericPlotHarness.draw({ points: 2 }));
    await resources(1);
    expect(await page.locator(".tail-trace-point[tabindex='0']").count()).toBe(1);
    expect(await points().first().getAttribute("tabindex")).toBe("0");
    await page.evaluate(() => window.numericPlotHarness.draw({ points: 0, noDensity: true }));
    await resources(0);
    expect(await page.locator("#plots").textContent()).toContain("No recorded values available");
  });

  it("cancels a pending hover timer on removal and keeps two plots independent", async () => {
    await page.evaluate(() => window.numericPlotHarness.draw({ plots: 2 }));
    await resources(2);
    const plots = page.locator("#plots .tail-plot");
    await plots.nth(0).locator(".tail-trace-point").first().hover();
    await page.mouse.move(1400, 950);
    await resources(2, 1);
    await page.evaluate(() => window.numericPlotHarness.clear());
    await resources(0);
    await page.evaluate(() => window.numericPlotHarness.draw({ plots: 2 }));
    await resources(2);
    const first = plots.nth(0), second = plots.nth(1);
    await first.locator(".tail-trace-point").first().focus();
    expect(await second.locator(".tail-plot-tooltip").isVisible()).toBe(false);
    await second.locator(".tail-trace-point").nth(1).focus();
    await expect.poll(() => second.locator(".tail-plot-tooltip").isVisible()).toBe(true);
    expect(await first.locator(".tail-plot-tooltip").isVisible()).toBe(false);
    expect(await second.locator(".tail-plot-tooltip").textContent()).toContain("10ms elapsed");
    await page.keyboard.press("Escape");
    expect(await second.locator(".tail-plot-tooltip").isVisible()).toBe(false);
  });

  it("detached sample marks cannot call the previous report's trace callback", async () => {
    const oldPoint = await points().first().elementHandle();
    await page.evaluate(() => window.numericPlotHarness.clear());
    await resources(0);
    await oldPoint!.evaluate(element => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      element.dispatchEvent(new PointerEvent("pointerenter"));
    });
    expect(await page.evaluate(() => window.numericPlotHarness.jumps)).toEqual([]);
    await page.evaluate(() => window.numericPlotHarness.draw());
    await resources(1);
    await points().first().click();
    expect(await page.evaluate(() => window.numericPlotHarness.jumps.at(-1)?.requestId)).toBe("request-0");
    await oldPoint!.dispose();
  });

  it("clears the real independent report root after outer host replacement and null mount", async () => {
    await report();
    await page.locator("#reports .tail-trace-point").first().focus();
    await expect.poll(() => page.locator("#reports .tail-plot-tooltip").isVisible()).toBe(true);
    await page.keyboard.press("Tab");
    await page.locator("#outside").focus();
    await page.evaluate(() => window.numericPlotHarness.replaceReport());
    await resources(1);
    expect(await page.evaluate(() => window.numericPlotHarness.previousReportEmpty)).toBe(true);
    await focused("#outside");
    await page.locator("#reports .tail-trace-point").first().focus();
    await page.evaluate(() => window.numericPlotHarness.clearReport());
    await resources(0);
    expect(await page.evaluate(() => window.numericPlotHarness.previousReportEmpty)).toBe(true);
  });

  it("clears the real report root for null context on the same host and remounts", async () => {
    await report();
    await page.locator("#reports .tail-trace-point").first().focus();
    await expect.poll(() => page.locator("#reports .tail-plot-tooltip").isVisible()).toBe(true);
    await page.keyboard.press("Tab");
    await page.evaluate(() => window.numericPlotHarness.clearReport(true));
    await resources(0);
    expect(await page.evaluate(() => window.numericPlotHarness.previousReportEmpty)).toBe(true);
    await page.evaluate(() => window.numericPlotHarness.replaceReport());
    await page.waitForSelector("#reports .tail-trace-point");
    await resources(1);
    await page.locator("#reports .tail-trace-point").first().focus();
    await expect.poll(() => page.locator("#reports .tail-plot-tooltip").isVisible()).toBe(true);
  });
});
