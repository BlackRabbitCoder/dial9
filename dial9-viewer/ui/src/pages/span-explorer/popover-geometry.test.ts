import { describe, expect, it, vi } from "vitest";
import { observePopoverGeometry } from "./popover-geometry.js";

function fixture() {
  let notify: (() => void) | undefined;
  const observe = vi.fn(), disconnect = vi.fn();
  const view = Object.assign(new EventTarget(), {
    visualViewport: new EventTarget(),
    ResizeObserver: class {
      constructor(callback: () => void) { notify = callback; }
      observe = observe;
      disconnect = disconnect;
    },
  });
  const rect = { left: 50, top: 100, width: 600, height: 225 };
  const element = {
    ownerDocument: { defaultView: view },
    getBoundingClientRect: () => rect,
  } as unknown as Element;
  const changed = vi.fn();
  const dispose = observePopoverGeometry([element], changed);
  return { view, rect, element, changed, dispose, observe, disconnect, notify: () => notify?.() };
}

describe("popover geometry lifecycle", () => {
  it("ignores initial and unchanged observer notifications, but notices plot geometry changes", () => {
    const f = fixture();
    expect(f.observe).toHaveBeenCalledWith(f.element);
    f.notify();
    expect(f.changed).not.toHaveBeenCalled();
    f.rect.width = 300;
    f.notify();
    expect(f.changed).toHaveBeenCalledTimes(1);
    f.notify();
    expect(f.changed).toHaveBeenCalledTimes(1);
    f.rect.top = 200;
    f.notify();
    expect(f.changed).toHaveBeenCalledTimes(2);
    f.dispose();
  });

  it("notices height-only viewport resize and mobile visual viewport changes", () => {
    const f = fixture();
    f.view.dispatchEvent(new Event("resize"));
    f.view.visualViewport.dispatchEvent(new Event("resize"));
    f.view.visualViewport.dispatchEvent(new Event("scroll"));
    expect(f.changed).toHaveBeenCalledTimes(3);
    f.dispose();
  });

  it("disconnects the observer and removes every viewport listener on replacement", () => {
    const f = fixture();
    f.dispose();
    expect(f.disconnect).toHaveBeenCalledTimes(1);
    f.view.dispatchEvent(new Event("resize"));
    f.view.visualViewport.dispatchEvent(new Event("resize"));
    f.view.visualViewport.dispatchEvent(new Event("scroll"));
    f.rect.width = 300;
    f.notify();
    expect(f.changed).not.toHaveBeenCalled();
  });

  it("does not require a browser viewport for an unmounted plot", () => {
    expect(() => observePopoverGeometry([], vi.fn())()).not.toThrow();
  });
});
