import { createMachine } from "xstate";
export const modeMachine = createMachine({
  id: "mode",
  initial: "editing",
  states: {
    editing: { on: { REHEARSE: "rehearsing", PRESENT: "presenting" } },
    rehearsing: { on: { EDIT: "editing", PRESENT: "presenting" } },
    presenting: { on: { EDIT: "editing", REHEARSE: "rehearsing" } },
  },
});
export const connectionMachine = createMachine({
  id: "connection",
  initial: "connecting",
  states: {
    connecting: { on: { READY: "ready", LOST: "reconnecting" } },
    ready: { on: { LOST: "reconnecting" } },
    reconnecting: { on: { READY: "ready", CONNECT: "connecting" } },
  },
});
export const inputMachine = createMachine({
  id: "input",
  initial: "off",
  states: {
    off: { on: { START: "requesting" } },
    requesting: {
      on: { READY: "listening", FAIL: "unavailable", STOP: "off" },
    },
    listening: { on: { STOP: "off", FAIL: "unavailable" } },
    unavailable: { on: { START: "requesting", STOP: "off" } },
  },
});
