import { MOTION_PRESETS, type MotionPreset } from "@vizli/shared";
export type MotionPlayback = {
  cancel: () => void;
  pause: () => void;
  resume: () => void;
};
/** Motion operates on semantic DOM targets, never on domain-specific object data. */
export function playMotion(
  targets: (HTMLElement | SVGElement)[],
  preset: MotionPreset,
  onComplete: () => void,
  durationMs?: number,
): MotionPlayback {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const total = reduced ? 1 : (durationMs ?? MOTION_PRESETS[preset].durationMs);
  const animations: Animation[] = [];
  let cancelled = false;
  let fallback: number | undefined;
  let paused = false;
  const animate = (
    element: HTMLElement | SVGElement,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ) => {
    if (typeof element.animate === "function")
      animations.push(element.animate(frames, options));
  };
  if (preset === "draw") {
    let items = [
      ...new Set(
        targets.flatMap((target) => {
          const children = Array.from(
            target.querySelectorAll<HTMLElement | SVGElement>(
              "[data-motion-item]",
            ),
          );
          return children.length ? children : [target];
        }),
      ),
    ];
    // Large objects reveal authored groups as units, keeping browser animation count bounded.
    if (items.length > 80)
      items = [
        ...new Set(
          targets.flatMap((target) => {
            const rows = Array.from(
              target.querySelectorAll<HTMLElement>("[data-motion-group]"),
            );
            return rows.length ? rows : [target];
          }),
        ),
      ].slice(0, 80);
    items = items.filter(
      (item) =>
        !items.some((parent) => parent !== item && parent.contains(item)),
    );
    const itemDuration = reduced
      ? 1
      : items.length === 1
        ? total
        : Math.min(350, total);
    const step =
      items.length > 1 ? (total - itemDuration) / (items.length - 1) : 0;
    items.forEach((element, index) =>
      animate(
        element,
        [
          { opacity: 0, clipPath: "inset(0 100% 0 0)" },
          { opacity: 1, clipPath: "inset(0 0% 0 0)" },
        ],
        {
          duration: itemDuration,
          delay: reduced ? 0 : index * step,
          fill: "backwards",
          easing: "ease-out",
        },
      ),
    );
    for (const target of targets)
      for (const stroke of Array.from(
        target.querySelectorAll<SVGPathElement>("[data-motion-stroke]"),
      ).slice(0, 8)) {
        const length = stroke.getTotalLength();
        animate(
          stroke,
          [
            { strokeDasharray: `${length}`, strokeDashoffset: length },
            { strokeDasharray: `${length}`, strokeDashoffset: 0 },
          ],
          { duration: reduced ? 1 : Math.min(450, total), easing: "ease-out" },
        );
      }
  } else {
    targets.slice(0, 80).forEach((element) =>
      animate(
        element,
        [
          { opacity: 1, filter: "brightness(1)" },
          { opacity: 0.5, filter: "brightness(1.45)" },
          { opacity: 1, filter: "brightness(1)" },
        ],
        { duration: total, iterations: 1, easing: "ease-in-out" },
      ),
    );
  }
  if (animations.length)
    Promise.all(animations.map((animation) => animation.finished))
      .then(() => {
        if (!cancelled) onComplete();
      })
      .catch(() => {});
  else {
    let elapsed = 0,
      last = performance.now();
    const tick = (now: number) => {
      if (cancelled) return;
      if (!paused) elapsed += now - last;
      last = now;
      if (elapsed >= total) onComplete();
      else fallback = requestAnimationFrame(tick);
    };
    fallback = requestAnimationFrame(tick);
  }
  return {
    pause: () => {
      paused = true;
      animations.forEach((animation) => animation.pause());
    },
    resume: () => {
      paused = false;
      // play() on a finished animation rewinds it; only paused ones resume.
      animations.forEach((animation) => {
        if (animation.playState === "paused") animation.play();
      });
    },
    cancel: () => {
      cancelled = true;
      if (fallback !== undefined) cancelAnimationFrame(fallback);
      animations.forEach((animation) => animation.cancel());
    },
  };
}
