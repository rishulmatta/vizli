import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { PresentationStep, Scene } from "@vizli/shared";
import { targetElements } from "./semanticTargets";
import { playMotion, type MotionPlayback } from "./motion/adapters";
import { playAttention } from "./motion/attention";
export type PresentationFrame = {
  token: string;
  step: PresentationStep;
  paused: boolean;
};
type Rect = { id: string; x: number; y: number; width: number; height: number };
export default function PresentationLayer({
  frame,
  stage,
  scale,
  scene,
  camera,
  viewportHeight,
  onComplete,
  onError,
}: {
  frame: PresentationFrame;
  stage: RefObject<HTMLDivElement | null>;
  scale: number;
  scene: Scene;
  camera: { x: number; y: number; zoom: number };
  viewportHeight: number;
  onComplete?: (token: string) => void;
  onError?: (token: string, reason: string) => void;
}) {
  const [rects, setRects] = useState<Rect[]>([]);
  const overlay = useRef<SVGSVGElement>(null);
  const latest = useRef({ frame, onComplete, onError, camera, scene });
  latest.current = { frame, onComplete, onError, camera, scene };
  const motions = useRef<MotionPlayback[]>([]);
  useLayoutEffect(() => {
    if (frame.step.type !== "attention" || !stage.current) {
      setRects([]);
      return;
    }
    const origin = stage.current.getBoundingClientRect();
    setRects(
      frame.step.targets.flatMap((id) => {
        const boxes = targetElements(stage.current, id).map((el) =>
          el.getBoundingClientRect(),
        );
        if (!boxes.length) return [];
        const x = Math.min(...boxes.map((b) => b.x)),
          y = Math.min(...boxes.map((b) => b.y));
        return [
          {
            id,
            x: (x - origin.x) / scale - 7,
            y: (y - origin.y) / scale - 7,
            width: (Math.max(...boxes.map((b) => b.right)) - x) / scale + 14,
            height: (Math.max(...boxes.map((b) => b.bottom)) - y) / scale + 14,
          },
        ];
      }),
    );
  }, [frame.token, scene, scale, camera.x, camera.y, camera.zoom]);
  useLayoutEffect(() => {
    let cancelled = false,
      raf = 0,
      done = false;
    const complete = () => {
      if (cancelled || done) return;
      if (latest.current.frame.paused) {
        raf = requestAnimationFrame(complete);
        return;
      }
      done = true;
      latest.current.onComplete?.(frame.token);
    };
    const fail = (message: string) => {
      if (!cancelled && !done) {
        done = true;
        latest.current.onError?.(frame.token, message);
      }
    };
    const step = frame.step;
    if (
      (step.type === "insert" || step.type === "update") &&
      step.entrance === "draw"
    ) {
      const ids =
        step.type === "update" && step.entranceTargets
          ? step.entranceTargets
          : step.objects.map((object) => object.id);
      const targets = ids.flatMap((id) => targetElements(stage.current, id));
      if (ids.some((id) => !targetElements(stage.current, id).length)) {
        raf = requestAnimationFrame(() =>
          fail("A lesson object is outside the visible canvas."),
        );
        return () => cancelAnimationFrame(raf);
      }
      const playback = playMotion(targets, "draw", complete, step.durationMs);
      motions.current = [playback];
      if (frame.paused) playback.pause();
    } else if (step.type === "attention") {
      raf = requestAnimationFrame(() => {
        if (cancelled) return;
        const groups = Array.from(
          overlay.current?.querySelectorAll<SVGGElement>(
            "[data-presentation-target]",
          ) ?? [],
        );
        if (groups.length !== step.targets.length) {
          fail("A lesson target is missing or outside the visible canvas.");
          return;
        }
        let pending = groups.length;
        motions.current = groups.map((group) =>
          playAttention(
            group,
            step.style === "point",
            step.durationMs ?? 1400,
            () => {
              if (--pending === 0) complete();
            },
          ),
        );
        if (latest.current.frame.paused)
          motions.current.forEach((m) => m.pause());
      });
    } else if (step.type === "camera") {
      let elapsed = 0,
        last = performance.now();
      const settled = () => {
        if (cancelled) return;
        const now = performance.now();
        if (!latest.current.frame.paused) elapsed += now - last;
        last = now;
        if (elapsed > 15000) {
          fail("The canvas camera did not reach the lesson view.");
          return;
        }
        const { camera: current, scene: currentScene } = latest.current;
        const goal = currentScene.viewport ?? { x: 0, y: 0, zoom: 1 };
        if (
          Math.abs(current.x - goal.x) < 0.01 &&
          Math.abs(current.y - goal.y) < 0.01 &&
          Math.abs(current.zoom - goal.zoom) < 0.001
        )
          complete();
        else raf = requestAnimationFrame(settled);
      };
      raf = requestAnimationFrame(settled);
    } else raf = requestAnimationFrame(complete);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      motions.current.forEach((m) => m.cancel());
      motions.current = [];
    };
  }, [frame.token, scene.id]);
  useLayoutEffect(() => {
    motions.current.forEach((m) => (frame.paused ? m.pause() : m.resume()));
  }, [frame.paused]);
  if (frame.step.type !== "attention") return null;
  const attention = frame.step;
  const color =
    attention.color ?? (attention.style === "point" ? "#ca5547" : "#789743");
  return (
    <svg
      ref={overlay}
      className="viz-attention-layer"
      viewBox={`0 0 1200 ${viewportHeight}`}
      aria-hidden="true"
    >
      {rects.map((rect) => (
        <g
          key={`${frame.token}:${rect.id}`}
          style={attention.style === "highlight" ? { opacity: 0 } : undefined}
          data-presentation-target={rect.id}
          data-testid="visual-effect"
          data-target-id={rect.id}
        >
          <rect
            data-trace-outline
            pathLength="1"
            style={
              attention.style === "point"
                ? { strokeDasharray: 1, strokeDashoffset: 1 }
                : undefined
            }
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            rx={attention.style === "point" ? 0 : 8}
            stroke={color}
            strokeWidth="2.5"
            fill={attention.style === "point" ? "none" : color}
            fillOpacity={attention.style === "point" ? 0 : 0.13}
          />
          {attention.style === "point" && (
            <circle
              data-trace-head
              cx={rect.x}
              cy={rect.y}
              r="4"
              fill={color}
            />
          )}
        </g>
      ))}
    </svg>
  );
}
