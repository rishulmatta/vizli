import { useEffect, useRef, useState } from "react";
import { ArrowRight, LoaderCircle, Sparkles, X } from "lucide-react";
import { SceneSchema, type Scene } from "@vizli/shared";

type Props = {
  onCreate: (scene: Scene) => void;
  whiteboard?: boolean;
  onNotice: (message: string) => void;
};

export default function CreateScene({ onCreate, onNotice, whiteboard=false }: Props) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<Scene["kind"]>("slide");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const controller = new AbortController();
    fetch("/api/status", { signal: controller.signal })
      .then((r) => r.json())
      .then((s) => setLive(!!s.modelConfigured))
      .catch(() => {});
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        request.current?.abort();
        setBusy(false);
        setOpen(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      controller.abort();
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  function close() {
    request.current?.abort();
    request.current = null;
    setOpen(false);
    setBusy(false);
  }
  async function generate() {
    if (busy || !prompt.trim()) return;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch("/api/scenes/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim(), kind }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error || "Could not prepare this scene. Try again.",
        );
      const scene = SceneSchema.parse(result.scene);
      if (controller.signal.aborted || request.current !== controller) return;
      onCreate(scene);
      onNotice(
        result.source === "demo"
          ? "Added an editable example template. Connect Nemotron to generate scenes from your ideas."
          : "Scene generated. Review its content before presenting.",
      );
      setOpen(false);
      setPrompt("");
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not create the scene.",
        );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <>
      <button
        className="button"
        data-testid="create-from-idea"
        onClick={() => {
          setOpen(true);
          setError("");
        }}
      >
        <Sparkles size={15} /> {whiteboard ? "Add an illustration" : "Create from an idea"}
      </button>
      {open && (
        <div className="modal-backdrop" onClick={close}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-scene-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close scene creator"
              onClick={close}
            >
              <X size={20} />
            </button>
            <span className="modal-symbol">
              <Sparkles size={25} />
            </span>
            <div className="eyebrow">A NEW WAY TO EXPLAIN</div>
            <h2 id="create-scene-title">
              Start with
              <br />
              <em>an idea.</em>
            </h2>
            {whiteboard && <p>This illustration will be added to the current whiteboard area. Existing objects stay in place.</p>}
            <p>
              {live
                ? "Describe what you want to explain. Vizli will prepare an editable scene for you to review and rehearse."
                : "Explore an editable example template. With Nemotron connected, Vizli can generate a scene from your description."}
            </p>
            <label>
              What are you explaining?
              <textarea
                ref={input}
                data-testid="scene-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Explain how a request travels from a browser to a database…"
                rows={4}
                maxLength={4000}
                style={{
                  width: "100%",
                  resize: "vertical",
                  marginTop: 8,
                  padding: 12,
                  border: "1px solid #dce4d6",
                  borderRadius: 8,
                  font: "inherit",
                  color: "inherit",
                }}
              />
            </label>
            <label>
              Scene type
              <select
                aria-label="Generated scene type"
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as Scene["kind"])
                }
                style={{
                  width: "100%",
                  margin: "8px 0 18px",
                  padding: 12,
                  border: "1px solid #dce4d6",
                  borderRadius: 8,
                  background: "#fff",
                  color: "inherit",
                }}
              >
                <option value="slide">Presentation & charts</option>
                <option value="math">Mathematics</option>
                <option value="architecture">Software architecture</option>
              </select>
            </label>
            {error && (
              <p role="alert" style={{ color: "#a74335" }}>
                {error}
              </p>
            )}
            <button
              className="button primary full"
              data-testid="generate-scene"
              disabled={busy || !prompt.trim()}
              onClick={() => void generate()}
            >
              {busy ? (
                <>
                  <LoaderCircle size={16} />
                  Preparing your scene…
                </>
              ) : (
                <>
                  {live ? "Generate scene" : "Try example template"}
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </section>
        </div>
      )}
    </>
  );
}
