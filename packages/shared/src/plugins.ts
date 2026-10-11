import type { SceneObject } from "./index.js";
export const MOTION_PRESETS = {
  pulse: { label: "Pulse", durationMs: 900 },
  draw: { label: "Draw outline", durationMs: 1400 },
  flow: { label: "Flow", durationMs: 1800 },
} as const;
export type MotionPreset = keyof typeof MOTION_PRESETS;
export type PluginId =
  | "math.matrix"
  | "math.equation"
  | "cloud.aws"
  | "uml.class";
export const BUILTIN_PLUGINS = [
  {
    id: "math.matrix",
    version: 1,
    label: "Matrix",
    domain: "math",
    kind: "matrix",
    motions: ["pulse", "draw"],
  },
  {
    id: "math.equation",
    version: 1,
    label: "Equation",
    domain: "math",
    kind: "text",
    motions: ["pulse", "draw"],
  },
  {
    id: "cloud.aws",
    version: 1,
    label: "AWS service",
    domain: "aws",
    kind: "node",
    motions: ["pulse", "draw", "flow"],
  },
  {
    id: "uml.class",
    version: 1,
    label: "UML class",
    domain: "uml",
    kind: "node",
    motions: ["pulse", "draw", "flow"],
  },
] as const;
export function getObjectPlugin(object: Pick<SceneObject, "kind" | "plugin">): {
  id: string;
  version: 1;
  label: string;
  domain: string;
  kind: SceneObject["kind"];
  motions: readonly MotionPreset[];
} {
  const explicit = BUILTIN_PLUGINS.find(
    (plugin) => plugin.id === object.plugin?.id,
  );
  if (explicit) return explicit;
  if (object.kind === "matrix") return BUILTIN_PLUGINS[0];
  return {
    id: `core.${object.kind}`,
    version: 1,
    label: object.kind,
    domain: "core",
    kind: object.kind,
    motions:
      object.kind === "node" ? ["pulse", "draw", "flow"] : ["pulse", "draw"],
  };
}
export type SemanticTarget = {
  id: string;
  label: string;
  kind:
    | "object"
    | "row"
    | "column"
    | "cell"
    | "bar"
    | "part"
    | "attribute"
    | "method";
};
const part = (
  object: SceneObject,
  suffix: string,
  label: string,
  kind: SemanticTarget["kind"] = "part",
): SemanticTarget => ({ id: `${object.id}:${suffix}`, label, kind });
const enumerators: Record<string, (object: SceneObject) => SemanticTarget[]> = {
  "math.matrix": (o) => [
    ...(o.cells?.[0] ?? []).map((_, i) =>
      part(o, `col:${i}`, `column ${i + 1}`, "column"),
    ),
    ...(o.cells ?? []).flatMap((row, i) => [
      part(o, `row:${i}`, `row ${i + 1}`, "row"),
      ...row.map((_, j) =>
        part(o, `cell:${i}:${j}`, `cell ${i + 1} ${j + 1}`, "cell"),
      ),
    ]),
  ],
  "core.chart": (o) =>
    (o.data ?? []).map((_, i) =>
      part(o, `bar:${i}`, o.labels?.[i] ?? `bar ${i + 1}`, "bar"),
    ),
  "cloud.aws": (o) => [
    part(o, "part:service", "service"),
    ...(o.aws?.region ? [part(o, "part:region", "region")] : []),
  ],
  "uml.class": (o) => [
    part(o, "part:title", "title"),
    part(o, "part:attributes", "attributes"),
    part(o, "part:methods", "methods"),
    ...(o.uml?.attributes ?? []).map((label, i) =>
      part(o, `attribute:${i}`, label, "attribute"),
    ),
    ...(o.uml?.methods ?? []).map((label, i) =>
      part(o, `method:${i}`, label, "method"),
    ),
  ],
};
export function objectTargets(object: SceneObject): SemanticTarget[] {
  return [
    { id: object.id, label: object.label, kind: "object" },
    ...(enumerators[getObjectPlugin(object).id]?.(object) ?? []),
  ];
}
export function createPluginObject(
  pluginId: PluginId,
  id: string,
  x: number,
  y: number,
): SceneObject {
  const common = {
    id,
    x,
    y,
    label: "",
    kind: "node" as const,
    width: 280,
    height: 210,
    plugin: { id: pluginId, version: 1 as const },
    motion: "pulse" as const,
  };
  switch (pluginId) {
    case "math.matrix":
      return {
        ...common,
        kind: "matrix",
        label: "Matrix C",
        value: "C",
        cells: [
          [1, 0],
          [0, 1],
        ],
        width: 300,
        height: 230,
      };
    case "math.equation":
      return {
        ...common,
        kind: "text",
        label: "Quadratic formula",
        text: "$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$",
        width: 500,
        height: 130,
      };
    case "cloud.aws":
      return {
        ...common,
        label: "Lambda function",
        aws: { service: "lambda", region: "us-east-1" },
        width: 280,
        height: 180,
      };
    case "uml.class":
      return {
        ...common,
        label: "Customer",
        uml: {
          attributes: ["+ id: string", "+ name: string"],
          methods: ["+ save(): void", "+ find(id): Customer"],
        },
        height: 240,
      };
  }
}
