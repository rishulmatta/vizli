import { useEffect, useState } from "react";
import { SceneObjectSchema, type SceneObject } from "@vizli/shared";
export default function ObjectDataEditor({
  object,
  onApply,
}: {
  object: SceneObject;
  onApply: (patch: Partial<SceneObject>) => void;
}) {
  const [values, setValues] = useState(""),
    [labels, setLabels] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    setValues(
      object.kind === "matrix"
        ? (object.cells ?? []).map((r) => r.join(", ")).join("\n")
        : (object.data ?? []).join(", "),
    );
    setLabels((object.labels ?? []).join(", "));
    setError("");
  }, [object.id, object.cells, object.data, object.labels]);
  const apply = () => {
    const parse = (row: string) =>
      row.split(",").map((value) => {
        if (!value.trim()) throw new Error("Every value must be a number.");
        const n = Number(value.trim());
        if (!Number.isFinite(n)) throw new Error("Use finite numbers only.");
        return n;
      });
    try {
      if (object.kind === "matrix") {
        const cells = values
          .trim()
          .split("\n")
          .map((row) =>
            row.split(",").map((value) => {
              const text = value.trim();
              if (!text || text.length > 300)
                throw new Error(
                  "Use a number or symbol in every cell, up to 300 characters each.",
                );
              const number = Number(text);
              if (Number.isFinite(number)) return number;
              if (
                /^[+-]?(?:Infinity|NaN)$/i.test(text) ||
                /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)
              )
                throw new Error(
                  "Numeric cells must be finite. Symbols and math expressions are also supported.",
                );
              return text;
            }),
          );
        if (
          cells.length > 30 ||
          cells[0].length > 30 ||
          cells.some((row) => row.length !== cells[0].length)
        )
          throw new Error("Use equal-length rows, up to 30 × 30.");
        const parsed = SceneObjectSchema.safeParse({ ...object, cells });
        if (!parsed.success)
          throw new Error(
            "Use rectangular matrix rows with valid numbers or bounded symbolic expressions.",
          );
        onApply({ cells: parsed.data.cells });
      } else {
        const data = parse(values);
        const names = labels.split(",").map((s) => s.trim());
        if (
          data.length > 200 ||
          names.length !== data.length ||
          names.some((s) => !s || s.length > 200)
        )
          throw new Error(
            "Give each value a matching label (up to 200 values).",
          );
        onApply({ data, labels: names });
      }
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid data.");
    }
  };
  return (
    <div className="data-editor">
      <label>
        {object.kind === "matrix" ? "Matrix values" : "Chart values"}
        <small>
          {object.kind === "matrix"
            ? "Numbers or symbols; one row per line, comma-separated cells."
            : "Separate values with commas."}
        </small>
        <textarea
          data-testid={
            object.kind === "matrix" ? "matrix-values" : "chart-values"
          }
          value={values}
          onChange={(e) => setValues(e.target.value)}
        />
      </label>
      {object.kind === "chart" && (
        <label>
          Chart labels
          <input
            data-testid="chart-labels"
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
          />
        </label>
      )}
      {error && (
        <p className="data-error" role="alert">
          {error}
        </p>
      )}
      <button className="button" data-testid="apply-data" onClick={apply}>
        Apply data
      </button>
    </div>
  );
}
