import type { MotionPlayback } from "./adapters";
/** Finite screen-space tracing; target geometry may update while the camera moves. */
export function playAttention(
  rootSource: SVGGElement | null | (() => SVGGElement | null),
  trace: boolean,
  duration: number,
  complete: () => void,
): MotionPlayback {
  let frame = 0;
  let cancelled = false;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const total = reduced ? 1 : duration;
  let elapsed = 0;
  let last = performance.now();
  let paused = false;
  const tick = (now: number) => {
    if (cancelled) return;
    const root = typeof rootSource === "function" ? rootSource() : rootSource;
    if (!paused) elapsed += now - last;
    last = now;
    const progress = Math.min(1, elapsed / total);
    if (root && !trace)
      root.style.opacity = String(
        reduced ? 1 : Math.min(1, elapsed / Math.min(220, total)),
      );
    const outline = root?.querySelector<SVGRectElement>("[data-trace-outline]");
    const head = root?.querySelector<SVGCircleElement>("[data-trace-head]");
    if (outline && trace) {
      outline.style.strokeDasharray = "1";
      outline.style.strokeDashoffset = String(1 - progress);
      if (head) {
        const box = outline.getBBox();
        const perimeter = 2 * (box.width + box.height);
        let distance = progress * perimeter;
        let x = box.x,
          y = box.y;
        if (distance <= box.width) x += distance;
        else if ((distance -= box.width) <= box.height) {
          x += box.width;
          y += distance;
        } else if ((distance -= box.height) <= box.width) {
          x += box.width - distance;
          y += box.height;
        } else {
          distance -= box.width;
          y += box.height - distance;
        }
        head.setAttribute("cx", String(x));
        head.setAttribute("cy", String(y));
      }
    }
    if (progress < 1) frame = requestAnimationFrame(tick);
    else complete();
  };
  frame = requestAnimationFrame(tick);
  return {
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      last = performance.now();
    },
    cancel: () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    },
  };
}
