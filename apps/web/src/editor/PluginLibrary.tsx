import {
  BUILTIN_PLUGINS,
  createPluginObject,
  type SceneObject,
} from "@vizli/shared";
import { Boxes, Braces, Sigma } from "lucide-react";

type PluginId = Parameters<typeof createPluginObject>[0];
type AWSService = NonNullable<SceneObject["aws"]>["service"];
const services: { id: AWSService; label: string }[] = [
  { id: "lambda", label: "Lambda function" },
  { id: "s3", label: "S3 bucket" },
  { id: "apigateway", label: "API Gateway" },
  { id: "dynamodb", label: "DynamoDB table" },
  { id: "ec2", label: "EC2 instance" },
  { id: "route53", label: "Route 53 routing policy" },
  { id: "alb", label: "Application Load Balancer" },
  { id: "rds", label: "RDS database" },
];
export default function PluginLibrary({
  onAdd,
}: {
  onAdd: (id: PluginId, service?: AWSService) => void;
}) {
  return (
    <div className="plugin-library">
      <div className="plugin-library-heading">DOMAIN LIBRARY</div>
      {(["math", "cloud", "uml"] as const).map((domain) => {
        const plugins = BUILTIN_PLUGINS.filter((plugin) =>
          plugin.id.startsWith(`${domain}.`),
        );
        if (!plugins.length) return null;
        const Icon =
          domain === "math" ? Sigma : domain === "cloud" ? Boxes : Braces;
        return (
          <details key={domain}>
            <summary data-testid={`library-${domain}`}>
              <Icon size={14} />
              {domain === "math"
                ? "Mathematics"
                : domain === "cloud"
                  ? "AWS architecture"
                  : "UML diagrams"}
            </summary>
            {plugins.flatMap((plugin) =>
              plugin.id === "cloud.aws"
                ? services.map((service) => (
                    <button
                      key={service.id}
                      data-testid={`add-plugin-aws-${service.id}`}
                      onClick={() => onAdd(plugin.id, service.id)}
                    >
                      {service.label}
                    </button>
                  ))
                : [
                    <button
                      key={plugin.id}
                      data-testid={`add-plugin-${plugin.id.replace(".", "-")}`}
                      onClick={() => onAdd(plugin.id)}
                    >
                      {plugin.label}
                    </button>,
                  ],
            )}
          </details>
        );
      })}
    </div>
  );
}
