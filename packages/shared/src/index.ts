import { z } from "zod";
import { invalidateDerivedResults } from "./presentation.js";
import { objectTargets } from "./plugins.js";
export * from "./plugins.js";
export * from "./attention.js";
import {
  MotionPresetSchema,
  pluginFields,
  validatePluginObject,
} from "./plugin-contracts.js";
export { MotionPresetSchema } from "./plugin-contracts.js";

const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_:-]+$/);
const finite = z.number().finite();
export const SceneObjectSchema = z
  .object({
    id,
    kind: z.enum(["text", "metric", "chart", "matrix", "image", "node"]),
    label: z.string().max(300),
    ...pluginFields,
    derivedFrom: z
      .object({
        sourceIds: z.array(id).min(1).max(30),
        sourceSignature: z.string().max(20000),
      })
      .strict()
      .optional(),
    x: finite.min(-1_000_000).max(1_000_000),
    y: finite.min(-1_000_000).max(1_000_000),
    width: finite.positive().max(2400),
    height: finite.positive().max(1350),
    color: z.string().max(80).optional(),
    text: z.string().max(10000).optional(),
    value: z.string().max(300).optional(),
    data: z.array(finite).max(200).optional(),
    labels: z.array(z.string().max(200)).max(200).optional(),
    cells: z
      .array(
        z
          .array(z.union([finite, z.string().max(300)]))
          .min(1)
          .max(30),
      )
      .min(1)
      .max(30)
      .optional(),
    src: z
      .string()
      .max(6_000_000)
      .refine(
        (v) =>
          /^https?:\/\//i.test(v) ||
          /^data:image\/(png|jpeg|webp|gif);base64,/i.test(v),
        "Use an HTTP image URL or supported image data URL",
      )
      .optional(),
    anchor: z
      .object({ targetId: id, kind: z.literal("x-axis") })
      .strict()
      .optional(),
    imageSource: z
      .object({
        query: z.string().max(200),
        pageUrl: z
          .string()
          .url()
          .max(2000)
          .refine((v) => /^https:\/\//i.test(v)),
        provider: z.string().max(100),
        attribution: z.string().max(2000).optional(),
        license: z.string().max(300).optional(),
      })
      .strict()
      .optional(),
    hidden: z.boolean().optional(),
    aliases: z.array(z.string().min(1).max(200)).max(50).optional(),
  })
  .strict()
  .superRefine(validatePluginObject);
export const SceneConnectionSchema = z
  .object({ id, source: id, target: id, label: z.string().max(300).optional() })
  .strict();
export const BoardViewportSchema = z
  .object({
    x: finite.min(-1_000_000).max(1_000_000),
    y: finite.min(-1_000_000).max(1_000_000),
    zoom: finite.min(0.25).max(2),
  })
  .strict();
export const BoardAreaSchema = z
  .object({
    id,
    label: z.string().min(1).max(300),
    x: finite.min(-1_000_000).max(1_000_000),
    y: finite.min(-1_000_000).max(1_000_000),
    width: finite.positive().max(2400),
    height: finite.positive().max(1350),
  })
  .strict();
export const BoardNavigationSchema = z
  .object({
    direction: z.enum(["left", "right", "up", "down"]).optional(),
    areaId: id.optional(),
    targetId: id.optional(),
    zoom: z.enum(["in", "out", "reset"]).optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).filter((v) => v !== undefined).length === 1,
    "Choose one navigation action",
  );
export type BoardViewport = z.infer<typeof BoardViewportSchema>;
export type BoardArea = z.infer<typeof BoardAreaSchema>;
export type BoardNavigation = z.infer<typeof BoardNavigationSchema>;
export const LessonContextSchema = z
  .object({
    anchor: z
      .object({
        x: finite.min(-1_000_000).max(1_000_000),
        y: finite.min(-1_000_000).max(1_000_000),
      })
      .strict()
      .optional(),
    domain: z.string().min(1).max(100),
    sourceIds: z.array(id).max(30),
    sourceSignature: z.string().max(20000).optional(),
    completedCueIds: z.array(id).max(100),
  })
  .strict();
export const AttentionColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
export const SceneSchema = z
  .object({
    id,
    title: z.string().max(300),
    subtitle: z.string().max(1000),
    kind: z.enum(["slide", "math", "architecture"]),
    layout: z.enum(["slide", "whiteboard"]).optional(),
    viewport: BoardViewportSchema.optional(),
    areas: z.array(BoardAreaSchema).max(200).optional(),
    activeAreaId: id.optional(),
    lesson: LessonContextSchema.optional(),
    objects: z.array(SceneObjectSchema).max(300),
    connections: z.array(SceneConnectionSchema).max(500),
  })
  .strict()
  .superRefine((s, ctx) => {
    const ids = new Set(s.objects.map((o) => o.id));
    if (
      new Set(s.areas?.map((area) => area.id)).size !== (s.areas?.length ?? 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "Board area IDs must be unique",
      });
    if (s.activeAreaId && !s.areas?.some((area) => area.id === s.activeAreaId))
      ctx.addIssue({ code: "custom", message: "Active board area is missing" });
    if (ids.size !== s.objects.length)
      ctx.addIssue({ code: "custom", message: "Object IDs must be unique" });
    if (s.connections.some((c) => !ids.has(c.source) || !ids.has(c.target)))
      ctx.addIssue({
        code: "custom",
        message: "Connection endpoint is missing",
      });
    for (const object of s.objects) {
      if (
        object.anchor &&
        (object.kind !== "image" ||
          object.anchor.targetId === object.id ||
          !s.objects.some(
            (target) =>
              target.id === object.anchor!.targetId && target.kind === "chart",
          ))
      )
        ctx.addIssue({
          code: "custom",
          message: "Only images can anchor to an existing chart x axis",
        });
    }
    for (const o of s.objects)
      if (o.cells?.some((row) => row.length !== o.cells![0]!.length))
        ctx.addIssue({
          code: "custom",
          message: "Matrix rows must have equal lengths",
        });
  });
export const CueSchema = z
  .object({
    id,
    sceneId: id,
    phrase: z.string().min(1).max(1000),
    targetId: id,
    action: z.enum(["highlight", "point", "reveal", "animate"]),
  })
  .strict();
export const ProjectSchema = z
  .object({
    id,
    title: z.string().max(300),
    scenes: z.array(SceneSchema).min(1).max(100),
    cues: z.array(CueSchema).max(1000),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (new Set(p.scenes.map((s) => s.id)).size !== p.scenes.length)
      ctx.addIssue({ code: "custom", message: "Scene IDs must be unique" });
    for (const c of p.cues) {
      const s = p.scenes.find((s) => s.id === c.sceneId);
      if (!s || !hasTarget(s, c.targetId))
        ctx.addIssue({ code: "custom", message: "Cue target is missing" });
    }
  });
export const ObjectEditPatchSchema = z
  .object({
    label: z.string().min(1).max(300).optional(),
    text: z.string().max(10000).optional(),
    value: z.string().max(300).optional(),
    width: finite.positive().max(2400).optional(),
    height: finite.positive().max(1350).optional(),
    color: z
      .string()
      .min(1)
      .max(80)
      .regex(/^(?:#[\da-f]{3,8}|[a-z]{1,30}|(?:rgb|hsl)a?\([\d\s.,%+-]+\))$/i)
      .optional(),
    matrix: z
      .object({
        rows: z.number().int().min(1).max(30).optional(),
        cols: z.number().int().min(1).max(30).optional(),
      })
      .strict()
      .refine(
        (value) => value.rows !== undefined || value.cols !== undefined,
        "Specify rows or columns",
      )
      .optional(),
    cell: z
      .object({
        row: z.number().int().min(0).max(29),
        col: z.number().int().min(0).max(29),
        value: finite,
      })
      .strict()
      .optional(),
    chartDatum: z
      .object({ index: z.number().int().min(0).max(199), value: finite })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      Object.keys(value).some(
        (key) => value[key as keyof typeof value] !== undefined,
      ),
    "Specify at least one edit",
  );
export type ObjectEditPatch = z.infer<typeof ObjectEditPatchSchema>;

export const PresentationStepSchema = z.discriminatedUnion("type", [
  z
    .object({
      id,
      type: z.literal("insert"),
      objects: z.array(SceneObjectSchema).max(30),
      /** Connections are added atomically with their endpoint objects. Existing scene edges are preserved. */
      connections: z.array(SceneConnectionSchema).max(50).optional(),
      lesson: LessonContextSchema.optional(),
      entrance: z.literal("draw").optional(),
      durationMs: z.number().int().min(0).max(5000).optional(),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal("update"),
      objects: z.array(SceneObjectSchema).min(1).max(30),
      entranceTargets: z.array(id).min(1).max(30).optional(),
      entrance: z.literal("draw").optional(),
      durationMs: z.number().int().min(0).max(5000).optional(),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal("attention"),
      targets: z.array(id).min(1).max(4),
      style: z.enum(["point", "highlight"]),
      color: AttentionColorSchema.optional(),
      durationMs: z.number().int().min(100).max(5000),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal("camera"),
      dx: finite.min(-2400).max(2400),
      dy: finite.min(-2400).max(2400),
      durationMs: z.number().int().min(100).max(3000).optional(),
    })
    .strict(),
  z.object({ id, type: z.literal("reveal"), targetId: id }).strict(),
  z
    .object({
      id,
      type: z.literal("wait"),
      durationMs: z.number().int().min(0).max(5000),
    })
    .strict(),
  z
    .object({ id, type: z.literal("context"), lesson: LessonContextSchema })
    .strict(),
]).superRefine((step, ctx) => {
  if (
    step.type === "insert" &&
    step.objects.length === 0 &&
    (step.connections?.length ?? 0) === 0
  )
    ctx.addIssue({
      code: "custom",
      message: "Insert a visual object or add a connection",
    });
});
export const PresentationSequenceSchema = z
  .object({
    id,
    domain: z.string().min(1).max(100),
    steps: z.array(PresentationStepSchema).min(1).max(60),
    sourceIds: z.array(id).max(30).optional(),
    sourceSignature: z.string().max(20000).optional(),
  })
  .strict()
  .superRefine((sequence, ctx) => {
    if (
      new Set(sequence.steps.map((step) => step.id)).size !==
      sequence.steps.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Sequence step IDs must be unique",
      });
  });
export type PresentationStep = z.infer<typeof PresentationStepSchema>;
export type PresentationSequence = z.infer<typeof PresentationSequenceSchema>;
export type LessonContext = z.infer<typeof LessonContextSchema>;
export * from "./presentation.js";
/** Which model produced an action. Shown to the presenter; never contains credentials. */
export const ModelTierSchema = z.enum(["fast", "core", "reasoning"]);
export const ServedBySchema = z
  .object({
    provider: z.enum(["nebius-token-factory", "local-rules"]),
    /** Model that produced the final action, when a model did. */
    model: z.string().max(200).optional(),
    tier: ModelTierSchema.optional(),
    /** Nemotron intent decision that preceded grounding, when the router ran. */
    router: z
      .object({
        model: z.string().max(200),
        tier: ModelTierSchema,
        intent: z.string().max(40),
        latencyMs: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    /** Deterministic grounding tool that produced the action after routing. */
    planner: z.string().max(100).optional(),
    latencyMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ModelTier = z.infer<typeof ModelTierSchema>;
export type ServedBy = z.infer<typeof ServedBySchema>;
export const VisualActionSchema = z
  .object({
    id,
    type: z.enum([
      "highlight",
      "point",
      "reveal",
      "animate",
      "clear",
      "add_node",
      "add_image",
      "navigate",
      "move",
      "add_illustration",
      "edit_object",
      "sequence",
      "undo",
    ]),
    sequence: PresentationSequenceSchema.optional(),
    color: AttentionColorSchema.optional(),
    durationMs: z.number().int().min(100).max(5000).optional(),
    /** `effects`: retract temporary emphasis only (speech revision); leaves running sequences alone. */
    scope: z.enum(["effects"]).optional(),
    animation: MotionPresetSchema.optional(),
    targetId: id.optional(),
    object: SceneObjectSchema.optional(),
    navigation: BoardNavigationSchema.optional(),
    patch: ObjectEditPatchSchema.optional(),
    dx: finite.min(-2400).max(2400).optional(),
    dy: finite.min(-2400).max(2400).optional(),
    objects: z.array(SceneObjectSchema).max(30).optional(),
    connections: z.array(SceneConnectionSchema).max(50).optional(),
    area: BoardAreaSchema.optional(),
    viewport: BoardViewportSchema.optional(),
    source: z.enum(["demo", "live"]).optional(),
    served: ServedBySchema.optional(),
    label: z.string().min(1).max(120).optional(),
    reason: z.string().max(1000),
    sceneId: id,
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type SceneObject = z.infer<typeof SceneObjectSchema>;
export type SceneConnection = z.infer<typeof SceneConnectionSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type VisualAction = z.infer<typeof VisualActionSchema>;
export type Effect = { action: VisualAction; startedAt: number };
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("scene"),
      scene: SceneSchema,
      revision: z.number().int().nonnegative(),
      cues: z.array(CueSchema).max(1000),
      sequenceId: id.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("cue"),
      text: z.string().min(1).max(4000),
      source: z.enum(["typed", "demo"]),
      mode: z.enum(["editing", "rehearsing", "presenting"]),
    })
    .strict(),
  z.object({ type: z.literal("listen"), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal("applied"), actionId: id }).strict(),
  z.object({ type: z.literal("animation.completed"), actionId: id }).strict(),
  z.object({ type: z.literal("animation.cancelled"), actionId: id }).strict(),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage =
  | { type: "ready"; mode: "demo" | "live" }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "state"; state: string; cueId?: string }
  | { type: "action"; action: VisualAction }
  | { type: "skipped"; reason: string; served?: ServedBy }
  | { type: "error"; message: string }
  | { type: "speech"; state: "listening" | "off" | "error" };
export function targetIds(scene: Scene): string[] {
  return scene.objects.flatMap((object) =>
    objectTargets(object).map((target) => target.id),
  );
}
export function hasTarget(scene: Scene, target: string): boolean {
  return targetIds(scene).includes(target);
}

export function createDemoProject(): Project {
  return {
    id: "default",
    title: "A story worth showing",
    updatedAt: new Date().toISOString(),
    scenes: [
      {
        id: "marketing",
        title: "Small changes. Extraordinary growth.",
        subtitle: "CAMPAIGN PERFORMANCE / Q3 2026",
        kind: "slide",
        connections: [],
        objects: [
          {
            id: "revenue",
            kind: "metric",
            label: "Revenue",
            value: "$3.2M",
            text: "+48% vs. last quarter",
            x: 70,
            y: 195,
            width: 295,
            height: 165,
            color: "#165c46",
            aliases: ["revenue", "three point two million", "sales"],
          },
          {
            id: "acquisition",
            kind: "metric",
            label: "Acquisition cost",
            value: "$42",
            text: "↓ 28% more efficient",
            x: 415,
            y: 195,
            width: 295,
            height: 165,
            color: "#165c46",
            aliases: [
              "acquisition cost",
              "forty two",
              "cost per customer",
              "CAC",
            ],
          },
          {
            id: "conversion",
            kind: "metric",
            label: "Conversion rate",
            value: "6.8%",
            text: "+2.1 pts this quarter",
            x: 760,
            y: 195,
            width: 335,
            height: 165,
            color: "#165c46",
            aliases: ["conversion", "conversion rate"],
          },
          {
            id: "channels",
            kind: "chart",
            label: "Where growth happened",
            data: [42, 68, 91, 57],
            labels: ["Search", "Social", "Partners", "Email"],
            x: 70,
            y: 390,
            width: 640,
            height: 220,
            color: "#478c70",
            aliases: [
              "channels",
              "channel performance",
              "growth chart",
              "chart",
            ],
          },
          {
            id: "takeaway",
            kind: "text",
            label: "The takeaway",
            text: "Better stories.\nStronger connections.\nSustainable growth.",
            x: 780,
            y: 405,
            width: 325,
            height: 170,
            color: "#24483d",
            aliases: ["takeaway", "conclusion"],
            hidden: true,
          },
        ],
      },
      {
        id: "mathematics",
        title: "See the structure behind the numbers.",
        subtitle: "LINEAR ALGEBRA / MATRIX MULTIPLICATION",
        kind: "math",
        connections: [],
        objects: [
          {
            id: "matrix-a",
            kind: "matrix",
            label: "Matrix A",
            value: "A",
            cells: [
              [1, 2],
              [3, 4],
            ],
            x: 95,
            y: 215,
            width: 340,
            height: 230,
            color: "#195b47",
            aliases: ["matrix a", "first matrix", "left matrix"],
          },
          {
            id: "matrix-b",
            kind: "matrix",
            label: "Matrix B",
            value: "B",
            cells: [
              [2, 0],
              [1, 2],
            ],
            x: 630,
            y: 215,
            width: 340,
            height: 230,
            color: "#b58b45",
            aliases: ["matrix b", "second matrix", "right matrix"],
          },
          {
            id: "multiply",
            kind: "text",
            label: "Multiply",
            text: "×",
            x: 505,
            y: 290,
            width: 90,
            height: 90,
            color: "#8b998f",
          },
          {
            id: "equation",
            kind: "text",
            label: "First cell derivation",
            text: "$c_{11} = 1 \\times 2 + 2 \\times 1 = 4$",
            x: 110,
            y: 475,
            width: 970,
            height: 90,
            color: "#195b47",
            hidden: true,
            aliases: [
              "derivation",
              "first cell derivation",
              "next step",
              "equation",
            ],
          },
          {
            id: "math-note",
            kind: "text",
            label: "Concept",
            text: "A row meets a column. Each pair tells part of the story.",
            x: 150,
            y: 575,
            width: 900,
            height: 40,
            color: "#75867c",
          },
        ],
      },
      {
        id: "architecture",
        title: "An idea becomes a system.",
        subtitle: "LIVE WHITEBOARD / REQUEST LIFECYCLE",
        kind: "architecture",
        objects: [
          {
            id: "client",
            kind: "node",
            label: "Web client",
            text: "React application",
            x: 80,
            y: 240,
            width: 210,
            height: 110,
            color: "#195b47",
            aliases: ["client", "browser", "frontend"],
          },
          {
            id: "api",
            kind: "node",
            label: "API gateway",
            text: "Validate · route · respond",
            x: 430,
            y: 240,
            width: 230,
            height: 110,
            color: "#195b47",
            aliases: ["api", "gateway", "server"],
          },
          {
            id: "database",
            kind: "node",
            label: "Database",
            text: "PostgreSQL",
            x: 820,
            y: 240,
            width: 230,
            height: 110,
            color: "#b58b45",
            aliases: ["database", "postgres", "storage"],
          },
        ],
        connections: [
          {
            id: "request",
            source: "client",
            target: "api",
            label: "HTTPS request",
          },
          { id: "query", source: "api", target: "database", label: "Query" },
        ],
      },
    ],
    cues: [
      {
        id: "cue-revenue",
        sceneId: "marketing",
        phrase: "revenue reached three point two million",
        targetId: "revenue",
        action: "point",
      },
      {
        id: "cue-takeaway",
        sceneId: "marketing",
        phrase: "show the takeaway",
        targetId: "takeaway",
        action: "reveal",
      },
      {
        id: "cue-equation",
        sceneId: "mathematics",
        phrase: "show the next step",
        targetId: "equation",
        action: "reveal",
      },
    ],
  };
}

/** Resolve attachment geometry from current chart bounds; persistent image identity stays unchanged. */
export function resolveImageAnchor(
  object: SceneObject,
  scene: Scene,
): SceneObject {
  if (object.kind !== "image" || object.anchor?.kind !== "x-axis")
    return object;
  const chart = scene.objects.find(
    (candidate) =>
      candidate.id === object.anchor!.targetId && candidate.kind === "chart",
  );
  if (!chart) return object;
  const plotHeight = Math.max(40, chart.height - 100);
  const baseline = chart.data?.some((value) => value < 0)
    ? plotHeight / 2
    : plotHeight;
  const axisY = chart.y + 44 + 22 + baseline;
  return {
    ...object,
    x: chart.x + chart.width / 2 - object.width / 2,
    y: axisY - object.height,
  };
}

export const BOARD_AREA_WIDTH = 1200;
export const BOARD_AREA_HEIGHT = 675;
export const BOARD_AREA_STEP_X = 1320;
export const BOARD_AREA_STEP_Y = 795;
export function getSceneViewport(scene: Scene): BoardViewport {
  return scene.viewport ?? { x: 0, y: 0, zoom: 1 };
}
const worldBound = (coordinate: number) =>
  Math.max(-1_000_000, Math.min(1_000_000, coordinate));
function uniqueBoardId(base: string, used: Set<string>): string {
  let candidate = base.slice(0, 105),
    index = 2;
  while (used.has(candidate)) candidate = `${base.slice(0, 105)}-${index++}`;
  used.add(candidate);
  return candidate;
}
function viewportArea(scene: Scene): BoardArea | undefined {
  const view = getSceneViewport(scene),
    cx = view.x + 600 / view.zoom,
    cy = view.y + 337.5 / view.zoom;
  const contains = (area: BoardArea) =>
    cx >= area.x &&
    cx <= area.x + area.width &&
    cy >= area.y &&
    cy <= area.y + area.height;
  return (
    scene.areas?.find(
      (area) => area.id === scene.activeAreaId && contains(area),
    ) ?? scene.areas?.find(contains)
  );
}
/** Camera navigation never changes object geometry or identity. */
export function applyBoardNavigation(
  scene: Scene,
  navigation: BoardNavigation,
): Scene {
  const nav = BoardNavigationSchema.parse(navigation);
  if (scene.layout !== "whiteboard") return scene;
  const view = getSceneViewport(scene),
    areas = [...(scene.areas ?? [])];
  if (nav.zoom) {
    const zoom =
      nav.zoom === "reset"
        ? 1
        : Math.max(
            0.25,
            Math.min(2, view.zoom * (nav.zoom === "in" ? 1.25 : 0.8)),
          );
    const viewport = {
      x: worldBound(view.x + 600 / view.zoom - 600 / zoom),
      y: worldBound(view.y + 337.5 / view.zoom - 337.5 / zoom),
      zoom,
    };
    return { ...scene, viewport };
  }
  if (nav.targetId) {
    const object = scene.objects.find(
      (object) =>
        object.id === nav.targetId ||
        targetIds({ ...scene, objects: [object] }).includes(nav.targetId!),
    );
    if (!object) return scene;
    const bounds = resolveImageAnchor(object, scene),
      viewport = {
        x: worldBound(bounds.x + bounds.width / 2 - 600 / view.zoom),
        y: worldBound(bounds.y + bounds.height / 2 - 337.5 / view.zoom),
        zoom: view.zoom,
      };
    const area = areas.find(
      (area) =>
        bounds.x + bounds.width / 2 >= area.x &&
        bounds.x + bounds.width / 2 <= area.x + area.width &&
        bounds.y + bounds.height / 2 >= area.y &&
        bounds.y + bounds.height / 2 <= area.y + area.height,
    );
    return { ...scene, viewport, activeAreaId: area?.id };
  }
  if (nav.areaId) {
    const area = areas.find((area) => area.id === nav.areaId);
    return area
      ? {
          ...scene,
          viewport: { x: area.x, y: area.y, zoom: 1 },
          activeAreaId: area.id,
        }
      : scene;
  }
  const current = viewportArea(scene),
    origin = current ?? { x: view.x, y: view.y };
  const x = worldBound(
    origin.x +
      (nav.direction === "right"
        ? BOARD_AREA_STEP_X
        : nav.direction === "left"
          ? -BOARD_AREA_STEP_X
          : 0),
  );
  const y = worldBound(
    origin.y +
      (nav.direction === "down"
        ? BOARD_AREA_STEP_Y
        : nav.direction === "up"
          ? -BOARD_AREA_STEP_Y
          : 0),
  );
  let area = areas.find(
    (area) => Math.abs(area.x - x) < 1 && Math.abs(area.y - y) < 1,
  );
  if (!area && areas.length >= 200)
    return { ...scene, activeAreaId: undefined, viewport: { x, y, zoom: 1 } };
  if (!area) {
    area = {
      id: uniqueBoardId("area", new Set(areas.map((area) => area.id))),
      label: `Area ${areas.length + 1}`,
      x,
      y,
      width: BOARD_AREA_WIDTH,
      height: BOARD_AREA_HEIGHT,
    };
    areas.push(area);
  }
  return SceneSchema.parse({
    ...scene,
    areas,
    activeAreaId: area.id,
    viewport: { x, y, zoom: 1 },
  });
}
/** Append one illustration into a free named region, preserving earlier material. */
export function appendIllustration(scene: Scene, generatedScene: Scene): Scene {
  if (scene.layout !== "whiteboard") return scene;
  if (scene.objects.length + generatedScene.objects.length > 300)
    throw new Error(
      "This board has reached its 300-object limit. Remove objects or start another board.",
    );
  if (scene.connections.length + generatedScene.connections.length > 500)
    throw new Error("This board has reached its connection limit.");
  const areas = [...(scene.areas ?? [])],
    view = getSceneViewport(scene),
    current = viewportArea(scene);
  let x = current?.x ?? view.x,
    y = current?.y ?? view.y;
  const occupied = (px: number, py: number) =>
    scene.objects.some(
      (object) =>
        object.x < px + 1200 &&
        object.x + object.width > px &&
        object.y < py + 675 &&
        object.y + object.height > py,
    );
  while (occupied(x, y)) {
    x += BOARD_AREA_STEP_X;
    if (x > 998000)
      throw new Error(
        "No space remains to the right of this area. Navigate to another part of the board.",
      );
  }
  let area = areas.find(
    (area) => Math.abs(area.x - x) < 1 && Math.abs(area.y - y) < 1,
  );
  const label =
    generatedScene.title.trim() || `Illustration ${areas.length + 1}`;
  const existingLabels = new Set(
    areas.filter((a) => a.id !== area?.id).map((a) => a.label),
  );
  let areaLabel = label,
    index = 2;
  while (existingLabels.has(areaLabel))
    areaLabel = `${label.slice(0, 290)} ${index++}`;
  if (area) {
    /* Preserve established names such as Start and user labels. */
  } else {
    if (areas.length >= 200)
      throw new Error(
        "This board has reached its 200 named-area limit. Visit an existing empty area or start another board.",
      );
    area = {
      id: uniqueBoardId("area", new Set(areas.map((a) => a.id))),
      label: areaLabel,
      x,
      y,
      width: 1200,
      height: 675,
    };
    areas.push(area);
  }
  const objectIds = new Set(scene.objects.map((object) => object.id)),
    ids = new Map(
      generatedScene.objects.map((object) => [
        object.id,
        uniqueBoardId(object.id, objectIds),
      ]),
    );
  const objects = generatedScene.objects.map((object) => ({
    ...object,
    id: ids.get(object.id)!,
    x: object.x + x,
    y: object.y + y,
    anchor: object.anchor
      ? {
          ...object.anchor,
          targetId: ids.get(object.anchor.targetId) ?? object.anchor.targetId,
        }
      : undefined,
  }));
  const connectionIds = new Set(
    scene.connections.map((connection) => connection.id),
  );
  const connections = generatedScene.connections.map((connection) => ({
    ...connection,
    id: uniqueBoardId(connection.id, connectionIds),
    source: ids.get(connection.source)!,
    target: ids.get(connection.target)!,
  }));
  return SceneSchema.parse({
    ...scene,
    objects: [...scene.objects, ...objects],
    connections: [...scene.connections, ...connections],
    areas,
    activeAreaId: area.id,
    viewport: { x, y, zoom: 1 },
  });
}

/** Validate and apply one typed edit atomically; callers retain the previous scene for undo. */
export function applyObjectEdit(
  scene: Scene,
  targetId: string,
  patch: ObjectEditPatch,
): Scene {
  const edit = ObjectEditPatchSchema.parse(patch),
    index = scene.objects.findIndex((object) => object.id === targetId);
  if (index < 0)
    throw new Error("The object to edit is no longer on this scene.");
  const previous = scene.objects[index]!;
  if (
    edit.text !== undefined &&
    !["text", "metric", "node"].includes(previous.kind)
  )
    throw new Error("This object does not have editable text.");
  if (edit.value !== undefined && previous.kind !== "metric")
    throw new Error(
      "Only a metric has a scalar display value; use a cell or chart value edit for structured data.",
    );
  if ((edit.matrix || edit.cell) && previous.kind !== "matrix")
    throw new Error("Matrix edits require a matrix object.");
  if (edit.chartDatum && previous.kind !== "chart")
    throw new Error("Chart value edits require a chart object.");
  const { matrix, cell, chartDatum, ...properties } = edit;
  const updated: SceneObject = { ...previous, ...properties };
  if (matrix) {
    const prior = previous.cells ?? [[0]],
      rows = matrix.rows ?? prior.length,
      cols = matrix.cols ?? prior[0]!.length;
    updated.cells = Array.from({ length: rows }, (_, row) =>
      Array.from({ length: cols }, (_, col) => prior[row]?.[col] ?? 0),
    );
  }
  if (cell) {
    const prior = updated.cells;
    if (!prior || cell.row >= prior.length || cell.col >= prior[0]!.length)
      throw new Error(
        "That matrix cell is outside the current rows and columns.",
      );
    updated.cells = prior.map((row, r) =>
      row.map((value, c) =>
        r === cell.row && c === cell.col ? cell.value : value,
      ),
    );
  }
  if (chartDatum) {
    if (!previous.data || chartDatum.index >= previous.data.length)
      throw new Error("That chart category does not exist.");
    updated.data = previous.data.map((value, index) =>
      index === chartDatum.index ? chartDatum.value : value,
    );
  }
  const objects = [...scene.objects];
  objects[index] = updated;
  return SceneSchema.parse(invalidateDerivedResults({ ...scene, objects }));
}
