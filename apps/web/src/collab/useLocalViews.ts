import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardViewport, Scene } from '@vizli/shared';

/** Per-user camera state for one scene. Never persisted into the shared project. */
export type SceneView = { viewport: BoardViewport; activeAreaId?: string };
// Stored form: `null` means "explicitly no active area" so the choice survives JSON round-trips.
type StoredView = { viewport?: BoardViewport; activeAreaId?: string | null };
const DEFAULT_VIEWPORT: BoardViewport = { x: 0, y: 0, zoom: 1 };
export const viewKey = (projectId: string) => `vizli.view.${projectId}`;

function load(projectId: string): Record<string, StoredView> {
  try {
    const parsed = JSON.parse(localStorage.getItem(viewKey(projectId)) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** Removes the camera fields from a scene; `view` falls back to defaults when the scene has none. */
export function splitView(scene: Scene): { view: SceneView; rest: Scene } {
  const { viewport, activeAreaId, ...rest } = scene;
  return { view: { viewport: viewport ?? DEFAULT_VIEWPORT, ...(activeAreaId ? { activeAreaId } : {}) }, rest: rest as Scene };
}

export const sameView = (a: SceneView, b: SceneView) =>
  a.viewport.x === b.viewport.x && a.viewport.y === b.viewport.y && a.viewport.zoom === b.viewport.zoom && a.activeAreaId === b.activeAreaId;

export function useLocalViews(projectId: string) {
  const [views, setViews] = useState<Record<string, StoredView>>(() => load(projectId));
  // The ref is updated synchronously so callers can read their own writes inside one event.
  const ref = useRef(views); ref.current = views;
  const loadedFor = useRef(projectId);
  useEffect(() => {
    if (loadedFor.current === projectId) return;
    loadedFor.current = projectId;
    ref.current = load(projectId); setViews(ref.current);
  }, [projectId]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (loadedFor.current !== projectId) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      try { localStorage.setItem(viewKey(projectId), JSON.stringify(views)); } catch { /* view state is best effort */ }
    }, 200);
    return () => clearTimeout(timer.current);
  }, [views, projectId]);
  const getView = useCallback((scene: Scene): SceneView => {
    const stored = ref.current[scene.id];
    const activeAreaId = stored && stored.activeAreaId !== undefined ? stored.activeAreaId ?? undefined : scene.activeAreaId;
    return { viewport: stored?.viewport ?? scene.viewport ?? DEFAULT_VIEWPORT, ...(activeAreaId ? { activeAreaId } : {}) };
  }, []);
  const hasView = useCallback((sceneId: string) => Boolean(ref.current[sceneId]), []);
  const setView = useCallback((sceneId: string, patch: Partial<SceneView>) => {
    const previous = ref.current[sceneId] ?? {};
    const next: StoredView = { ...previous };
    if (patch.viewport) next.viewport = patch.viewport;
    if ('activeAreaId' in patch) next.activeAreaId = patch.activeAreaId ?? null;
    ref.current = { ...ref.current, [sceneId]: next };
    setViews(ref.current);
  }, []);
  return { getView, setView, hasView, views };
}
