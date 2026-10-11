import { useLayoutEffect, useRef } from "react";
import type { SceneObject } from "@vizli/shared";
import MathText from "./MathText";
export default function MatrixRenderer({ object }: { object: SceneObject }) {
  const cells = object.cells ?? [
    [1, 2],
    [3, 4],
  ];
  const columns = Math.max(1, ...cells.map((row) => row.length));
  const rows = Math.max(1, cells.length);
  const digits = Math.max(
    1,
    ...cells
      .flat()
      .map((value) =>
        value === ""
          ? 1 + String(rows).length + String(columns).length
          : String(value).length,
      ),
  );
  const cellUnits = Math.max(1.3, digits * 0.65) + 0.66;
  // Keep every semantic cell inside the saved object bounds when dimensions change.
  // The title/symbol stay separate; dense matrices reduce cell type and spacing together.
  const availableWidth = Math.max(8, object.width - 60 - 80 - 4);
  const availableHeight = Math.max(8, object.height - 50 - 45);
  const fontSize = Math.max(
    1,
    Math.min(
      27,
      availableWidth /
        (columns * cellUnits + Math.max(0, columns - 1) * 0.44 + 1.1),
      availableHeight / (rows * 1.8 + 0.6),
    ),
  );
  const cellWidth = fontSize * cellUnits;
  const matrixWidth =
    columns * cellWidth + Math.max(0, columns - 1) * fontSize * 0.44;
  return (
    <div className="viz-matrix">
      <div className="viz-object-eyebrow">{object.label}</div>
      <div className="viz-matrix-equation">
        <span className="viz-matrix-name">
          <MathText
            text={
              object.value ||
              object.label.match(/(?:matrix\s+)?([A-Za-z])$/i)?.[1] ||
              "A"
            }
          />
          <span>=</span>
        </span>
        <div
          className="viz-matrix-brackets"
          style={{
            minWidth: 0,
            maxWidth: "none",
            flexShrink: 0,
            padding: `${fontSize * 0.3}px ${fontSize * 0.55}px`,
          }}
          role="table"
          aria-label={object.label}
        >
          <svg
            className="viz-matrix-outline"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path data-motion-stroke d="M8 1 H1 V99 H8" />
            <path data-motion-stroke d="M92 1 H99 V99 H92" />
          </svg>
          {cells.map((row, r) => (
            <div
              key={r}
              role="row"
              data-motion-group
              data-target-id={`${object.id}:row:${r}`}
              className="viz-matrix-row"
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                width: matrixWidth,
                gap: fontSize * 0.44,
              }}
            >
              {row.map((value, c) => (
                <span
                  key={c}
                  role="cell"
                  title={object.math?.expressions?.[r]?.[c]}
                  aria-label={
                    object.math?.expressions?.[r]?.[c]
                      ? `${String(value)} = ${object.math.expressions[r]![c]}`
                      : undefined
                  }
                  data-motion-item
                  data-target-id={`${object.id}:cell:${r}:${c}`}
                  data-target-groups={`${object.id}:col:${c}`}
                  className="viz-matrix-cell"
                  style={{
                    minWidth: 0,
                    height: fontSize * 1.2,
                    boxSizing: "content-box",
                    padding: `${fontSize * 0.3}px 0`,
                    fontSize,
                  }}
                >
                  {typeof value === "string" ? (
                    <MathText
                      text={value.replace(/^([A-Za-z])_?(\d+)$/, "$1_{$2}")}
                    />
                  ) : (
                    value
                  )}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
      {object.text && <div className="viz-matrix-note">{object.text}</div>}
    </div>
  );
}

export function EquationRenderer({ object }: { object: SceneObject }) {
  const content = useRef<HTMLSpanElement>(null);
  const text = object.text || object.value || object.label;
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    element.style.fontSize = "23px";
    const naturalWidth = element.scrollWidth;
    const availableWidth = Math.max(1, object.width - 32);
    element.style.fontSize = `${Math.min(23, naturalWidth > availableWidth ? (23 * availableWidth) / naturalWidth : 23)}px`;
  }, [text, object.width]);
  return (
    <div className="viz-equation" data-domain="math.equation">
      <div className="viz-object-eyebrow">{object.label}</div>
      <div className="viz-equation-body">
        <span
          ref={content}
          style={{ display: "inline-block", whiteSpace: "nowrap" }}
        >
          <MathText text={text} />
        </span>
      </div>
    </div>
  );
}
