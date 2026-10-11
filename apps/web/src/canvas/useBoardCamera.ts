import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useMachine } from '@xstate/react';
import { createMachine } from 'xstate';
import type { Scene } from '@vizli/shared';

export type Camera = { x: number; y: number; zoom: number };
const limit = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export const navigationMachine = createMachine({
  id: 'whiteboardNavigation', initial: 'idle',
  states: {
    idle: { on: { PAN: 'panning', WHEEL: 'navigating' } },
    panning: { on: { END: 'idle', CANCEL: 'idle' } },
    navigating: { on: { WHEEL: 'navigating', PAN: 'panning', END: 'idle', CANCEL: 'idle' } },
  },
});
export function zoomAt(camera: Camera, zoom: number, x: number, y: number): Camera {
  const next = limit(zoom, .25, 2);
  return { x: limit(camera.x + x / camera.zoom - x / next, -1e6, 1e6), y: limit(camera.y + y / camera.zoom - y / next, -1e6, 1e6), zoom: next };
}
export function useBoardCamera(scene: Scene, scale: number, container: RefObject<HTMLDivElement | null>, onChange: (scene: Scene) => void, viewportHeight = 675, playback?: {paused: boolean; durationMs?: number}) {
  const playbackRef = useRef(playback); playbackRef.current = playback;
  const enabled = scene.layout === 'whiteboard';
  const [navigation, sendNavigation] = useMachine(navigationMachine);
  const [local, setLocal] = useState<Camera | null>(null);
  const [space, setSpace] = useState(false);
  const hovered = useRef(false);
  const sceneRef = useRef(scene); sceneRef.current = scene;
  const changeRef = useRef(onChange); changeRef.current = onChange;
  const camera = local ?? scene.viewport ?? { x: 0, y: 0, zoom: 1 };
  const cameraRef = useRef(camera);
  const previousScene = useRef(scene.id);
  const cameraFrame = useRef<number | undefined>(undefined);
  const hadPlayback = useRef(Boolean(playback));
  useLayoutEffect(() => {
    if (hadPlayback.current && !playback && cameraFrame.current !== undefined) {
      cancelAnimationFrame(cameraFrame.current); cameraFrame.current = undefined;
      cameraRef.current = sceneRef.current.viewport ?? {x:0,y:0,zoom:1}; setLocal(null);
    }
    hadPlayback.current = Boolean(playback);
  }, [Boolean(playback)]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gestureCleanup = useRef<(() => void) | null>(null);
  const update = (next: Camera) => { cameraRef.current = next; setLocal(next); };
  const commit = (next: Camera, sceneId: string) => {
    clearTimeout(timer.current); timer.current = undefined;
    if (sceneRef.current.id !== sceneId || sceneRef.current.layout !== 'whiteboard') return;
    const previous = sceneRef.current.viewport ?? { x: 0, y: 0, zoom: 1 };
    if (previous.x !== next.x || previous.y !== next.y || previous.zoom !== next.zoom) changeRef.current({ ...sceneRef.current, viewport: next });
    sendNavigation({ type: 'END' });
  };
  useLayoutEffect(() => {
    clearTimeout(timer.current); gestureCleanup.current?.();
    if (cameraFrame.current !== undefined) cancelAnimationFrame(cameraFrame.current);
    sendNavigation({ type: 'CANCEL' });
    const target = scene.viewport ?? { x: 0, y: 0, zoom: 1 };
    const start = cameraRef.current;
    const changedScene = previousScene.current !== scene.id;
    previousScene.current = scene.id;
    if (!enabled || changedScene || window.matchMedia('(prefers-reduced-motion: reduce)').matches || (start.x === target.x && start.y === target.y && start.zoom === target.zoom)) {
      cameraRef.current = target; setLocal(null); return;
    }
    update(start);
    let last = performance.now();
    let elapsed = 0;
    const duration = playbackRef.current?.durationMs ?? 420;
    const tick = (now: number) => {
      if (!playbackRef.current?.paused) elapsed += now - last;
      last = now;
      const progress = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      update({x: start.x + (target.x - start.x) * eased, y: start.y + (target.y - start.y) * eased, zoom: start.zoom + (target.zoom - start.zoom) * eased});
      if (progress < 1) cameraFrame.current = requestAnimationFrame(tick);
      else { cameraFrame.current = undefined; setLocal(null); }
    };
    cameraFrame.current = requestAnimationFrame(tick);
    return () => { if (cameraFrame.current !== undefined) cancelAnimationFrame(cameraFrame.current); };
  }, [scene.id, scene.viewport?.x, scene.viewport?.y, scene.viewport?.zoom, enabled]);
  useEffect(() => () => { clearTimeout(timer.current); gestureCleanup.current?.(); if (cameraFrame.current !== undefined) cancelAnimationFrame(cameraFrame.current); }, []);
  useEffect(() => {
    if (!enabled) { setSpace(false); return; }
    const el = container.current; if (!el) return;
    const enter = () => { hovered.current = true; };
    const leave = () => { hovered.current = false; };
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (event.code === 'Space' && (hovered.current || el.contains(target))) { event.preventDefault(); setSpace(event.type === 'keydown'); }
    };
    const release = (event: KeyboardEvent) => { if (event.code === 'Space') setSpace(false); };
    const blur = () => setSpace(false);
    el.addEventListener('pointerenter', enter); el.addEventListener('pointerleave', leave);
    window.addEventListener('keydown', keyboard); window.addEventListener('keyup', release); window.addEventListener('blur', blur);
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('button')) return;
      event.preventDefault();
      if (cameraFrame.current !== undefined) cancelAnimationFrame(cameraFrame.current);
      const prior = cameraRef.current;
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight : 1;
      const dx = event.deltaX * factor, dy = event.deltaY * factor;
      const rect = el.getBoundingClientRect();
      const next = event.ctrlKey || event.metaKey
        ? zoomAt(prior, prior.zoom * Math.exp(-dy * .002), (event.clientX - rect.left - el.clientLeft) / scale, (event.clientY - rect.top - el.clientTop) / scale)
        : { ...prior, x: limit(prior.x + dx / (scale * prior.zoom), -1e6, 1e6), y: limit(prior.y + dy / (scale * prior.zoom), -1e6, 1e6) };
      sendNavigation({ type: 'WHEEL' }); update(next);
      clearTimeout(timer.current); const id = sceneRef.current.id;
      timer.current = setTimeout(() => commit(cameraRef.current, id), 180);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => { el.removeEventListener('pointerenter', enter); el.removeEventListener('pointerleave', leave); el.removeEventListener('wheel', wheel); window.removeEventListener('keydown', keyboard); window.removeEventListener('keyup', release); window.removeEventListener('blur', blur); };
  }, [enabled, scale, viewportHeight]);
  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || !event.isPrimary || gestureCleanup.current || (event.button !== 0 && event.button !== 1)) return;
    event.preventDefault(); event.stopPropagation(); clearTimeout(timer.current);
    if (cameraFrame.current !== undefined) cancelAnimationFrame(cameraFrame.current);
    sendNavigation({ type: 'PAN' });
    const original = cameraRef.current, id = scene.id;
    const start = { x: event.clientX, y: event.clientY };
    const element = event.currentTarget; element.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      update({ ...original, x: limit(original.x - (e.clientX - start.x) / (scale * original.zoom), -1e6, 1e6), y: limit(original.y - (e.clientY - start.y) / (scale * original.zoom), -1e6, 1e6) });
    };
    const clean = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', end); element.removeEventListener('pointercancel', cancel); element.removeEventListener('lostpointercapture', cancel); window.removeEventListener('blur', cancel); if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId); gestureCleanup.current = null; };
    const end = (e: PointerEvent) => { if (e.pointerId !== event.pointerId) return; clean(); commit(cameraRef.current, id); };
    const cancel = (e: Event) => { if ('pointerId' in e && e.pointerId !== event.pointerId) return; clean(); update(original); sendNavigation({ type: 'CANCEL' }); };
    gestureCleanup.current = clean;
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', end); element.addEventListener('pointercancel', cancel); element.addEventListener('lostpointercapture', cancel); window.addEventListener('blur', cancel);
  };
  const zoom = (factor: number) => { const next = zoomAt(cameraRef.current, cameraRef.current.zoom * factor, 600, viewportHeight / 2); update(next); commit(next, scene.id); };
  const reset = () => { const next = { x: 0, y: 0, zoom: 1 }; update(next); commit(next, scene.id); };
  return { camera, navigation: String(navigation.value), space, beginPan, zoom, reset };
}
