import { useCallback, useEffect, useRef } from 'react';

export const CURSOR_INTERVAL_MS = 33; // 30 Hz

type Point = { x: number; y: number } | null;
/** Throttles cursor presence to 30 Hz with a trailing call so the last position always lands. `null` (pointer left) is sent immediately. */
export function useCursorPublisher(publish: (cursor: Point) => void) {
  const publishRef = useRef(publish); publishRef.current = publish;
  const last = useRef(0);
  const pending = useRef<Point | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback((point: Point) => {
    const flush = () => {
      timer.current = undefined;
      if (pending.current === undefined) return;
      const value = pending.current;
      pending.current = undefined;
      last.current = performance.now();
      publishRef.current(value);
    };
    pending.current = point;
    clearTimeout(timer.current); timer.current = undefined;
    const wait = point === null ? 0 : CURSOR_INTERVAL_MS - (performance.now() - last.current);
    if (wait <= 0) flush();
    else timer.current = setTimeout(flush, wait);
  }, []);
}
