import type { ComponentType } from "react";
import { getObjectPlugin, type SceneObject } from "@vizli/shared";
import {
  ChartRenderer,
  ImageRenderer,
  MetricRenderer,
  NodeRenderer,
  TextRenderer,
} from "./core";
import MatrixRenderer, { EquationRenderer } from "./math";
import AwsRenderer from "./aws";
import UmlRenderer from "./uml";
type Renderer = ComponentType<{ object: SceneObject }>;
/** Trusted, compiled-in domain modules; project JSON never supplies executable renderers. */
export const domainRenderers: Readonly<Record<string, Renderer>> = {
  "math.matrix": MatrixRenderer,
  "math.equation": EquationRenderer,
  "cloud.aws": AwsRenderer,
  "uml.class": UmlRenderer,
};
export const coreRenderers: Readonly<Record<SceneObject["kind"], Renderer>> = {
  text: TextRenderer,
  metric: MetricRenderer,
  chart: ChartRenderer,
  matrix: MatrixRenderer,
  image: ImageRenderer,
  node: NodeRenderer,
};
export default function ObjectRenderer({ object }: { object: SceneObject }) {
  const Renderer =
    domainRenderers[getObjectPlugin(object).id] ||
    coreRenderers[object.kind] ||
    TextRenderer;
  return <Renderer object={object} />;
}
