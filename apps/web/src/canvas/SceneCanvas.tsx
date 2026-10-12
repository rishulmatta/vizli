import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ReactFlow,
  Background,
  Handle,
  Position,
  MarkerType,
  type NodeProps,
  type Node,
  type Connection,
} from "@xyflow/react";
import {
  resolveImageAnchor,
  type BoardViewport,
  type Scene,
  type SceneObject,
  type Effect,
  type InkTool,
} from "@vizli/shared";
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import ObjectRenderer from "./renderers/registry";
import { targetElements } from "./semanticTargets";
import { playMotion } from "./motion/adapters";
import { playAttention } from "./motion/attention";
import { useBoardCamera } from "./useBoardCamera";
import PresentationLayer, { type PresentationFrame } from "./PresentationLayer";
import BoardBackdrop, { isNearCamera } from "./BoardBackdrop";
import InkLayer from "./InkLayer";
import PresenceLayer, { type PresenceMode } from "./PresenceLayer";
import type { PeerStore } from "../collab/useCollabDoc";

type Props = {
  scene: Scene;
  effect: Effect | null;
  selectedId: string | null;
  editable: boolean;
  selectable?: boolean;
  fillViewport?: boolean;
  panTool?: boolean;
  presentation?: PresentationFrame | null;
  onPresentationComplete?: (token: string) => void;
  onPresentationError?: (token: string, reason: string) => void;
  onSelect: (id: string | null) => void;
  /** `base` is the scene snapshot the edit was derived from (three-way commit into the shared document). */
  onChange: (scene: Scene, base: Scene) => void;
  /** Per-user whiteboard camera (local view state, not part of the shared scene). */
  camera: BoardViewport;
  onCameraChange: (camera: BoardViewport) => void;
  onApplied?: (actionId: string) => void;
  onAnimationComplete?: (actionId: string) => void;
  /** Active presenter ink tool. `null` (default) renders ink without capturing pointer input. */
  inkTool?: InkTool | null;
  /** Commit path for ink mutations; falls back to `onChange` when omitted. */
  onInkChange?: (scene: Scene, base: Scene) => void;
  /** Remote peers to render (cursors, selections). Omitted: no presence layer. */
  presence?: PeerStore;
  presenceMode?: PresenceMode;
  /** Local pointer in scene coordinates (slide logical px / whiteboard world px); `null` when it leaves the stage. */
  onCursor?: (point: { x: number; y: number } | null) => void;
};
type Bounds = { x: number; y: number; width: number; height: number };
const clamp = (n: number, low: number, high: number) =>
  Math.min(Math.max(n, low), Math.max(low, high));
type GraphNode = Node<{ object: SceneObject; editable: boolean }, "vizli">;
function DiagramNode({ data, selected }: NodeProps<GraphNode>) {
  return (
    <div
      className={`viz-graph-node ${selected ? "is-selected" : ""}`}
      data-target-id={data.object.id}
      data-object-id={data.object.id}
      style={{
        width: data.object.width,
        height: data.object.height,
        borderTopColor: data.object.color || "#355e4b",
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={data.editable}
      />
      <ObjectRenderer object={data.object} />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={data.editable}
      />
    </div>
  );
}
const nodeTypes = { vizli: DiagramNode };

export default function SceneCanvas({
  scene,
  effect,
  selectedId,
  editable,
  selectable = editable,
  fillViewport = false,
  panTool = false,
  presentation,
  onPresentationComplete,
  onPresentationError,
  onSelect,
  onChange,
  camera: cameraGoal,
  onCameraChange,
  onApplied,
  onAnimationComplete,
  inkTool = null,
  onInkChange,
  presence,
  presenceMode = "all",
  onCursor,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const overlay = useRef<SVGGElement>(null);
  const panGesture = useRef(false);
  const [surfaceSize, setSurfaceSize] = useState({ width: 1200, height: 675 });
  const isBoard = scene.layout === "whiteboard";
  const scale = Math.max(.001, fillViewport && !isBoard
    ? Math.min(surfaceSize.width / 1200, surfaceSize.height / 675)
    : surfaceSize.width / 1200);
  const viewportHeight = fillViewport && isBoard ? surfaceSize.height / scale : 675;
  const stageOffset = fillViewport && !isBoard
    ? { left: (surfaceSize.width - 1200 * scale) / 2, top: (surfaceSize.height - 675 * scale) / 2 }
    : { left: 0, top: 0 };
  const board = useBoardCamera(cameraGoal, scale, container, onCameraChange, viewportHeight, presentation ? {paused: presentation.paused, durationMs: presentation.step.type === "camera" ? presentation.step.durationMs : undefined} : undefined, scene.id, isBoard);
  const camera = board.camera;
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [expired, setExpired] = useState<string | null>(null);
  const [completedMotionId, setCompletedMotionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SceneObject | null>(null);
  // A resize handle unmounts when selection or scene changes mid-gesture; never leave its uncommitted draft on screen.
  useEffect(() => {
    setDraft((current) => (current && current.id === selectedId ? current : null));
  }, [selectedId, scene.id]);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [layoutError, setLayoutError] = useState("");
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const appliedIds = useRef(new Set<string>());
  const completedIds = useRef(new Set<string>());
  const callbacks = useRef({ onApplied, onAnimationComplete });
  callbacks.current = { onApplied, onAnimationComplete };
  const action = effect?.action.sceneId === scene.id ? effect.action : null;
  const targetId = action?.targetId;
  const motionPreset = action?.animation ?? scene.objects.find(object => action?.targetId === object.id || action?.targetId?.startsWith(`${object.id}:`))?.motion ?? 'pulse';
  const active =
    action &&
    action.id !== expired &&
    ["point", "highlight", "animate", "reveal"].includes(action.type);
  const flowActive = !!active && action.type === "animate" && motionPreset === "flow" && completedMotionId !== action.id;

  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const resize = () => setSurfaceSize(previous => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      return previous.width === next.width && previous.height === next.height ? previous : next;
    });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const measure = useCallback(() => {
    if (!stage.current || !targetId || !scale) {
      setBounds(null);
      return;
    }
    const elements = targetElements(stage.current, targetId);
    if (!elements.length) {
      setBounds(null);
      return;
    }
    const rects = elements.map((el) => el.getBoundingClientRect());
    const left = Math.min(...rects.map((r) => r.left)),
      top = Math.min(...rects.map((r) => r.top));
    const rect = {
      x: left,
      y: top,
      width: Math.max(...rects.map((r) => r.right)) - left,
      height: Math.max(...rects.map((r) => r.bottom)) - top,
    };
    const base = stage.current.getBoundingClientRect();
    setBounds({
      x: (rect.x - base.x) / scale,
      y: (rect.y - base.y) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    });
  }, [targetId, scale]);
  useLayoutEffect(() => {
    measure();
  }, [measure, scene, draft, camera.x, camera.y, camera.zoom, viewportHeight, stageOffset.left, stageOffset.top]);
  const measureRef = useRef(measure);
  measureRef.current = measure;

  useLayoutEffect(() => {
    if (!action) return;
    let cancelled = false;
    let motion: ReturnType<typeof playMotion> | undefined;
    let frame: number | undefined;
    const started = performance.now();
    const run = () => {
      if (cancelled) return;
      measureRef.current();
      const requiresTarget = [
        "point",
        "highlight",
        "animate",
        "reveal",
      ].includes(action.type);
      const targets = targetElements(stage.current, action.targetId);
      const target = targets[0];
      if (requiresTarget && !target) {
        if (performance.now() - started < 4000) frame = requestAnimationFrame(run);
        return;
      }
      if (!appliedIds.current.has(action.id)) {
        appliedIds.current.add(action.id);
        if (appliedIds.current.size > 256)
          appliedIds.current.delete(appliedIds.current.values().next().value!);
        callbacks.current.onApplied?.(action.id);
      }
      const complete = () => {
        if (cancelled || completedIds.current.has(action.id)) return;
        completedIds.current.add(action.id);
        setCompletedMotionId(action.id);
        if (completedIds.current.size > 256)
          completedIds.current.delete(
            completedIds.current.values().next().value!,
          );
        callbacks.current.onAnimationComplete?.(action.id);
      };
      if (action.type === "animate") {
        motion = playMotion(targets, motionPreset, complete, action.durationMs);
      } else if (action.type === "point" || action.type === "highlight") {
        motion = playAttention(() => overlay.current, action.type === "point", action.durationMs ?? 1400, complete);
      }
    };
    // Draw is installed before the browser paints newly inserted content.
    if (action.type === "animate") run();
    else frame = requestAnimationFrame(run);
    // The overlay outlives the longest allowed action duration, so completion never follows an unmounted ring.
    const expiry = setTimeout(
      () => setExpired(action.id),
      Math.max(action.type === "point" ? 6000 : 4500, (action.durationMs ?? 0) + 500),
    );
    return () => {
      cancelled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(expiry);
      motion?.cancel();
    };
  }, [action?.id, scene.id]);

  const entranceIds = useRef({ sceneId: scene.id, ids: new Set(scene.objects.map(object => object.id)) });
  const entrances = useRef(new Map<string, ReturnType<typeof playMotion>>());
  useLayoutEffect(() => {
    if (entranceIds.current.sceneId !== scene.id) {
      entrances.current.forEach(motion => motion.cancel()); entrances.current.clear();
      entranceIds.current = { sceneId: scene.id, ids: new Set(scene.objects.map(object => object.id)) };
      return;
    }
    const ids = new Set(scene.objects.map(object => object.id));
    entrances.current.forEach((motion, id) => { if (!ids.has(id)) { motion.cancel(); entrances.current.delete(id); } });
    for (const object of scene.objects) {
      if (presentation || entranceIds.current.ids.has(object.id) || object.motion !== "draw" || (action?.type === "animate" && action.targetId === object.id)) continue;
      const targets = targetElements(stage.current, object.id);
      if (targets.length) entrances.current.set(object.id, playMotion(targets, "draw", () => entrances.current.delete(object.id)));
    }
    entranceIds.current.ids = ids;
  }, [scene.id, scene.objects, action?.id]);
  useEffect(() => () => { entrances.current.forEach(motion => motion.cancel()); }, []);

  const draftObjects = scene.objects.map((o) =>
    draft?.id === o.id ? draft : o,
  );
  const draftScene = { ...scene, objects: draftObjects };
  const objects = draftObjects.map((object) =>
    resolveImageAnchor(object, draftScene),
  );
  const beginMove = (
    event: ReactPointerEvent<HTMLDivElement>,
    object: SceneObject,
    resize = false,
  ) => {
    if (isBoard && (panTool || board.space || event.button === 1)) { board.beginPan(event); return; }
    if (!editable || !event.isPrimary || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    onSelect(object.id);
    const startX = event.clientX,
      startY = event.clientY;
    const originalSceneId = scene.id;
    let updated = object;
    const surface = event.currentTarget;
    surface.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const factor = scale * (isBoard ? camera.zoom : 1);
      const dx = (e.clientX - startX) / factor,
        dy = (e.clientY - startY) / factor;
      if (dx === 0 && dy === 0) return;
      updated = resize
        ? {
            ...object,
            width: clamp(object.width + dx, 80, isBoard ? 2400 : 1200 - object.x),
            height: clamp(object.height + dy, 55, isBoard ? 1350 : 675 - object.y),
          }
        : {
            ...object,
            ...(object.kind === "image" ? { anchor: undefined } : {}),
            x: clamp(object.x + dx, isBoard ? -1e6 : 0, isBoard ? 1e6 : 1200 - object.width),
            y: clamp(object.y + dy, isBoard ? -1e6 : 0, isBoard ? 1e6 : 675 - object.height),
          };
      setDraft(updated);
    };
    const finish = (e: PointerEvent) => {
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerup", finish);
      surface.removeEventListener("pointercancel", cancel);
      surface.removeEventListener("lostpointercapture", cancel);
      if (surface.hasPointerCapture(e.pointerId))
        surface.releasePointerCapture(e.pointerId);
      setDraft(null);
      const base = sceneRef.current;
      if (base.id === originalSceneId && updated !== object)
        onChange({
          ...base,
          objects: base.objects.map((o) =>
            o.id === object.id ? updated : o,
          ),
        }, base);
    };
    const cancel = (e: PointerEvent) => {
      updated = object;
      finish(e);
    };
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerup", finish);
    surface.addEventListener("pointercancel", cancel);
    surface.addEventListener("lostpointercapture", cancel);
  };

  const graphNodes = useMemo<GraphNode[]>(
    () =>
      objects
        .filter((o) => o.kind === "node" && (!o.hidden || editable))
        .map((object) => ({
          id: object.id,
          type: "vizli",
          position: { x: object.x, y: object.y },
          data: { object, editable },
          selected: selectedId === object.id,
          draggable: editable,
          style: { opacity: object.hidden ? 0.35 : 1 },
        })),
    [scene.objects, draft, editable, selectedId],
  );
  const graphEdges = useMemo(
    () =>
      scene.connections.map((c) => ({
        ...c,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, color: "#719582" },
        style: { stroke: "#719582", strokeWidth: 2 },
        labelStyle: { fill: "#587265", fontSize: 12 },
        labelBgStyle: { fill: "#fcfcf8" },
        animated:
          flowActive &&
          (c.source === targetId || c.target === targetId),
      })),
    [scene.connections, flowActive, targetId],
  );
  const onConnect = (connection: Connection) => {
    if (
      !editable ||
      !connection.source ||
      !connection.target ||
      connection.source === connection.target
    )
      return;
    if (
      scene.connections.some(
        (c) => c.source === connection.source && c.target === connection.target,
      )
    )
      return;
    onChange({
      ...scene,
      connections: [
        ...scene.connections,
        {
          id: `edge-${crypto.randomUUID()}`,
          source: connection.source,
          target: connection.target,
        },
      ],
    }, scene);
  };
  const autoLayout = async () => {
    setLayoutBusy(true);
    setLayoutError("");
    const snapshot = scene;
    try {
      const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
      const result = await new ELK().layout({
        id: "root",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "RIGHT",
          "elk.spacing.nodeNode": "50",
          "elk.layered.spacing.nodeNodeBetweenLayers": "95",
        },
        children: scene.objects
          .filter((o) => o.kind === "node")
          .map((o) => ({ id: o.id, width: o.width, height: o.height })),
        edges: scene.connections.map((c) => ({
          id: c.id,
          sources: [c.source],
          targets: [c.target],
        })),
      });
      if (sceneRef.current !== snapshot) return;
      onChange({
        ...scene,
        objects: scene.objects.map((o) => {
          const p = result.children?.find((n) => n.id === o.id);
          return p
            ? {
                ...o,
                x: clamp((p.x ?? 0) + 90, 0, 1200 - o.width),
                y: clamp((p.y ?? 0) + 220, 170, 675 - o.height - 40),
              }
            : o;
        }),
      }, scene);
    } catch {
      setLayoutError("Could not arrange this diagram. Move nodes manually.");
    } finally {
      setLayoutBusy(false);
    }
  };

  return (
    <div
      className={`viz-canvas-shell ${editable ? "is-editable" : "is-presenting"} ${isBoard ? "is-whiteboard" : ""} ${isBoard && (panTool || board.space) ? "is-pan-ready" : ""} ${fillViewport ? "is-full-viewport" : ""}`}
      ref={container}
      data-testid="scene-canvas"
      data-layout={isBoard ? "whiteboard" : "slide"}
      data-viewport-width={1200}
      data-viewport-height={viewportHeight}
      data-camera-x={isBoard ? camera.x : undefined}
      data-camera-y={isBoard ? camera.y : undefined}
      data-camera-zoom={isBoard ? camera.zoom : undefined}
      data-navigation-state={isBoard ? board.navigation : undefined}
    >
      <div
        className="viz-scene-stage"
        ref={stage}
        style={{ transform: `scale(${scale})`, height: viewportHeight, ...stageOffset, ...(isBoard ? { backgroundImage: 'radial-gradient(#b9cbb5 1px, transparent 1px)', backgroundSize: `${24 * camera.zoom}px ${24 * camera.zoom}px`, backgroundPosition: `${-camera.x * camera.zoom}px ${-camera.y * camera.zoom}px` } : {}) }}
        tabIndex={isBoard ? 0 : undefined}
        onPointerMove={onCursor ? (event) => {
          const rect = stage.current?.getBoundingClientRect();
          if (!rect) return;
          const lx = (event.clientX - rect.left) / scale;
          const ly = (event.clientY - rect.top) / scale;
          const point = isBoard ? { x: camera.x + lx / camera.zoom, y: camera.y + ly / camera.zoom } : { x: lx, y: ly };
          onCursor({ x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 });
        } : undefined}
        onPointerLeave={onCursor ? () => onCursor(null) : undefined}
        onPointerDownCapture={(event) => {
          if (!event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
          panGesture.current = false;
          const target = event.target as HTMLElement;
          // The ink layer owns primary-button gestures while a tool is active (capture runs before its handler).
          if (event.button === 0 && target.closest(".viz-ink-layer")) return;
          if (target.closest(".viz-board-controls") || (!isBoard && target.closest("button"))) return;
          const overObject = Boolean(target.closest("[data-object-id]"));
          if (isBoard && (panTool || board.space || event.button === 1 || !overObject)) {
            panGesture.current = true;
            if (selectable && !overObject && !panTool && !board.space && event.button === 0) onSelect(null);
            board.beginPan(event);
          } else if (selectable && !overObject) onSelect(null);
        }}
        onClickCapture={(event) => {
          if (isBoard && (panGesture.current || panTool || board.space) && !(event.target as HTMLElement).closest(".viz-board-controls")) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        role="region"
        aria-label={`${scene.title} canvas`}
      >
        {!isBoard && <><div className="viz-scene-decoration" />
        <header className="viz-scene-header">
          <div className="viz-scene-kicker">
            <span />
            {scene.kind === "math"
              ? "THE LEARNING SERIES"
              : scene.kind === "architecture"
                ? "SYSTEMS, EXPLAINED"
                : "THE GROWTH PLAYBOOK"}
          </div>
          <h1>{scene.title}</h1>
          <p>{scene.subtitle}</p>
        </header></>}
        {isBoard && <BoardBackdrop scene={scene} camera={camera} viewportHeight={viewportHeight} objects={objects} animatedTarget={flowActive ? targetId : undefined} />}
        {!isBoard && scene.kind === "architecture" && (
          <div
            className="viz-graph-surface"
            style={{
              width: 1200 * scale,
              height: 675 * scale,
              transform: `scale(${1 / (scale || 1)})`,
              transformOrigin: "top left",
            }}
          >
            <ReactFlow<GraphNode>
              nodes={graphNodes}
              edges={graphEdges}
              nodeTypes={nodeTypes}
              viewport={{ x: 0, y: 0, zoom: scale }}
              minZoom={scale}
              maxZoom={scale}
              panOnDrag={false}
              zoomOnScroll={false}
              zoomOnPinch={false}
              zoomOnDoubleClick={false}
              preventScrolling={false}
              nodeDragThreshold={0}
              nodesDraggable={editable}
              nodesConnectable={editable}
              elementsSelectable={selectable}
              onNodeClick={(_, node) => {
                if (selectable) onSelect(node.id);
              }}
              onPaneClick={() => {
                if (selectable) onSelect(null);
              }}
              onConnect={onConnect}
              onNodeDrag={(_, node) => {
                setDraft({
                  ...node.data.object,
                  x: node.position.x,
                  y: node.position.y,
                });
                measure();
              }}
              onNodeDragStop={(_, node) => {
                setDraft(null);
                onChange({
                  ...scene,
                  objects: scene.objects.map((o) =>
                    o.id === node.id
                      ? {
                          ...o,
                          x: clamp(node.position.x, 0, 1200 - o.width),
                          y: clamp(node.position.y, 165, 675 - o.height),
                        }
                      : o,
                  ),
                }, scene);
              }}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#c6d6ca" gap={24} size={1} />
            </ReactFlow>
          </div>
        )}
        <div className={isBoard ? "viz-board-world" : undefined} style={isBoard ? { transform: `translate(${-camera.x * camera.zoom}px, ${-camera.y * camera.zoom}px) scale(${camera.zoom})` } : undefined}>
        {objects
          .filter((o) => isBoard || scene.kind !== "architecture" || o.kind !== "node")
          .filter((o) => !isBoard || isNearCamera(o, camera, viewportHeight))
          .filter((o) => !o.hidden || editable)
          .map((object) => (
            <div
              key={object.id}
              data-object-id={object.id}
              data-target-id={object.id}
              className={`viz-object viz-object-${object.kind} ${selectable && selectedId === object.id ? "is-selected" : ""} ${object.hidden ? "is-hidden" : ""}`}
              style={{
                left: object.x,
                top: object.y,
                width: object.width,
                height: object.height,
              }}
              onPointerDown={(e) => beginMove(e, object)}
              onClick={(e) => {
                e.stopPropagation();
                if (selectable) onSelect(object.id);
              }}
            >
              <ObjectRenderer object={object} />
              {object.hidden && editable && (
                <span className="viz-hidden-badge">Hidden until cued</span>
              )}
              {editable && selectedId === object.id && (
                <>
                  <div className="viz-selection-tag">{object.kind}</div>
                  <div
                    className="viz-resize-handle"
                    onPointerDown={(e) => beginMove(e, object, true)}
                    aria-label={`Resize ${object.label}`}
                  />
                </>
              )}
            </div>
          ))}
        </div>
        <svg
          className="viz-attention-layer"
          viewBox={`0 0 1200 ${viewportHeight}`}
          aria-hidden="true"
        >
          {active && bounds && (
            <g
              ref={overlay}
              key={action.id}
              style={action.type === "highlight" ? {opacity: 0} : undefined}
              data-testid="visual-effect"
              data-motion-preset={action.type === "animate" ? motionPreset : undefined}
              data-target-id={targetId}
            >
              <rect
                className="viz-highlight-ring"
                data-trace-outline
                pathLength="1"
                style={action.type === "point" ? {strokeDasharray: 1, strokeDashoffset: 1} : undefined}
                x={bounds.x - 7}
                y={bounds.y - 7}
                width={bounds.width + 14}
                height={bounds.height + 14}
                rx={action.type === "point" ? 0 : 10}
                fill={action.type === "point" ? "none" : (action.color ?? "#d8eaa5")}
                fillOpacity={action.type === "point" ? 0 : .2}
                stroke={action.color ?? (action.type === "point" ? "#ca5547" : "#789743")}
                strokeWidth="2.5"
              />
              {action.type === "point" && (
                <circle data-trace-head cx={bounds.x - 7} cy={bounds.y - 7} r="4" fill={action.color ?? "#c94f43"} />
              )}
            </g>
          )}
        </svg>
        <InkLayer
          scene={scene}
          sceneRef={sceneRef}
          inkTool={inkTool}
          isBoard={isBoard}
          camera={camera}
          scale={scale}
          viewportHeight={viewportHeight}
          stage={stage}
          onCommit={onInkChange ?? onChange}
        />
        {presence && <PresenceLayer scene={scene} store={presence} presenceMode={presenceMode} isBoard={isBoard} camera={camera} viewportHeight={viewportHeight} />}
        {presentation && <PresentationLayer frame={presentation} stage={stage} scale={scale} scene={scene} camera={camera} cameraGoal={cameraGoal} viewportHeight={viewportHeight} onComplete={onPresentationComplete} onError={onPresentationError} />}
        {!isBoard && !fillViewport && <footer className="viz-scene-footer">
          <span>
            VIZLI <i> / </i> IDEAS, IN MOTION.
          </span>
          <span>
            {scene.kind === "math"
              ? "UNDERSTAND EVERY STEP"
              : scene.kind === "architecture"
                ? "MAKE THE INVISIBLE VISIBLE"
                : "A CLEARER PICTURE"}
          </span>
        </footer>}
        {!isBoard && scene.kind === "architecture" && editable && (
          <button
            className="viz-arrange"
            onClick={autoLayout}
            disabled={layoutBusy}
          >
            {layoutBusy ? "Arranging…" : "↗ Auto arrange"}
          </button>
        )}
        {isBoard && <div className="viz-board-controls" onPointerDown={event => event.stopPropagation()}>
          <span>{Math.round(camera.zoom * 100)}% · Drag background to pan · Ctrl/⌘ scroll to zoom</span>
        </div>}
        {layoutError && (
          <div className="viz-layout-error" role="status">
            {layoutError}
          </div>
        )}
      </div>
    </div>
  );
}
