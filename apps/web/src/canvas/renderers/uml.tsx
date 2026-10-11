import type { SceneObject } from "@vizli/shared";
export default function UmlRenderer({ object }: { object: SceneObject }) {
  const attributes = object.uml?.attributes ?? [],
    methods = object.uml?.methods ?? [];
  const rows = Math.max(1, attributes.length) + Math.max(1, methods.length);
  const fontSize = Math.max(
    6,
    Math.min(13, (object.height - 64) / (rows * 1.7)),
  );
  return (
    <div className="viz-uml-card" data-domain="uml.class">
      <div
        className="viz-uml-title"
        data-target-id={`${object.id}:part:title`}
        data-motion-item
      >
        <span>«class»</span>
        <strong>{object.label}</strong>
      </div>
      <div
        className="viz-uml-section"
        data-target-id={`${object.id}:part:attributes`}
        style={{ fontSize }}
        aria-label="Attributes"
      >
        {attributes.length ? (
          attributes.map((value, index) => (
            <div
              key={index}
              data-target-id={`${object.id}:attribute:${index}`}
              data-motion-item
            >
              {value}
            </div>
          ))
        ) : (
          <div className="viz-uml-empty">No attributes</div>
        )}
      </div>
      <div
        className="viz-uml-section"
        data-target-id={`${object.id}:part:methods`}
        style={{ fontSize }}
        aria-label="Methods"
      >
        {methods.length ? (
          methods.map((value, index) => (
            <div
              key={index}
              data-target-id={`${object.id}:method:${index}`}
              data-motion-item
            >
              {value}
            </div>
          ))
        ) : (
          <div className="viz-uml-empty">No methods</div>
        )}
      </div>
    </div>
  );
}
