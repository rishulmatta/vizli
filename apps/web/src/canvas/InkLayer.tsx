import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  addInkStroke,
  INK_COLORS,
  INK_WIDTHS,
  type InkStroke,
  type InkTool,
  type Scene,
} from "@vizli/shared";
import type { Camera } from "./useBoardCamera";

type Props = {
  scene: Scene;
  /** Latest committed scene; gestures commit against this, never a stale render closure. */
  sceneRef: RefObject<Scene>;
  inkTool: InkTool | null;
  isBoard: boolean;
  camera: Camera;
  scale: number;
  viewportHeight: number;
  stage: RefObject<HTMLDivElement | null>;
  /** `base` is the scene the mutation was derived from (`sceneRef.current` at commit time). */
  onCommit: (scene: Scene, base: Scene) => void;
};

/** Points closer than this (in stroke space) to the previous point are dropped. */
const MIN_POINT_DISTANCE = 1.5;
/** Schema limit: 2000 x,y pairs. Reaching it ends and commits the stroke. */
const MAX_POINT_NUMBERS = 4000;
/** Extra eraser reach in logical (screen-space) px, beyond the stroke's half width. */
const ERASER_REACH = 10;
/** Pointer path sampling step for the eraser so fast swipes do not skip strokes. */
const ERASER_SAMPLE_STEP = 8;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Quadratic-midpoint smoothing over a flat [x0, y0, x1, y1, …] list. */
export function inkPath(points: readonly number[]): string {
  const n = Math.floor(points.length / 2);
  if (n === 0) return "";
  const x = (i: number) => points[i * 2];
  const y = (i: number) => points[i * 2 + 1];
  // A single tap renders as a zero-length line; round caps turn it into a dot.
  if (n === 1) return `M${x(0)} ${y(0)} L${x(0)} ${y(0)}`;
  if (n === 2) return `M${x(0)} ${y(0)} L${x(1)} ${y(1)}`;
  let d = `M${x(0)} ${y(0)}`;
  for (let i = 1; i < n - 1; i++) {
    const mx = round2((x(i) + x(i + 1)) / 2);
    const my = round2((y(i) + y(i + 1)) / 2);
    d += ` Q${x(i)} ${y(i)} ${mx} ${my}`;
  }
  d += ` L${x(n - 1)} ${y(n - 1)}`;
  return d;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };
function strokeBox(points: readonly number[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]); maxY = Math.max(maxY, points[i + 1]);
  }
  return { minX, minY, maxX, maxY };
}

/** True when the pointer at (px, py) lies within `reach` of any segment (or the single point) of the stroke. */
function strokeHit(stroke: InkStroke, box: Box, px: number, py: number, reach: number) {
  if (px < box.minX - reach || px > box.maxX + reach || py < box.minY - reach || py > box.maxY + reach) return false;
  const p = stroke.points;
  if (p.length < 4) return Math.hypot(px - p[0], py - p[1]) <= reach;
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (segmentDistance(px, py, p[i], p[i + 1], p[i + 2], p[i + 3]) <= reach) return true;
  }
  return false;
}

type Gesture = {
  pointerId: number;
  sceneId: string;
  mode: "pen" | "eraser";
  points: number[];
  hits: Set<string>;
  last: { x: number; y: number } | null;
};

/**
 * Presenter ink: renders committed strokes in every mode and, when a tool is active, captures pointer input.
 * Ink is independent of attention effects and presentation playback; it never cancels either.
 * Pressure and tilt are intentionally ignored in this pass (constant-width strokes).
 */
export default function InkLayer({ scene, sceneRef, inkTool, isBoard, camera, scale, viewportHeight, stage, onCommit }: Props) {
  const [draft, setDraft] = useState<number[] | null>(null);
  const [erasing, setErasing] = useState<ReadonlySet<string>>(() => new Set());
  const gesture = useRef<Gesture | null>(null);
  const view = useRef({ camera, scale, isBoard, inkTool });
  view.current = { camera, scale, isBoard, inkTool };
  const ink = scene.ink ?? [];
  const boxes = useMemo(() => new Map(ink.map((stroke) => [stroke.id, strokeBox(stroke.points)])), [scene.ink]);
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;

  const reset = () => {
    gesture.current = null;
    setDraft(null);
    setErasing(new Set());
  };
  // A scene switch or tool change mid-gesture discards the uncommitted draft/erasure.
  useEffect(reset, [scene.id, inkTool?.mode]);

  const toStroke = (clientX: number, clientY: number) => {
    const rect = stage.current?.getBoundingClientRect();
    if (!rect) return null;
    const { camera: cam, scale: s, isBoard: board } = view.current;
    const lx = (clientX - rect.left) / s;
    const ly = (clientY - rect.top) / s;
    return board ? { x: cam.x + lx / cam.zoom, y: cam.y + ly / cam.zoom } : { x: lx, y: ly };
  };

  const eraseAt = (g: Gesture, x: number, y: number) => {
    const { camera: cam, isBoard: board } = view.current;
    const zoom = board ? cam.zoom : 1;
    const from = g.last ?? { x, y };
    const distance = Math.hypot(x - from.x, y - from.y);
    const steps = Math.max(1, Math.ceil((distance * zoom) / ERASER_SAMPLE_STEP));
    let changed = false;
    for (const stroke of sceneRef.current?.ink ?? []) {
      if (g.hits.has(stroke.id)) continue;
      const box = boxesRef.current.get(stroke.id) ?? strokeBox(stroke.points);
      // Stroke widths live in stroke space; the reach margin is constant on screen, so it shrinks in world units as you zoom in.
      const reach = stroke.width / 2 + ERASER_REACH / zoom;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        if (strokeHit(stroke, box, from.x + (x - from.x) * t, from.y + (y - from.y) * t, reach)) {
          g.hits.add(stroke.id);
          changed = true;
          break;
        }
      }
    }
    g.last = { x, y };
    if (changed) setErasing(new Set(g.hits));
  };

  const addPoint = (g: Gesture, x: number, y: number) => {
    if (g.points.length >= MAX_POINT_NUMBERS) return;
    const rx = round2(x), ry = round2(y);
    const n = g.points.length;
    // Thinning is measured in stroke space (world units on boards).
    if (n >= 2 && Math.hypot(rx - g.points[n - 2], ry - g.points[n - 1]) < MIN_POINT_DISTANCE) return;
    g.points.push(rx, ry);
  };

  const commit = (g: Gesture) => {
    gesture.current = null;
    const current = sceneRef.current;
    const tool = view.current.inkTool;
    if (!current || current.id !== g.sceneId) {
      reset();
      return;
    }
    if (g.mode === "pen" && tool?.mode === "pen" && g.points.length >= 2) {
      const color = INK_COLORS.find((c) => c.id === tool.color) ?? INK_COLORS[0];
      const stroke: InkStroke = {
        id: `ink-${crypto.randomUUID()}`,
        color: color.value,
        width: INK_WIDTHS[tool.width],
        ...(color.opacity < 1 ? { opacity: color.opacity } : {}),
        points: g.points,
      };
      onCommit(addInkStroke(current, stroke), current);
    } else if (g.mode === "eraser" && g.hits.size) {
      const ink = (current.ink ?? []).filter((s) => !g.hits.has(s.id));
      if (ink.length !== (current.ink ?? []).length) onCommit({ ...current, ink: ink.length ? ink : undefined }, current);
    }
    setDraft(null);
    setErasing(new Set());
  };

  const release = (event: ReactPointerEvent<SVGSVGElement>) => {
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* synthetic pointers have no capture */
    }
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!inkTool || !event.isPrimary || event.button !== 0) return;
    // Keep stage pan/selection and object moves from starting underneath the pen.
    event.stopPropagation();
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic PointerEvents (tests) use fake pointer ids */
    }
    const point = toStroke(event.clientX, event.clientY);
    if (!point) return;
    const g: Gesture = { pointerId: event.pointerId, sceneId: scene.id, mode: inkTool.mode, points: [], hits: new Set(), last: null };
    gesture.current = g;
    if (g.mode === "pen") {
      addPoint(g, point.x, point.y);
      setDraft([...g.points]);
    } else {
      setErasing(new Set());
      eraseAt(g, point.x, point.y);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g || event.pointerId !== g.pointerId) return;
    const native = event.nativeEvent;
    const coalesced = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    const samples = coalesced.length ? coalesced : [native];
    for (const sample of samples) {
      const point = toStroke(sample.clientX, sample.clientY);
      if (!point) continue;
      if (g.mode === "pen") addPoint(g, point.x, point.y);
      else eraseAt(g, point.x, point.y);
    }
    if (g.mode === "pen") {
      if (g.points.length >= MAX_POINT_NUMBERS) {
        gesture.current = null;
        release(event);
        commit(g);
        return;
      }
      setDraft([...g.points]);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g || event.pointerId !== g.pointerId) return;
    const point = toStroke(event.clientX, event.clientY);
    if (point) {
      if (g.mode === "pen") addPoint(g, point.x, point.y);
      else eraseAt(g, point.x, point.y);
    }
    gesture.current = null;
    release(event);
    commit(g);
  };

  const onPointerAbort = (event: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g || event.pointerId !== g.pointerId) return;
    reset();
  };

  const tool = inkTool ?? null;
  const draftColor = tool?.mode === "pen" ? INK_COLORS.find((c) => c.id === tool.color) ?? INK_COLORS[0] : null;
  const strokes = (
    <>
      {ink
        .filter((stroke) => !erasing.has(stroke.id))
        .map((stroke) => (
          <path
            key={stroke.id}
            data-ink-id={stroke.id}
            data-ink-color={stroke.color}
            d={inkPath(stroke.points)}
            fill="none"
            stroke={stroke.color}
            strokeWidth={stroke.width}
            strokeOpacity={stroke.opacity ?? 1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      {draft && draftColor && tool?.mode === "pen" && draft.length >= 2 && (
        <path
          data-ink-draft
          data-ink-color={draftColor.value}
          d={inkPath(draft)}
          fill="none"
          stroke={draftColor.value}
          strokeWidth={INK_WIDTHS[tool.width]}
          strokeOpacity={draftColor.opacity}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </>
  );

  return (
    <svg
      className="viz-ink-layer"
      data-testid="ink-layer"
      data-ink-active={tool ? tool.mode : undefined}
      viewBox={`0 0 1200 ${viewportHeight}`}
      aria-hidden={tool ? undefined : true}
      aria-label={tool ? (tool.mode === "pen" ? "Ink drawing surface" : "Ink eraser surface") : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerAbort}
      onLostPointerCapture={onPointerAbort}
    >
      {isBoard ? (
        <g transform={`translate(${-camera.x * camera.zoom} ${-camera.y * camera.zoom}) scale(${camera.zoom})`}>{strokes}</g>
      ) : (
        strokes
      )}
    </svg>
  );
}
