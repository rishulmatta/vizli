import type { Project } from '@vizli/shared';

/**
 * Edit tokens (see docs/SECURITY.md). A project's edit token is a capability: it is kept per project in
 * `localStorage['vizli.edit.v1']`, sent as `join.token`, and shared through `#edit=<token>` links. The URL
 * fragment never reaches the server or its logs; it is stored and removed from the address bar on load.
 * Nothing here is authentication: whoever holds the token edits.
 */
const KEY = 'vizli.edit.v1';
const ID = /^[a-zA-Z0-9_-]{1,120}$/;
const MIN_TOKEN = 16;
type TokenMap = Record<string, string>;
/** Fallback when storage is unavailable (private browsing); tokens then last for the page lifetime. */
const memory: TokenMap = {};

function read(): TokenMap {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as TokenMap) : {};
  } catch {
    return {};
  }
}
function write(map: TokenMap) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* best effort; `memory` keeps the session working */
  }
}
export function getEditToken(projectId: string): string | undefined {
  const stored = read()[projectId] ?? memory[projectId];
  return typeof stored === 'string' && stored.length >= MIN_TOKEN ? stored : undefined;
}
export function setEditToken(projectId: string, token: string) {
  if (!ID.test(projectId) || token.length < MIN_TOKEN) return;
  memory[projectId] = token;
  write({ ...read(), [projectId]: token });
}
/** 24 random bytes as base64url, the same shape the server mints. */
export function newEditToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** The token this browser will use when it creates `projectId` (seeded joins mint their own). */
export function ensureEditToken(projectId: string): string {
  const existing = getEditToken(projectId);
  if (existing) return existing;
  const token = newEditToken();
  setEditToken(projectId, token);
  return token;
}
/** `#edit=<token>` on a project URL grants edit rights: keep it, then drop it from the address bar. */
export function consumeEditLink(projectId: string) {
  const match = /(?:^#|&)edit=([A-Za-z0-9_\-.~%]{16,2000})(?:&|$)/.exec(location.hash);
  if (!match) return;
  try {
    setEditToken(projectId, decodeURIComponent(match[1]!));
  } catch {
    return;
  }
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}
export const viewLink = (projectId: string) => `${location.origin}/p/${projectId}`;
/** Link that grants edit rights, or null when this browser is not an editor of the project. */
export function editLink(projectId: string): string | null {
  const token = getEditToken(projectId);
  return token ? `${viewLink(projectId)}#edit=${encodeURIComponent(token)}` : null;
}
/** Creates a project on the server and keeps its edit token; null when the server refused or is unreachable. */
export async function createProject(body: { project?: Project; template?: 'demo' }): Promise<{ id: string } | null> {
  try {
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    const created = (await response.json()) as { id?: unknown; editToken?: unknown };
    if (typeof created.id !== 'string' || !ID.test(created.id)) return null;
    if (typeof created.editToken === 'string') setEditToken(created.id, created.editToken);
    return { id: created.id };
  } catch {
    return null;
  }
}
/** An editable copy of `project` under a new id, owned by this browser; the caller navigates to it. */
export const forkProject = (project: Project) => createProject({ project });
