import { useEffect, useState } from "react";
import type { SceneObject } from "@vizli/shared";
import MathText from "./MathText";
export function ImageRenderer({ object }: { object: SceneObject }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [object.src]);
  return (
    <div className={`viz-image-content ${object.anchor ? "is-anchored" : ""}`}>
      {object.src && !failed ? (
        <img
          src={object.src}
          alt={object.label}
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="viz-image-fallback">
          <span>▧</span>
          <strong>{object.label}</strong>
          <small>
            {failed
              ? "Image could not be loaded"
              : "Add an image URL in the inspector"}
          </small>
        </div>
      )}
      {object.src && !failed && !object.anchor && (
        <div className="viz-image-caption">{object.label}</div>
      )}
    </div>
  );
}

export function ChartRenderer({ object }: { object: SceneObject }) {
  const values = object.data ?? [];
  const max = Math.max(1, ...values.map(Math.abs));
  const plotHeight = Math.max(40, object.height - 100);
  const barSpace = Math.max(
    1,
    (object.width - 58) / Math.max(values.length, 1),
  );
  const hasNegative = values.some((v) => v < 0);
  const baseline = hasNegative ? plotHeight / 2 : plotHeight;
  const range = hasNegative ? plotHeight / 2 : plotHeight;
  return (
    <div className="viz-chart">
      <div className="viz-object-eyebrow">{object.label}</div>
      <svg
        className="viz-chart-svg"
        width="100%"
        height={Math.max(40, object.height - 44)}
        viewBox={`0 0 ${object.width} ${Math.max(40, object.height - 44)}`}
        role="img"
        aria-label={`${object.label}: ${values.map((v, i) => `${object.labels?.[i] ?? i + 1}: ${v}`).join(", ")}`}
      >
        {[0, 0.5, 1].map((t) => (
          <line
            key={t}
            x1="24"
            x2={object.width - 18}
            y1={22 + plotHeight * t}
            y2={22 + plotHeight * t}
            stroke="#dce4de"
            strokeDasharray="3 5"
          />
        ))}
        <line
          data-chart-axis={object.id}
          x1="24"
          x2={object.width - 18}
          y1={22 + baseline}
          y2={22 + baseline}
          stroke="#91a594"
          strokeWidth="1.25"
        />
        {values.map((value, i) => {
          const h = Math.max(2, (Math.abs(value) / max) * range);
          const x = 32 + i * barSpace;
          const y = 22 + baseline - (value >= 0 ? h : 0);
          return (
            <g key={i}>
              <rect
                data-target-id={`${object.id}:bar:${i}`}
                x={x}
                y={y}
                width={Math.max(3, barSpace * 0.59)}
                height={h}
                rx="5"
                fill={
                  object.color ||
                  (i === values.length - 1 ? "#264f40" : "#a6bdac")
                }
              />
              <text
                x={x + barSpace * 0.295}
                y={value >= 0 ? y - 9 : y + h + 17}
                textAnchor="middle"
                className="viz-chart-value"
              >
                {value.toLocaleString()}
              </text>
              <text
                x={x + barSpace * 0.295}
                y={plotHeight + 47}
                textAnchor="middle"
                className="viz-chart-label"
              >
                {object.labels?.[i] ?? `${i + 1}`}
              </text>
            </g>
          );
        })}
        {!values.length && (
          <text x="24" y="60" className="viz-chart-label">
            Add data to this chart
          </text>
        )}
      </svg>
    </div>
  );
}

export function MetricRenderer({ object }: { object: SceneObject }) {
  return (
    <div className="viz-metric">
      <div className="viz-object-eyebrow">{object.label}</div>
      <div className="viz-metric-value" style={{ color: object.color }}>
        {object.value ?? "—"}
      </div>
      {object.text && <div className="viz-metric-note">{object.text}</div>}
    </div>
  );
}
export function NodeRenderer({ object }: { object: SceneObject }) {
  return (
    <div className="viz-node-inline">
      <span className="viz-node-icon">◈</span>
      <strong>{object.label}</strong>
      <span>{object.text ?? object.value}</span>
    </div>
  );
}
export function TextRenderer({ object }: { object: SceneObject }) {
  return (
    <div
      className={`viz-text ${object.height < 75 ? "is-compact" : ""} ${/^[×+=→]$/.test(object.text ?? "") ? "is-symbol" : ""}`}
      style={{ color: object.color }}
    >
      {/^[×+=→]$/.test(object.text ?? "") || object.height < 75 ? (
        <span>{object.text || object.label}</span>
      ) : (object.text ?? "").startsWith("$") ||
        (object.text ?? "").includes("\\") ? (
        <MathText text={object.text!} />
      ) : (
        <>
          <div className="viz-text-title">{object.label}</div>
          {object.text && <div className="viz-text-body">{object.text}</div>}
        </>
      )}
    </div>
  );
}
