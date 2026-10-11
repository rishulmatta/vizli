import { Pause, Play, SkipForward, X } from "lucide-react";
import type { usePresentationPlayback } from "./usePresentationPlayback";
export default function PlaybackControls({
  playback,
}: {
  playback: ReturnType<typeof usePresentationPlayback>;
}) {
  if (!playback.active)
    return (
      <span
        className="playback-status-only"
        data-testid="presentation-playback"
        data-state={playback.state}
        data-step={playback.index}
      />
    );
  return (
    <div
      className="presentation-playback"
      data-testid="presentation-playback"
      data-state={playback.state}
      data-step={playback.index}
    >
      <span>
        Step {playback.index + 1} / {playback.total}
      </span>
      <button
        className="icon-button"
        data-testid="playback-pause"
        aria-label={
          playback.state === "paused"
            ? "Resume presentation sequence"
            : "Pause presentation sequence"
        }
        onClick={playback.state === "paused" ? playback.resume : playback.pause}
      >
        {playback.state === "paused" ? <Play size={14} /> : <Pause size={14} />}
      </button>
      <button
        className="icon-button"
        data-testid="playback-skip"
        aria-label="Skip presentation step"
        onClick={playback.skip}
      >
        <SkipForward size={14} />
      </button>
      <button
        className="icon-button"
        data-testid="playback-cancel"
        aria-label="Cancel presentation sequence"
        onClick={playback.cancel}
      >
        <X size={14} />
      </button>
    </div>
  );
}
