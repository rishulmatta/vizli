import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { readLegacyProject } from "./collab/useCollabDoc";
import { consumeEditLink, createProject } from "./collab/access";
import "./styles.css";

const PROJECT_PATH = /^\/p\/([a-zA-Z0-9_-]{1,120})\/?$/;
const VALID_ID = /^[a-zA-Z0-9_-]{1,120}$/;

/**
 * Routes: `/p/<id>` opens that shared project; an `#edit=<token>` fragment grants edit rights and is removed
 * from the address bar. `/` reopens the last local project (the `vizli.project.v1` mirror) or asks the server
 * for a new project whose edit token stays in this browser; `/p/default` (the read-only demo) if that fails.
 */
async function resolveProjectId(): Promise<string> {
  const match = PROJECT_PATH.exec(location.pathname);
  if (match) {
    consumeEditLink(match[1]!);
    return match[1]!;
  }
  const legacy = readLegacyProject();
  let id = legacy && VALID_ID.test(legacy.id) ? legacy.id : null;
  if (!id) id = (await createProject({ template: "demo" }))?.id ?? null;
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
