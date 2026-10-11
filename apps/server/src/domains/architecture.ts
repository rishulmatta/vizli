import { createHash } from "node:crypto";
import {
  getSceneViewport,
  validatePresentationSequence,
  type PresentationSequence,
  type Scene,
  type SceneConnection,
  type SceneObject,
} from "@vizli/shared";
import type { DomainPlan, DomainPlanner } from "./types.js";

const domain = "architecture.aws-request-flow";
const idKey = (sceneId: string) =>
  createHash("sha256").update(sceneId).digest("hex").slice(0, 12);
const stageNames = [
  "client",
  "gateway",
  "route53",
  "alb",
  "compute",
  "postgres-cluster",
  "postgres-writer",
  "read-replicas",
  "routing-note",
] as const;
type Stage = (typeof stageNames)[number];
const stageId = (scene: Scene, stage: Stage) =>
  `aws-${idKey(scene.id)}-${stage}`;
const edgeId = (scene: Scene, from: Stage, to: Stage) =>
  `aws-edge-${idKey(scene.id)}-${from}-${to}`;
const objectFor = (scene: Scene, stage: Stage) =>
  scene.objects.find((object) => object.id === stageId(scene, stage));

const wordNumbers: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};
const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (word) => wordNumbers[word]!);

/** Used by the session queue to preserve finalized architecture clauses during playback. */
export function isArchitectureDomainCue(text: string): boolean {
  return /\b(client|api gateway|gateway|route\s*53|route53|geographic|geographical|nearest|latency|load balancer|\balb\b|auto\s*scal|autoscal|\bec2\b|postgres(?:ql)?|read replicas?|primary writer|regional api|request path|service path|\d+\s*(?:-|–|to|through|and)\s*\d+\s+(?:ec2\s+)?nodes?)\b/i.test(
    text,
  );
}

const layout: Record<Stage, { dx: number; dy: number; width: number; height: number }> = {
  client: { dx: 0, dy: 0, width: 150, height: 100 },
  gateway: { dx: 170, dy: 0, width: 160, height: 110 },
  route53: { dx: 170, dy: 165, width: 160, height: 130 },
  alb: { dx: 350, dy: 0, width: 170, height: 130 },
  compute: { dx: 530, dy: 0, width: 190, height: 130 },
  "postgres-cluster": { dx: 530, dy: 315, width: 350, height: 85 },
  "postgres-writer": { dx: 530, dy: 165, width: 170, height: 130 },
  "read-replicas": { dx: 710, dy: 165, width: 170, height: 130 },
  "routing-note": { dx: 0, dy: 315, width: 510, height: 85 },
};
const footprint = Object.values(layout);
function basePoint(scene: Scene): { x: number; y: number; dx: number; dy: number } | undefined {
  const existing = stageNames
    .map((stage) => ({ stage, object: objectFor(scene, stage) }))
    .find((entry) => entry.object);
  if (existing?.object) {
    const offset = layout[existing.stage];
    const x = existing.object.x - offset.dx;
    const y = existing.object.y - offset.dy;
    const conflicts = scene.objects.some((object) =>
      !stageNames.some((stage) => object.id === stageId(scene, stage)) &&
      footprint.some((box) =>
        x + box.dx < object.x + object.width &&
        x + box.dx + box.width > object.x &&
        y + box.dy < object.y + object.height &&
        y + box.dy + box.height > object.y,
      ),
    );
    if (conflicts) return undefined;
    if (scene.layout === "whiteboard") {
      const view = getSceneViewport(scene);
      const zoom = view.zoom;
      const safeLeft = 290;
      const safeRight = 1170;
      const safeTop = 115;
      const safeBottom = 580;
      const left = (x - view.x) * zoom;
      const top = (y - view.y) * zoom;
      const right = (x + 880 - view.x) * zoom;
      const bottom = (y + 400 - view.y) * zoom;
      const alreadyVisible =
        left >= safeLeft && right <= safeRight &&
        top >= safeTop && bottom <= safeBottom;
      if (!alreadyVisible) {
        // Existing flow geometry stays fixed; move only the camera so newly
        // inserted targets mount inside the unobstructed canvas area.
        const targetX = x - safeLeft / zoom;
        const targetTop = safeTop + (safeBottom - safeTop - 400 * zoom) / 2;
        const targetY = y - targetTop / zoom;
        const dx = targetX - view.x;
        const dy = targetY - view.y;
        if (Math.abs(dx) > 2400 || Math.abs(dy) > 2400) return undefined;
        return { x, y, dx, dy };
      }
    }
    return {
      x,
      y,
      dx: 0,
      dy: 0,
    };
  }

  const view = getSceneViewport(scene);
  const maxX = 1_000_000 - 880;
  const whiteboard = scene.layout === "whiteboard";
  const zoom = view.zoom;
  const safeLeft = 290;
  const safeTop = 115;
  const safeBottom = 580;
  const flowHeight = 400;
  const x = whiteboard
    ? Math.min(view.x + safeLeft / zoom, maxX)
    : 160;
  const minY = whiteboard
    ? view.y + safeTop / zoom
    : 180;
  const maxY = whiteboard
    ? view.y + safeBottom / zoom - flowHeight
    : 675 - flowHeight;
  const preferredY = whiteboard
    ? view.y + ((safeTop + safeBottom) / 2 - flowHeight * zoom / 2) / zoom
    : minY;
  const candidates = whiteboard
    ? Array.from({ length: Math.max(1, Math.floor((maxY - minY) / 20) + 1) }, (_, index) =>
        Math.max(minY, Math.min(maxY, preferredY + (index === 0 ? 0 : (index % 2 ? 1 : -1) * Math.ceil(index / 2) * 20 / zoom))),
      )
    : Array.from({ length: Math.max(1, Math.floor((maxY - minY) / 20) + 1) }, (_, index) => minY + index * 20);
  for (const y of candidates) {
    const intersects = scene.objects.some((object) =>
      footprint.some((box) =>
        x + box.dx < object.x + object.width &&
        x + box.dx + box.width > object.x &&
        y + box.dy < object.y + object.height &&
        y + box.dy + box.height > object.y,
      ),
    );
    if (!intersects) {
      return { x, y, dx: 0, dy: 0 };
    }
  }
  return undefined;
}
function awsNode(
  scene: Scene,
  stage: Stage,
  service: "apigateway" | "route53" | "alb" | "ec2" | "rds",
  label: string,
  x: number,
  y: number,
  text?: string,
  width = 170,
): SceneObject {
  return {
    id: stageId(scene, stage),
    kind: "node",
    plugin: { id: "cloud.aws", version: 1 },
    aws: { service },
    aliases: [`aws-request-flow:${stage}`],
    label,
    ...(text ? { text } : {}),
    x,
    y,
    width,
    height: layout[stage].height,
    motion: "draw",
  };
}
function rangeFrom(text: string): [number, number] | undefined {
  const match = text.match(
    /\b(?:from\s+|between\s+)?(\d{1,2})\s*(?:-|–|to|through|and)\s*(\d{1,2})(?:\s+(?:ec2\s+)?(?:nodes?|instances?))?\b/,
  );
  if (!match) return undefined;
  const min = Number(match[1]),
    max = Number(match[2]);
  if (min < 1 || max < min || max > 100) return undefined;
  return [min, max];
}
function ranges(object: SceneObject): [number, number] | undefined {
  const match = object.label.match(/(\d+)–(\d+) nodes?/);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}
function replicaCountFrom(text: string): number | undefined {
  const match = text.match(/\b(\d{1,2})\s+(?:read\s+)?replicas?\b/);
  if (!match) return undefined;
  const count = Number(match[1]);
  return count >= 2 && count <= 50 ? count : undefined;
}
function isExpectedStageObject(object: SceneObject, stage: Stage): boolean {
  switch (stage) {
    case "client":
      return object.kind === "node" && !object.plugin && (object.aliases ?? []).includes("aws-request-flow:client");
    case "gateway":
      return object.plugin?.id === "cloud.aws" && object.aws?.service === "apigateway" && (object.aliases ?? []).includes("aws-request-flow:gateway");
    case "route53":
      return object.plugin?.id === "cloud.aws" && object.aws?.service === "route53" && (object.aliases ?? []).includes("aws-request-flow:route53");
    case "alb":
      return object.plugin?.id === "cloud.aws" && object.aws?.service === "alb" && (object.aliases ?? []).includes("aws-request-flow:alb");
    case "compute":
      return object.plugin?.id === "cloud.aws" && object.aws?.service === "ec2" && (object.aliases ?? []).includes("aws-request-flow:compute");
    case "postgres-cluster":
      return object.kind === "text" && (object.aliases ?? []).includes("aws-request-flow:postgres-cluster");
    case "postgres-writer":
      return object.plugin?.id === "cloud.aws" && object.aws?.service === "rds" && (object.aliases ?? []).includes("aws-request-flow:postgres-writer");
    case "read-replicas":
      return object.plugin?.id === "cloud.aws" && object.aws?.service === "rds" && (object.aliases ?? []).includes("aws-request-flow:read-replicas");
    case "routing-note":
      return object.kind === "text" && (object.aliases ?? []).includes("aws-request-flow:routing-note");
  }
}

export const awsRequestFlowPlanner: DomainPlanner = {
  id: domain,
  plan(text, scene): DomainPlan | undefined {
    const n = normalize(text);
    if (!isArchitectureDomainCue(text)) return undefined;
    if (/\b(maybe|perhaps|might|could|not|never|dont|do not|what if)\b/.test(n))
      return undefined;

    const hasArchitectureContext = stageNames.some((stage) => objectFor(scene, stage));
    const mentionsClient =
      /\b(client|user|consumer|caller|frontend|front end)\b/.test(n) &&
      /\b(call|calls|invoke|invokes|request|requests|talk|talks|send|sends|hit|hits)\b/.test(n);
    const mentionsGateway = /\bapi\s*gateway\b/.test(n);
    const mentionsRouting =
      /\b(route\s*53|route53|geographic(?:al)?|nearest|latency(?:-based)?|region(?:al)? routing)\b/.test(n);
    const mentionsAlb =
      /\b(application load balancer|load balancer|\balb\b)\b/.test(n);
    const explicitRange = rangeFrom(n);
    const mentionsCompute =
      /\b(ec2|auto\s*scal(?:e|ing|ed)|autoscal(?:e|ing|ed)|elastic(?:ally)?\s+(?:scale|scal(?:e|ing))|\d+\s*(?:-|–|to|through|and)\s*\d+\s+(?:ec2\s+)?nodes?)\b/.test(n) ||
      (!!objectFor(scene, "compute") && !!explicitRange);
    const mentionsPostgres = /\b(postgres(?:ql)?|rds\s+postgres)\b/.test(n);
    const mentionsWriter = /\b(primary\s+writer|writer|write\s+primary|primary\s+write)\b/.test(n);
    const mentionsReplicas = /\b(read\s+replicas?|replicas?)\b/.test(n);
    const replicaCount = replicaCountFrom(n);

    const wanted = new Set<Stage>();
    if (mentionsClient) wanted.add("client");
    if (mentionsGateway) wanted.add("gateway");
    if (mentionsRouting) wanted.add("route53");
    if (mentionsAlb) wanted.add("alb");
    if (mentionsCompute) wanted.add("compute");
    if (mentionsPostgres || mentionsWriter || mentionsReplicas)
      wanted.add("postgres-cluster");
    if (mentionsWriter) wanted.add("postgres-writer");
    if (mentionsReplicas) wanted.add("read-replicas");
    if (mentionsRouting) wanted.add("routing-note");
    if (hasArchitectureContext && /\b(api|request path|service path)\b/.test(n)) {
      if (mentionsClient) wanted.add("gateway");
    }
    if (wanted.size === 0) return undefined;

    if (scene.layout === "whiteboard") {
      const view = getSceneViewport(scene);
      if (view.zoom * 880 > 910)
        return {
          type: "skip",
          reason: "Zoom out to about 100% so the complete architecture flow fits beside the whiteboard controls.",
        };
    }

    const base = basePoint(scene);
    if (!base)
      return {
        type: "skip",
        reason:
          scene.layout === "whiteboard"
            ? "There is no clear space for this architecture flow near the current camera. Move to a clear area, then continue."
            : "There is no clear space for this complete architecture flow on the current slide. Switch to a whiteboard or clear an area, then continue.",
      };
    const positions: Record<Stage, { x: number; y: number }> = {
      client: { x: base.x + layout.client.dx, y: base.y + layout.client.dy },
      gateway: { x: base.x + layout.gateway.dx, y: base.y + layout.gateway.dy },
      route53: { x: base.x + layout.route53.dx, y: base.y + layout.route53.dy },
      alb: { x: base.x + layout.alb.dx, y: base.y + layout.alb.dy },
      compute: { x: base.x + layout.compute.dx, y: base.y + layout.compute.dy },
      "postgres-cluster": { x: base.x + layout["postgres-cluster"].dx, y: base.y + layout["postgres-cluster"].dy },
      "postgres-writer": { x: base.x + layout["postgres-writer"].dx, y: base.y + layout["postgres-writer"].dy },
      "read-replicas": { x: base.x + layout["read-replicas"].dx, y: base.y + layout["read-replicas"].dy },
      "routing-note": { x: base.x + layout["routing-note"].dx, y: base.y + layout["routing-note"].dy },
    };
    const newObjects: SceneObject[] = [];
    const updates: SceneObject[] = [];
    const key = idKey(scene.id);
    const clientId = stageId(scene, "client");
    const client: SceneObject = {
      id: clientId,
      kind: "node",
      label: "Client",
      text: "Generic API client",
      x: positions.client.x,
      y: positions.client.y,
      width: 180,
      height: layout.client.height,
      color: "#2563eb",
      aliases: ["client", "aws-request-flow:client"],
    };
    client.width = layout.client.width;
    const gateway = awsNode(scene, "gateway", "apigateway", "API Gateway", positions.gateway.x, positions.gateway.y, "Regional API entry point", layout.gateway.width);
    const route53 = awsNode(scene, "route53", "route53", "Route 53", positions.route53.x, positions.route53.y, "Latency and geographic DNS routing", layout.route53.width);
    const alb = awsNode(scene, "alb", "alb", "Regional ALB", positions.alb.x, positions.alb.y, "Distributes requests to regional compute.", layout.alb.width);
    const range = explicitRange ?? [5, 12];
    const compute = awsNode(scene, "compute", "ec2", `${range[0]}–${range[1]} nodes`, positions.compute.x, positions.compute.y, "Regional API · Auto Scaling", layout.compute.width);
    const cluster: SceneObject = {
      id: stageId(scene, "postgres-cluster"),
      kind: "text",
      label: "PostgreSQL cluster",
      text: "Writes: primary. Reads: replicas.",
      aliases: ["aws-request-flow:postgres-cluster"],
      x: positions["postgres-cluster"].x,
      y: positions["postgres-cluster"].y,
      width: layout["postgres-cluster"].width,
      height: layout["postgres-cluster"].height,
    };
    const writer = awsNode(scene, "postgres-writer", "rds", "PostgreSQL primary writer", positions["postgres-writer"].x, positions["postgres-writer"].y, "RDS PostgreSQL write primary", layout["postgres-writer"].width);
    const replicas = awsNode(scene, "read-replicas", "rds", replicaCount ? `Read replicas · ${replicaCount}` : "Read replicas · multiple", positions["read-replicas"].x, positions["read-replicas"].y, replicaCount ? `RDS PostgreSQL · ${replicaCount} instances` : "RDS PostgreSQL · count unspecified", layout["read-replicas"].width);
    const note: SceneObject = {
      id: stageId(scene, "routing-note"),
      kind: "text",
      label: "Latency/geographic DNS",
      text: "DNS is best effort; nearest region is not guaranteed.",
      aliases: ["aws-request-flow:routing-note"],
      x: positions["routing-note"].x,
      y: positions["routing-note"].y,
      width: layout["routing-note"].width,
      height: layout["routing-note"].height,
    };
    const objectsByStage: Record<Stage, SceneObject> = {
      client,
      gateway,
      route53,
      alb,
      compute,
      "postgres-cluster": cluster,
      "postgres-writer": writer,
      "read-replicas": replicas,
      "routing-note": note,
    };
    for (const stage of wanted) {
      const desired = objectsByStage[stage];
      const existing = objectFor(scene, stage);
      if (!existing) newObjects.push(desired);
      else if (!isExpectedStageObject(existing, stage))
        return {
          type: "skip",
          reason: "A user object already uses an architecture stage ID. Rename or remove it before continuing.",
        };
      else if (stage === "compute" && (mentionsCompute || explicitRange)) {
        const oldRange = ranges(existing);
        if (!oldRange || oldRange[0] !== range[0] || oldRange[1] !== range[1])
          updates.push({ ...existing, label: desired.label, text: desired.text });
      } else if (stage === "read-replicas" && replicaCount !== undefined) {
        if (!existing.label.endsWith(`· ${replicaCount}`))
          updates.push({ ...existing, label: desired.label, text: desired.text });
      }
    }

    const edgePairs: [Stage, Stage][] = [
      ["client", "gateway"],
      ["route53", "gateway"],
      ["gateway", "alb"],
      ["alb", "compute"],
      ["compute", "postgres-writer"],
      ["compute", "read-replicas"],
      ["postgres-writer", "read-replicas"],
    ];
    const allIds = new Set([
      ...scene.objects.map((object) => object.id),
      ...newObjects.map((object) => object.id),
    ]);
    const newConnections: SceneConnection[] = [];
    for (const [from, to] of edgePairs) {
      const source = stageId(scene, from), target = stageId(scene, to);
      if (!allIds.has(source) || !allIds.has(target)) continue;
      const id = edgeId(scene, from, to);
      const existing = scene.connections.find((connection) => connection.id === id);
      if (!existing) newConnections.push({ id, source, target });
      else if (existing.source !== source || existing.target !== target)
        return { type: "skip", reason: "An existing architecture connection conflicts with this request." };
    }
    if (!newObjects.length && !updates.length && !newConnections.length)
      return { type: "skip", reason: "That architecture stage is already in the diagram." };
    if (scene.objects.length + newObjects.length > 300)
      return { type: "skip", reason: "The scene object limit leaves no room for this architecture stage." };
    if (scene.connections.length + newConnections.length > 500)
      return { type: "skip", reason: "The scene connection limit leaves no room for this architecture stage." };

    const steps: PresentationSequence["steps"] = [];
    if (base.dx || base.dy)
      steps.push({ id: "camera", type: "camera", dx: base.dx, dy: base.dy, durationMs: 650 });
    if (newObjects.length || newConnections.length)
      steps.push({ id: "insert", type: "insert", objects: newObjects, connections: newConnections, entrance: "draw", durationMs: 900 });
    if (updates.length)
      steps.push({ id: "update", type: "update", objects: updates, entrance: "draw", durationMs: 700 });
    const sequence: PresentationSequence = {
      id: `aws-flow-${key}-${createHash("sha256").update(n).digest("hex").slice(0, 10)}`,
      domain,
      steps,
    };
    try {
      return {
        type: "sequence",
        sequence: validatePresentationSequence(scene, sequence),
        reason: "Added the requested AWS architecture stage with stable editable objects and connections.",
      };
    } catch {
      return { type: "skip", reason: "That architecture stage conflicts with the current diagram." };
    }
  },
};

