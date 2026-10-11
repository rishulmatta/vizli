import { useEffect, useState } from "react";
import {
  getObjectPlugin,
  SceneObjectSchema,
  objectTargets,
  type SceneObject,
} from "@vizli/shared";
import { Play, MousePointer2 } from "lucide-react";

type Props = {
  object: SceneObject;
  onApply: (patch: Partial<SceneObject>) => void;
  onCue: (cue: string) => void;
};
export default function PluginInspector({ object, onApply, onCue }: Props) {
  const plugin = getObjectPlugin(object);
  const motions = plugin.motions;
  const targets = objectTargets(object);
  const [target, setTarget] = useState(object.id),
    [attributes, setAttributes] = useState(""),
    [methods, setMethods] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    setTarget(object.id);
    setAttributes(object.uml?.attributes.join("\n") ?? "");
    setMethods(object.uml?.methods.join("\n") ?? "");
    setError("");
  }, [object.id, object.uml]);
  useEffect(() => {
    if (!targets.some((t) => t.id === target)) setTarget(object.id);
  }, [targets, target, object.id]);
  const applyClass = () => {
    const attrs = attributes
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      meths = methods
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    if (
      attrs.length > 20 ||
      meths.length > 20 ||
      [...attrs, ...meths].some((value) => value.length > 200)
    ) {
      setError(
        "Use up to 20 attributes and methods, each at most 200 characters.",
      );
      return;
    }
    const patch = { uml: { attributes: attrs, methods: meths } };
    if (!SceneObjectSchema.safeParse({ ...object, ...patch }).success) {
      setError(
        "These class details are not valid. Check the values and try again.",
      );
      return;
    }
    onApply(patch);
    setError("");
  };
  return (
    <div className="plugin-inspector">
      {plugin && (
        <div className="section-label">
          {plugin.label}
          <span>v{plugin.version}</span>
        </div>
      )}
      {object.aws && (
        <details className="plugin-data">
          <summary>AWS component</summary>
          <label>
            Service
            <select
              data-testid="aws-service"
              value={object.aws.service}
              onChange={(e) =>
                onApply({
                  aws: {
                    ...object.aws!,
                    service: e.target.value as NonNullable<
                      SceneObject["aws"]
                    >["service"],
                  },
                })
              }
            >
              <option value="lambda">Lambda</option>
              <option value="s3">S3</option>
              <option value="apigateway">API Gateway</option>
              <option value="dynamodb">DynamoDB</option>
              <option value="ec2">EC2</option>
            </select>
          </label>
          <label>
            Region
            <input
              aria-label="AWS region"
              value={object.aws.region ?? ""}
              maxLength={80}
              onChange={(e) =>
                onApply({
                  aws: {
                    ...object.aws!,
                    region: e.target.value.trim() || undefined,
                  },
                })
              }
            />
          </label>
        </details>
      )}
      {object.uml && (
        <details className="plugin-data">
          <summary>Class attributes & methods</summary>
          <label>
            Attributes
            <textarea
              data-testid="uml-attributes"
              value={attributes}
              onChange={(e) => setAttributes(e.target.value)}
            />
          </label>
          <label>
            Methods
            <textarea
              data-testid="uml-methods"
              value={methods}
              onChange={(e) => setMethods(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="data-error">
              {error}
            </p>
          )}
          <button
            className="button"
            data-testid="apply-uml"
            onClick={applyClass}
          >
            Apply class details
          </button>
        </details>
      )}
      <div className="field-row motion-row">
        <label>
          Motion preset
          <select
            aria-label="Motion preset"
            data-testid="motion-preset"
            value={object.motion ?? "pulse"}
            onChange={(e) =>
              onApply({ motion: e.target.value as SceneObject["motion"] })
            }
          >
            {motions.map((motion) => (
              <option key={motion} value={motion}>
                {motion === "pulse"
                  ? "Emphasize"
                  : motion === "draw"
                    ? "Draw / write on"
                    : "Trace flow"}
              </option>
            ))}
          </select>
        </label>
        <button
          className="icon-button"
          data-testid="preview-motion"
          aria-label="Preview motion"
          title="Preview motion"
          onClick={() => onCue(`Animate ${object.id}`)}
        >
          <Play size={15} />
        </button>
      </div>
      {targets.length > 1 && (
        <div className="field-row part-row">
          <label>
            Target part
            <select
              aria-label="Target part"
              data-testid="object-part"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {targets.map((part) => (
                <option key={part.id} value={part.id}>
                  {part.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="icon-button"
            data-testid="highlight-part"
            aria-label="Highlight selected part"
            title="Highlight selected part"
            onClick={() => onCue(`Highlight ${target}`)}
          >
            <MousePointer2 size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
