import type { SceneObject } from "@vizli/shared";
import { useEffect, useState } from "react";

const services = {
  lambda: {
    label: "AWS Lambda",
    icon: "/aws-icons/lambda.svg",
  },
  s3: {
    label: "Amazon S3",
    icon: "/aws-icons/s3.svg",
  },
  apigateway: {
    label: "Amazon API Gateway",
    icon: "/aws-icons/api-gateway.svg",
  },
  dynamodb: {
    label: "Amazon DynamoDB",
    icon: "/aws-icons/dynamodb.svg",
  },
  ec2: {
    label: "Amazon EC2 instance",
    icon: "/aws-icons/ec2-instance.svg",
  },
  route53: {
    label: "Amazon Route 53",
    icon: "/aws-icons/route-53.svg",
  },
  alb: {
    label: "Application Load Balancer",
    icon: "/aws-icons/application-load-balancer.svg",
  },
  rds: {
    label: "Amazon RDS",
    icon: "/aws-icons/rds.svg",
  },
} as const;

function AwsIcon({ src, label }: { src: string; label: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed)
    return (
      <span
        className="viz-aws-icon-fallback"
        role="img"
        aria-label={`${label} icon unavailable`}
        data-aws-icon-error="true"
      >
        Icon unavailable
      </span>
    );
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      data-aws-icon={src}
      onError={() => setFailed(true)}
    />
  );
}

export default function AwsRenderer({ object }: { object: SceneObject }) {
  const service = object.aws?.service ?? "ec2";
  const isAutoScalingGroup =
    service === "ec2" &&
    /auto[- ]scaling(?:\s+group)?/iu.test(`${object.label} ${object.text ?? ""}`);
  const asset = isAutoScalingGroup
    ? {
        label: "Amazon EC2 Auto Scaling",
        icon: "/aws-icons/ec2-auto-scaling.svg",
      }
    : services[service] ?? services.ec2;
  return (
    <div
      className="viz-aws-card"
      data-domain="cloud.aws"
      data-aws-service={service}
      data-aws-capacity-range={
        /\b5\s*[–-]\s*12\b/u.test(`${object.label} ${object.text ?? ""}`)
          ? "5–12"
          : undefined
      }
      data-aws-replica-summary={
        /read replicas?/iu.test(`${object.label} ${object.text ?? ""}`)
          ? "multiple"
          : undefined
      }
    >
      <div
        className="viz-aws-service"
        data-target-id={`${object.id}:part:service`}
        data-motion-item
      >
        <AwsIcon src={asset.icon} label={asset.label} />
        <span>{asset.label}</span>
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
