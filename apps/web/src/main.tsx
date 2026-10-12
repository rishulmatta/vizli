import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { readLegacyProject } from "./collab/useCollabDoc";
import "./styles.css";

const PROJECT_PATH = /^\/p\/([a-zA-Z0-9_-]{1,120})\/?$/;
const VALID_ID = /^[a-zA-Z0-9_-]{1,120}$/;

/**
 * Routes: `/p/<id>` opens that shared project. `/` reopens the last local project (the
 * `vizli.project.v1` mirror) or asks the server for a new demo project; `/p/default` if that fails.
 */
async function resolveProjectId(): Promise<string> {
  const match = PROJECT_PATH.exec(location.pathname);
  if (match) return match[1]!;
  const legacy = readLegacyProject();
  let id = legacy && VALID_ID.test(legacy.id) ? legacy.id : null;
  if (!id) {
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template: "demo" }),
      });
      const body = response.ok ? ((await response.json()) as { id?: unknown }) : null;
      if (typeof body?.id === "string" && VALID_ID.test(body.id)) id = body.id;
    } catch {
      /* fall back below */
    }
  }
  id ??= "default";
  history.replaceState(null, "", `/p/${id}${location.search}${location.hash}`);
  return id;
}

const root = createRoot(document.getElementById("root")!);
void resolveProjectId().then((projectId) =>
  root.render(
    <React.StrictMode>
      <App projectId={projectId} />
    </React.StrictMode>,
  ),
);
