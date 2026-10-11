import { z } from "zod";
import { getObjectPlugin } from "./plugins.js";
export const MotionPresetSchema = z.enum(["pulse", "draw", "flow"]);
export const pluginFields = {
  plugin: z
    .object({
      id: z.enum(["math.matrix", "math.equation", "cloud.aws", "uml.class"]),
      version: z.literal(1),
    })
    .strict()
    .optional(),
  motion: MotionPresetSchema.optional(),
  math: z
    .object({
      expressions: z
        .array(z.array(z.string().max(300)).min(1).max(30))
        .min(1)
        .max(30),
    })
    .strict()
    .optional(),
  aws: z
    .object({
      service: z.enum([
        "lambda",
        "s3",
        "apigateway",
        "dynamodb",
        "ec2",
        "route53",
        "alb",
        "rds",
      ]),
      region: z.string().min(1).max(80).optional(),
    })
    .strict()
    .optional(),
  uml: z
    .object({
      attributes: z.array(z.string().max(200)).max(20),
      methods: z.array(z.string().max(200)).max(20),
    })
    .strict()
    .optional(),
};
const pluginObjectContract = z.object({
  ...pluginFields,
  kind: z.enum(["text", "metric", "chart", "matrix", "image", "node"]),
  cells: z.array(z.array(z.union([z.number(), z.string()]))).optional(),
});
export function validatePluginObject(
  object: z.infer<typeof pluginObjectContract>,
  ctx: z.RefinementCtx,
): void {
  const plugin = getObjectPlugin(object);
  if (
    object.math &&
    (plugin.id !== "math.matrix" ||
      object.math.expressions.length !== object.cells?.length ||
      object.math.expressions.some(
        (row, index) => row.length !== object.cells?.[index]?.length,
      ))
  )
    ctx.addIssue({
      code: "custom",
      message: "Math expressions must match the matrix cell dimensions",
    });
  if (object.plugin && plugin.kind !== object.kind)
    ctx.addIssue({
      code: "custom",
      message: "Plugin does not support this object kind",
    });
  if ((object.plugin?.id === "cloud.aws") !== !!object.aws)
    ctx.addIssue({
      code: "custom",
      message: "AWS plugin requires its service payload",
    });
  if ((object.plugin?.id === "uml.class") !== !!object.uml)
    ctx.addIssue({
      code: "custom",
      message: "UML plugin requires its class payload",
    });
  if (object.motion && !plugin.motions.includes(object.motion))
    ctx.addIssue({
      code: "custom",
      message: "Motion preset is not supported by this plugin",
    });
}
