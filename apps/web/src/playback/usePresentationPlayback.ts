import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useMachine } from "@xstate/react";
import { assign, setup } from "xstate";
import {
  applyPresentationStep,
  validatePresentationSequence,
  type Scene,
  type PresentationStep,
  type VisualAction,
} from "@vizli/shared";

export const playbackMachine = setup({
  types: {
    context: {} as { index: number; total: number; run: number },
    events: {} as
      | { type: "START"; total: number }
      | { type: "DONE" }
      | { type: "PAUSE" }
      | { type: "RESUME" }
      | { type: "CANCEL" },
  },
}).createMachine({
  id: "presentation-playback",
  initial: "idle",
  context: { index: 0, total: 0, run: 0 },
  on: {
    START: {
      target: ".playing",
      actions: assign(({ context, event }) => ({
        index: 0,
        total: event.total,
        run: context.run + 1,
      })),
    },
  },
  states: {
    idle: {},
    playing: {
      on: {
        DONE: [
          {
            guard: ({ context }) => context.index + 1 >= context.total,
            target: "completed",
          },
          { actions: assign({ index: ({ context }) => context.index + 1 }) },
        ],
        PAUSE: "paused",
        CANCEL: "cancelled",
      },
    },
    paused: { on: { RESUME: "playing", CANCEL: "cancelled" } },
    completed: {},
    cancelled: {},
  },
});
export type PresentationFrame = {
  token: string;
  step: PresentationStep;
  paused: boolean;
};
type Options = {
  readScene: () => Scene;
  commitScene: (scene: Scene, sequenceId: string) => void;
  acknowledge: (actionId: string, complete: boolean) => void;
  onCancel?: (actionId: string) => void;
  onError: (message: string) => void;
};
export function usePresentationPlayback(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [state, send, actor] = useMachine(playbackMachine);
  const [frame, setFrame] = useState<PresentationFrame | null>(null);
  const sequence = useRef<VisualAction | null>(null),
    expected = useRef(""),
    started = useRef(""),
    acknowledged = useRef(false),
    pendingDone = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    deadline = useRef(0),
    remaining = useRef(0),
    timerMode = useRef<"wait" | "watchdog">("wait");
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const finishStep = useCallback(
    (token: string) => {
      if (token !== started.current || !sequence.current) return;
      const snapshot = actor.getSnapshot();
      if (snapshot.matches("paused")) {
        pendingDone.current = true;
        return;
      }
      if (!snapshot.matches("playing")) return;
      clearTimer();
      if (!acknowledged.current) {
        latest.current.acknowledge(sequence.current.id, false);
        acknowledged.current = true;
      }
      started.current = "";
      setFrame(null);
      send({ type: "DONE" });
    },
    [actor, send],
  );
  const cancel = useCallback(() => {
    const action = sequence.current;
    if (action) latest.current.onCancel?.(action.id);
    clearTimer();
    started.current = "";
    pendingDone.current = false;
    setFrame(null);
    send({ type: "CANCEL" });
    sequence.current = null;
    expected.current = "";
  }, [send]);
  const fail = useCallback(
    (token: string, message: string) => {
      if (token !== started.current) return;
      latest.current.onError(message);
      cancel();
    },
    [cancel],
  );
  const start = useCallback(
    (action: VisualAction) => {
      if (!action.sequence) return false;
      try {
        validatePresentationSequence(
          latest.current.readScene(),
          action.sequence,
        );
      } catch (error) {
        latest.current.onError(
          error instanceof Error
            ? error.message
            : "This presentation sequence is no longer valid.",
        );
        return false;
      }
      clearTimer();
      sequence.current = action;
      expected.current = JSON.stringify(latest.current.readScene());
      started.current = "";
      acknowledged.current = false;
      pendingDone.current = false;
      setFrame(null);
      send({ type: "START", total: action.sequence.steps.length });
      return true;
    },
    [send],
  );
  const pause = useCallback(() => {
    const snapshot = actor.getSnapshot();
    if (!snapshot.matches("playing")) return;
    if (timer.current) {
      remaining.current = Math.max(0, deadline.current - performance.now());
      clearTimer();
    }
    setFrame((f) => (f ? { ...f, paused: true } : f));
    send({ type: "PAUSE" });
  }, [actor, send]);
  const resume = useCallback(() => {
    if (!actor.getSnapshot().matches("paused")) return;
    setFrame((f) => (f ? { ...f, paused: false } : f));
    send({ type: "RESUME" });
    if (pendingDone.current) {
      pendingDone.current = false;
      finishStep(started.current);
    } else if (started.current) {
      const token = started.current;
      deadline.current = performance.now() + remaining.current;
      timer.current = setTimeout(
        () =>
          timerMode.current === "wait"
            ? finishStep(token)
            : fail(
                token,
                "The renderer did not finish this presentation step. Playback was cancelled.",
              ),
        remaining.current,
      );
    }
  }, [actor, send, finishStep, fail]);
  const skip = useCallback(() => {
    const snapshot = actor.getSnapshot();
    if (!snapshot.matches("playing") && !snapshot.matches("paused")) return;
    clearTimer();
    pendingDone.current = false;
    if (snapshot.matches("paused")) send({ type: "RESUME" });
    if (started.current) finishStep(started.current);
    else send({ type: "DONE" });
  }, [actor, send, finishStep]);
  const observeScene = useCallback(
    (scene: Scene) => {
      if (
        sequence.current &&
        expected.current &&
        JSON.stringify(scene) !== expected.current
      )
        cancel();
    },
    [cancel],
  );
  useLayoutEffect(() => {
    if (state.matches("completed")) {
      if (sequence.current) {
        latest.current.acknowledge(sequence.current.id, true);
        sequence.current = null;
      }
      setFrame(null);
      return;
    }
    if (
      !state.matches("playing") ||
      started.current ||
      !sequence.current?.sequence
    )
      return;
    const action = sequence.current,
      step = action.sequence!.steps[state.context.index];
    if (!step) return;
    const token = `${action.sequence!.id}:${state.context.run}:${step.id}:${state.context.index}`;
    started.current = token;
    try {
      const current = latest.current.readScene();
      if (JSON.stringify(current) !== expected.current) {
        cancel();
        return;
      }
      const next = applyPresentationStep(current, step);
      expected.current = JSON.stringify(next);
      if (JSON.stringify(next) !== JSON.stringify(current))
        latest.current.commitScene(next, action.sequence!.id);
      if (step.type === "context") {
        queueMicrotask(() => finishStep(token));
        return;
      }
      if (step.type === "wait") {
        timerMode.current = "wait";
        remaining.current = step.durationMs;
        deadline.current = performance.now() + step.durationMs;
        timer.current = setTimeout(() => finishStep(token), step.durationMs);
        return;
      }
      timerMode.current = "watchdog";
      remaining.current =
        ("durationMs" in step ? (step.durationMs ?? 1800) : 1800) + 7000;
      deadline.current = performance.now() + remaining.current;
      timer.current = setTimeout(
        () =>
          fail(
            token,
            "The renderer did not finish this presentation step. Playback was cancelled.",
          ),
        remaining.current,
      );
      setFrame({ token, step, paused: false });
    } catch (error) {
      latest.current.onError(
        error instanceof Error
          ? error.message
          : "Could not apply this presentation step.",
      );
      cancel();
    }
  }, [state, finishStep, cancel, fail]);
  useLayoutEffect(() => () => clearTimer(), []);
  return {
    state: state.value as
      | "idle"
      | "playing"
      | "paused"
      | "completed"
      | "cancelled",
    index: state.context.index,
    total: state.context.total,
    frame,
    start,
    cancel,
    pause,
    resume,
    skip,
    observeScene,
    fail,
    complete: finishStep,
    active: state.matches("playing") || state.matches("paused"),
  };
}
