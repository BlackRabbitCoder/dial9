/** Dismiss placements when their viewport or anchor geometry becomes stale. */
export function observePopoverGeometry(elements: readonly Element[], onChange: () => void): () => void {
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
