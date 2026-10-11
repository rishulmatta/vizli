import type { SceneObject } from "@vizli/shared";
const labels = {
  lambda: "Lambda",
  s3: "S3",
  apigateway: "API Gateway",
  dynamodb: "DynamoDB",
  ec2: "EC2",
};
const shapes = {
  lambda: <path d="M18 12h12l16 40H34L24 26 12 52H2l17-35z" />,
  s3: (
    <>
      <path d="M7 14h42l-5 38H12z" />
      <ellipse cx="28" cy="14" rx="21" ry="6" />
    </>
  ),
  apigateway: (
    <>
      <path d="M5 15h46v34H5z" />
      <path d="M16 25h24M16 37h24" stroke="white" strokeWidth="3" />
    </>
  ),
  dynamodb: (
    <>
      <ellipse cx="28" cy="14" rx="21" ry="8" />
      <path
        d="M7 14v32c0 11 42 11 42 0V14M7 28c0 11 42 11 42 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
      />
    </>
  ),
  ec2: (
    <>
      <path d="M12 12h32v32H12z" />
      <path
        d="M3 18h9M3 36h9M44 18h9M44 36h9M18 3v9M36 3v9M18 44v9M36 44v9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
      />
    </>
  ),
};
export default function AwsRenderer({ object }: { object: SceneObject }) {
  const service = object.aws?.service ?? "ec2";
  return (
    <div className="viz-aws-card" data-domain="cloud.aws">
      <div
        className="viz-aws-service"
        data-target-id={`${object.id}:part:service`}
        data-motion-item
      >
        <svg viewBox="0 0 56 60" aria-hidden="true" fill="currentColor">
          {shapes[service]}
        </svg>
        <span>AWS / {labels[service]}</span>
      </div>
      <strong>{object.label}</strong>
      <span className="viz-aws-description">
        {object.text || "Cloud service"}
      </span>
      <small
        data-target-id={
          object.aws?.region ? `${object.id}:part:region` : undefined
        }
        data-motion-item
      >
        {object.aws?.region || "Region not specified"}
      </small>
    </div>
  );
}
