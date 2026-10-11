import { useCallback, useEffect, useRef, useState } from "react";
import { useMachine } from "@xstate/react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  BarChart3,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  FileUp,
  Grid2X2,
  Hand,
  Eraser,
  PenLine,
  ImagePlus,
  Layers3,
  LayoutTemplate,
  Maximize2,
  Mic,
  MicOff,
  MoreHorizontal,
  MousePointer2,
  Play,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Type,
  Undo2,
  WandSparkles,
  X,
} from "lucide-react";
import {
  createDemoProject,
  createPluginObject,
  resolveImageAnchor,
  ProjectSchema,
  SceneSchema,
  applyBoardNavigation,
  applyObjectEdit,
  clearInk,
  INK_COLORS,
  INK_WIDTHS,
  type InkColorId,
  type InkTool,
  type InkWidthId,
  invalidateDerivedResults,
  appendIllustration,
  getSceneViewport,
  hasTarget,
  type Project,
  type Scene,
  type SceneObject,
  type Effect,
  type VisualAction,
} from "@vizli/shared";
import SceneCanvas from "./canvas/SceneCanvas";
import WhiteboardControls from "./editor/WhiteboardControls";
import {usePresentationPlayback} from "./playback/usePresentationPlayback";
import PlaybackControls from "./playback/PlaybackControls";
import PluginLibrary from "./editor/PluginLibrary";
import PluginInspector from "./editor/PluginInspector";
import ObjectDataEditor from "./editor/ObjectDataEditor";
import CreateScene from "./generation/CreateScene";
import CloudSync from "./cloud/CloudSync";
import { modeMachine, connectionMachine, inputMachine } from "./lib/machines";
import { captureAudio } from "./lib/audio";
import { describeServed, shortModelName } from "./lib/served";

type ProviderStatus = {
  mode: "demo" | "live";
  speechConfigured: boolean;
  modelConfigured: boolean;
  model: string | null;
  models?: { fast: string; core: string; reasoning: string } | null;
  routing?: "nemotron-first" | "local-rules";
};
type Log = {
  id: string;
  text: string;
  kind: "cue" | "action" | "skip" | "error";
};
const uid = () => crypto.randomUUID();
const LOCAL_KEY = "vizli.project.v1";
const AWS_SERVICE_LABELS: Record<
  NonNullable<SceneObject["aws"]>["service"],
  string
> = {
  lambda: "Lambda function",
  s3: "S3 bucket",
  apigateway: "API Gateway",
  dynamodb: "DynamoDB table",
  ec2: "EC2 instance",
  route53: "Route 53 routing policy",
  alb: "Application Load Balancer",
  rds: "RDS database",
};
function validProject(value: unknown): value is Project {
  return ProjectSchema.safeParse(value).success;
}
const BACKUP_KEY = "vizli.project.invalid";
function readProject() {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LOCAL_KEY);
    const raw = JSON.parse(stored || "null");
    if (validProject(raw)) return raw;
  } catch {}
  // Never discard a user's data silently: keep the unreadable copy for export/recovery.
  if (stored) {
    try {
      localStorage.setItem(BACKUP_KEY, stored);
    } catch {}
    console.warn(`Stored project failed validation; a copy is kept under ${BACKUP_KEY}.`);
  }
  return createDemoProject();
}

export default function App() {
  const [project, setProject] = useState<Project>(readProject);
  const [sceneIndex, setSceneIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [effect, setEffect] = useState<Effect | null>(null);
  const [mode, sendMode] = useMachine(modeMachine);
  const [connection, sendConnection] = useMachine(connectionMachine);
  const [input, sendInput] = useMachine(inputMachine);
  const [status, setStatus] = useState<ProviderStatus>({
    mode: "demo",
    speechConfigured: false,
    modelConfigured: false,
    model: null,
  });
  const [cue, setCue] = useState("");
  const [logs, setLogs] = useState<Log[]>([]);
  const [transcript, setTranscript] = useState("");
  const [cueState, setCueState] = useState("Ready for a cue");
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState("Saved on this device");
  const [dialog, setDialog] = useState<
    "providers" | "image" | "tour" | "scene" | null
  >(null);
  const [imageUrl, setImageUrl] = useState("");
  const [sceneTitle, setSceneTitle] = useState(""),
    [sceneSubtitle, setSceneSubtitle] = useState("");
  const modalRef = useRef<HTMLElement | null>(null);
  const [tourStep, setTourStep] = useState(0);
  const [cuePhrase, setCuePhrase] = useState("");
  const [cueAction, setCueAction] = useState<
    "highlight" | "point" | "reveal" | "animate"
  >("highlight");
  const [addOpen, setAddOpen] = useState(false);
  const [canvasTool,setCanvasTool]=useState<"select"|"pan">("select");
  const [inkTool,setInkTool]=useState<InkTool|null>(null);
  const [penStyle,setPenStyle]=useState<{color:InkColorId;width:InkWidthId}>({color:'red',width:'medium'});
  const [scenesOpen,setScenesOpen]=useState(false),[filesOpen,setFilesOpen]=useState(false),[activityOpen,setActivityOpen]=useState(false);
  const [historyCount, setHistoryCount] = useState(0);
  const cancelPlaybackRef=useRef<()=>void>(()=>{}),selfSequenceId=useRef<string|undefined>(undefined),historySequenceId=useRef<string|undefined>(undefined);
  const initialLoadSettled = useRef(false);
  const history = useRef<Project[]>([]),
    socket = useRef<WebSocket | null>(null),
    revision = useRef(1),
    stopAudio = useRef<(() => void) | null>(null),
    audioGeneration = useRef(0),
    projectRef = useRef(project),
    sceneIndexRef = useRef(sceneIndex),
    mounted = useRef(true),
    logEnd = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null),
    imageRef = useRef<HTMLInputElement>(null);
  projectRef.current = project;
  sceneIndexRef.current = sceneIndex;
  const scene = project.scenes[Math.min(sceneIndex, project.scenes.length - 1)];
  const selected = scene.objects.find((o) => o.id === selectedId);
  const isPresenting = mode.matches("presenting");
  const addLog = useCallback(
    (text: string, kind: Log["kind"]) =>
      setLogs((l) => [...l.slice(-39), { id: uid(), text, kind }]),
    [],
  );
  const send = useCallback((message: unknown) => {
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify(message));
      return true;
    }
    return false;
  }, []);
  const snapshot = useCallback(
    () =>
      send({
        type: "scene",
        ...(selfSequenceId.current ? {sequenceId:selfSequenceId.current} : {}),
        scene:
          projectRef.current.scenes[
            Math.min(
              sceneIndexRef.current,
              projectRef.current.scenes.length - 1,
            )
          ],
        revision: revision.current,
        cues: projectRef.current.cues,
      }),
    [send],
  );
  const stopMic = useCallback(() => {
    audioGeneration.current++;
    stopAudio.current?.();
    stopAudio.current = null;
    send({ type: "listen", enabled: false });
    sendInput({ type: "STOP" });
  }, [send, sendInput]);
  const commit = useCallback((next: Project, keepPlayback = false) => {
    const candidate = { ...next, scenes:next.scenes.map(invalidateDerivedResults), updatedAt: new Date().toISOString() };
    // Every persisted project must satisfy the shared schema; an invalid commit would be rejected by the server and dropped on reload.
    const parsed = ProjectSchema.safeParse(candidate);
    if (!parsed.success) {
      setNotice(`Change not applied: ${parsed.error.issues[0]?.message ?? "it would make the project invalid"}.`);
      return;
    }
    if (!keepPlayback) { cancelPlaybackRef.current();selfSequenceId.current=undefined; }
    history.current.push(projectRef.current);
    if (history.current.length > 60) history.current.shift();
    setHistoryCount(history.current.length);
    setProject(parsed.data);
  }, []);
  const undo = useCallback(() => {
    cancelPlaybackRef.current();selfSequenceId.current=undefined;
    const prior = history.current.pop();
    if (prior) {
      setProject(prior);
      setHistoryCount(history.current.length);
      setSelectedId(null);
      setEffect(null);
    } else setEffect(null);
  }, []);
  const updateScene = useCallback(
    (next: Scene) =>
      commit({
        ...projectRef.current,
        scenes: projectRef.current.scenes.map((s) =>
          s.id === next.id ? next : s,
        ),
        cues: projectRef.current.cues.filter(
          (c) => c.sceneId !== next.id || hasTarget(next, c.targetId),
        ),
      }),
    [commit],
  );
  // Ink commits share the validated/undoable path but must not cancel a running narrated sequence.
  const updateSceneInk = useCallback(
    (next: Scene) =>
      commit({
        ...projectRef.current,
        scenes: projectRef.current.scenes.map((s) => (s.id === next.id ? next : s)),
      }, true),
    [commit],
  );
  const pendingBoardEffect = useRef<Effect|null>(null);
  const playback=usePresentationPlayback({
    readScene:()=>{const s=projectRef.current.scenes[Math.min(sceneIndexRef.current,projectRef.current.scenes.length-1)];return s.ink?{...s,ink:undefined}:s;},
    commitScene:(stepped,sequenceId)=>{
      const localInk=projectRef.current.scenes.find(s=>s.id===stepped.id)?.ink;
      const next=localInk?{...stepped,ink:localInk}:stepped;
      if(historySequenceId.current!==sequenceId){history.current.push(projectRef.current);if(history.current.length>60)history.current.shift();setHistoryCount(history.current.length);historySequenceId.current=sequenceId;}
      const nextProject={...projectRef.current,scenes:projectRef.current.scenes.map(s=>s.id===next.id?next:s),cues:projectRef.current.cues.filter(c=>c.sceneId!==next.id||hasTarget(next,c.targetId)),updatedAt:new Date().toISOString()};
      selfSequenceId.current=sequenceId;projectRef.current=nextProject;setProject(nextProject);
    },
    acknowledge:(actionId,complete)=>send({type:complete?'animation.completed':'applied',actionId}),
    onCancel:actionId=>send({type:'animation.cancelled',actionId}),
    onError:message=>{addLog(message,'error');setNotice(message);},
  });
  cancelPlaybackRef.current=()=>{playback.cancel();selfSequenceId.current=undefined;};
  const handleAction = useCallback(
    (action: VisualAction) => {
      const current =
        projectRef.current.scenes[
          Math.min(sceneIndexRef.current, projectRef.current.scenes.length - 1)
        ];
      if (action.sceneId !== current.id || action.revision !== revision.current)
        return;
      if (action.type === "sequence") {
        if (playback.active) cancelPlaybackRef.current();
        historySequenceId.current=undefined;
        if(playback.start(action)){setEffect(null);addLog(action.reason||'Presentation sequence started','action');}
        return;
      }
      // A speech-revision clear retracts temporary emphasis only; it must not stop a narrated sequence.
      if(playback.active && !(action.type === "clear" && action.scope === "effects"))cancelPlaybackRef.current();
      if (action.type === "undo") {
        if (!history.current.length) { addLog("Nothing to undo.", "error"); return; }
        undo();
        send({ type: "applied", actionId: action.id });
      } else if (action.type === "clear") {
        setEffect(null);
        send({ type: "applied", actionId: action.id });
      } else if (action.type === "navigate") {
        if (!action.navigation || current.layout !== "whiteboard") { addLog("Navigation needs a whiteboard scene.", "error"); return; }
        updateScene(applyBoardNavigation(current, action.navigation));
        send({ type: "applied", actionId: action.id });
      } else if (action.type === "edit_object") {
        if (!action.targetId || !action.patch) { addLog("The object edit was incomplete and was not applied.", "error"); return; }
        try {
          const next = applyObjectEdit(current, action.targetId, action.patch);
          updateScene(next);
          send({ type: "applied", actionId: action.id });
        } catch (error) {
          addLog(error instanceof Error ? error.message : "The object edit could not be applied.", "error");
          setCueState("Edit skipped");
          return;
        }
      } else if (action.type === "move") {
        if (!current.objects.some(object => object.id === action.targetId)) { addLog("The object to move is no longer in this scene.", "error"); return; }
        const next = SceneSchema.safeParse({...current, objects: current.objects.map(object => {
          if (object.id !== action.targetId) return object;
          const positioned = resolveImageAnchor(object, current);
          return {...positioned, x: positioned.x + (action.dx ?? 0), y: positioned.y + (action.dy ?? 0), anchor: undefined};
        })});
        if (!next.success) { addLog("The object cannot be moved beyond the canvas limits.", "error"); return; }
        updateScene(next.data);
        send({ type: "applied", actionId: action.id });
      } else if (action.type === "add_illustration") {
        const next=SceneSchema.safeParse({...current,objects:[...current.objects,...(action.objects??[])],connections:[...current.connections,...(action.connections??[])],...(action.area?{areas:[...(current.areas??[]).filter(a=>a.id!==action.area?.id),action.area],activeAreaId:action.area.id}:{}),...(action.viewport?{viewport:action.viewport}:{})});
        if(!next.success){addLog("The illustration could not be added to this board.","error");return;}
        updateScene(next.data);
        send({ type: "applied", actionId: action.id });
      } else if (action.type === "add_image") {
        const object = action.object;
        if (
          !object ||
          object.kind !== "image" ||
          current.objects.some((o) => o.id === object.id)
        )
          return;
        const next = SceneSchema.safeParse({
          ...current,
          objects: [...current.objects, object],
        });
        if (!next.success) {
          addLog(
            "The retrieved image could not be placed in this scene.",
            "error",
          );
          return;
        }
        updateScene(next.data);
        setSelectedId(object.id);
        send({ type: "applied", actionId: action.id });
      } else if (action.type === "add_node") {
        const camera=getSceneViewport(current);
        const object: SceneObject = action.object ?? {
          id: action.targetId || uid(),
          kind: "node",
          label: action.label || "New component",
          x: (current.layout === "whiteboard" ? camera.x : 0) + 180 + (current.objects.length % 3) * 310,
          y: (current.layout === "whiteboard" ? camera.y : 0) + 180 + Math.floor(current.objects.length / 3) * 130,
          width: 220,
          height: 90,
          color: "#2f6c56",
        };
        if (current.objects.some((o) => o.id === object.id)) { addLog("That component already exists.", "error"); return; }
        const next = SceneSchema.safeParse({ ...current, objects: [...current.objects, object] });
        if (!next.success) { addLog("The component could not be added to this scene.", "error"); return; }
        updateScene(next.data);
        send({ type: "applied", actionId: action.id });
      } else if (action.type === "reveal") {
        // Nested part targets reveal their owning object; nothing is acknowledged unless an object changes.
        const ownerId = action.targetId?.split(":")[0];
        const owner = current.objects.find((o) => o.id === ownerId);
        if (!owner) { addLog("The object to reveal is no longer in this scene.", "error"); return; }
        if (owner.hidden) updateScene({
          ...current,
          objects: current.objects.map((o) =>
            o.id === owner.id ? { ...o, hidden: false } : o,
          ),
        });
        send({ type: "applied", actionId: action.id });
      } else if(current.layout === "whiteboard" && action.targetId && (action.type === "highlight" || action.type === "point")) {
        const next=applyBoardNavigation(current,{targetId:action.targetId});
        pendingBoardEffect.current={action,startedAt:Date.now()};
        updateScene(next);
      } else setEffect({ action, startedAt: Date.now() });
      const served = describeServed(action.served);
      addLog(`${action.reason || `${action.type} applied`}${served ? ` · ${served}` : ""}`, "action");
    },
    [addLog, send, undo, updateScene, playback],
  );
  const actionRef = useRef(handleAction);
  actionRef.current = handleAction;
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let retries = 0;
    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/session`,
      );
      socket.current = ws;
      ws.onopen = () => {
        retries = 0;
      };
      ws.onmessage = (e) => {
        try {
          const message = JSON.parse(e.data);
          if (message.type === "ready") {
            sendConnection({ type: "READY" });
            snapshot();
          }
          if (message.type === "action") actionRef.current(message.action);
          if (message.type === "transcript") setTranscript(message.text);
          if (message.type === "state") setCueState(message.state);
          if (message.type === "skipped") {
            const served = describeServed(message.served);
            addLog(`${message.reason}${served ? ` · ${served}` : ""}`, "skip");
            setCueState("Skipped");
          }
          if (message.type === "error") {
            addLog(message.message, "error");
            setNotice(message.message);
          }
          if (message.type === "speech") {
            if (message.state === "listening") sendInput({ type: "READY" });
            else {
              stopAudio.current?.();
              stopAudio.current = null;
              sendInput({ type: message.state === "error" ? "FAIL" : "STOP" });
            }
          }
        } catch {
          setNotice("Received an unreadable session event.");
        }
      };
      ws.onclose = () => {
        if (disposed) return;
        cancelPlaybackRef.current();
        sendConnection({ type: "LOST" });
        stopAudio.current?.();
        stopAudio.current = null;
        audioGeneration.current++;
        sendInput({ type: "STOP" });
        timer = setTimeout(connect, Math.min(1000 * 2 ** retries++, 10000));
      };
      ws.onerror = () => ws.close();
    };
    connect();
    fetch("/api/status")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setStatus)
      .catch(() =>
        setNotice("Server unavailable. Editing and local saving still work."),
      );
    if (!localStorage.getItem(LOCAL_KEY))
      fetch("/api/projects/default")
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((p) => {
          initialLoadSettled.current = true;
          if (validProject(p) && !disposed) setProject(p);
        })
        .catch(() => {})
        .finally(() => {
          initialLoadSettled.current = true;
        });
    else initialLoadSettled.current = true;
    return () => {
      disposed = true;
      mounted.current = false;
      clearTimeout(timer);
      socket.current?.close();
      stopAudio.current?.();
      audioGeneration.current++;
    };
  }, [addLog, sendConnection, sendInput, snapshot]);
  useEffect(() => {
    revision.current++;
    const pending=pendingBoardEffect.current;
    pendingBoardEffect.current=null;
    setEffect(pending?.action.sceneId===scene.id && pending.action.targetId && hasTarget(scene, pending.action.targetId) ? pending : null);
    snapshot();selfSequenceId.current=undefined;
  }, [project, sceneIndex, snapshot]);
  useEffect(() => {
    if (sceneIndex >= project.scenes.length)
      setSceneIndex(project.scenes.length - 1);
  }, [project.scenes.length, sceneIndex]);
  useEffect(() => {
    // Do not persist the placeholder demo locally or to the server before the stored project has been read.
    if (!initialLoadSettled.current) return;
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(project));
      setSaved("Saved on this device");
    } catch {
      setSaved("Storage full — export your project");
    }
    let aborted = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(project),
        signal: controller.signal,
      })
        .then((r) => {
          if (!aborted)
            setSaved(r.ok ? "All changes saved" : "Saved on this device");
        })
        .catch(() => {});
    }, 700);
    return () => {
      aborted = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [project]);
  useEffect(() => {
    if (!effect) return;
    // Animate effects also expire, so a target that never renders cannot pin the effect indefinitely.
    const timer = setTimeout(
      () => setEffect(null),
      effect.action.type === "animate" ? Math.max(8000, (effect.action.durationMs ?? 0) + 6500) : 6500,
    );
    return () => clearTimeout(timer);
  }, [effect]);
  useEffect(() => {
    const parent = logEnd.current?.parentElement;
    if (parent) parent.scrollTop = parent.scrollHeight;
  }, [logs]);
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, textarea, select, [tabindex="0"]',
        ) ?? [],
      );
    focusables()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusables();
      const first = elements[0],
        last = elements[elements.length - 1];
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !modalRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !modalRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [dialog]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6500);
    return () => clearTimeout(timer);
  }, [notice]);
  const inkToolRef = useRef<InkTool | null>(null);
  inkToolRef.current = inkTool;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDialog(null);
        setAddOpen(false);
        setScenesOpen(false);setFilesOpen(false);setActivityOpen(false);setSelectedId(null);
        if (inkToolRef.current) { setInkTool(null); return; }
        if (isPresenting) sendMode({ type: "EDIT" });
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "z" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [isPresenting, sendMode, undo]);
  function changeScene(index: number) {
    cancelPlaybackRef.current();
    setCanvasTool("select");
    setScenesOpen(false);setFilesOpen(false);
    setSceneIndex(index);
    setSelectedId(null);
    setEffect(null);
    setTranscript("");
  }
  function submitCue(text = cue, source: "typed" | "demo" = "typed") {
    if (!text.trim()) return;
    if (!send({ type: "cue", text: text.trim(), source, mode: mode.value })) {
      setNotice(
        "Connect the Vizli server to interpret cues. Your canvas is still editable.",
      );
      return;
    }
    addLog(text.trim(), "cue");
    setCue("");
    setCueState("Candidate");
  }
  async function toggleMic() {
    if (input.matches("listening") || input.matches("requesting")) {
      stopMic();
      return;
    }
    if (!status.speechConfigured) {
      setDialog("providers");
      return;
    }
    if (!connection.matches("ready")) {
      setNotice(
        "Wait for the session to reconnect before starting your microphone.",
      );
      return;
    }
    sendInput({ type: "START" });
    const generation = ++audioGeneration.current;
    try {
      const stop = await captureAudio((data) => {
        if (
          socket.current?.readyState === WebSocket.OPEN &&
          socket.current.bufferedAmount < 128000
        )
          socket.current.send(data);
      });
      if (!mounted.current || generation !== audioGeneration.current) {
        stop();
        return;
      }
      stopAudio.current = stop;
      send({ type: "listen", enabled: true });
    } catch (error) {
      sendInput({ type: "FAIL" });
      setNotice(
        error instanceof Error
          ? error.message
          : "Could not access your microphone.",
      );
    }
  }
  function addObject(kind: SceneObject["kind"], src?: string) {
    const camera=getSceneViewport(scene);
    const object: SceneObject = {
      id: uid(),
      kind,
      label:
        kind === "text"
          ? "New text"
          : kind === "matrix"
            ? "Matrix B"
            : kind === "chart"
              ? "New chart"
              : kind === "image"
                ? "Image"
                : "New component",
      x: (scene.layout === "whiteboard" ? camera.x : 0) + 120 + (scene.objects.length % 4) * 35,
      y: (scene.layout === "whiteboard" ? camera.y : 0) + 140 + (scene.objects.length % 3) * 40,
      width: kind === "chart" ? 500 : kind === "image" ? 400 : 300,
      height: kind === "text" ? 80 : kind === "matrix" ? 230 : 260,
      color: "#39775e",
      ...(kind === "text" ? { text: "Make your next point." } : {}),
      ...(kind === "matrix"
        ? {
            cells: [
              [1, 2],
              [3, 4],
            ],
          }
        : {}),
      ...(kind === "chart"
        ? { data: [24, 42, 58, 76], labels: ["Q1", "Q2", "Q3", "Q4"] }
        : {}),
      ...(src ? { src } : {}),
    };
    updateScene({ ...scene, objects: [...scene.objects, object] });
    setSelectedId(object.id);
    setAddOpen(false);
    setDialog(null);
  }
  function addPlugin(id:Parameters<typeof createPluginObject>[0],service?:NonNullable<SceneObject['aws']>['service']) {
    const camera=getSceneViewport(scene);
    const object=createPluginObject(id,uid(),(scene.layout==='whiteboard'?camera.x:0)+140,(scene.layout==='whiteboard'?camera.y:0)+180);
    if(service&&object.aws){object.aws={...object.aws,service};object.label=AWS_SERVICE_LABELS[service];}
    const next=SceneSchema.safeParse({...scene,objects:[...scene.objects,object]});
    if(!next.success){setNotice('This component could not be added to the current scene.');return;}
    updateScene(next.data);setSelectedId(object.id);setAddOpen(false);
  }
  function patchObject(patch: Partial<SceneObject>) {
    if (selected)
      updateScene({
        ...scene,
        objects: scene.objects.map((o) =>
          o.id === selected.id ? { ...o, ...patch } : o,
        ),
      });
  }
  function switchSurface(layout:'slide'|'whiteboard') {
    if((scene.layout??'slide')===layout)return;
    if(layout==='slide'){updateScene({...scene,layout});setCanvasTool('select');return;}
    const area=scene.areas?.length?scene.areas:[{id:uid(),label:'Start',x:0,y:0,width:1200,height:675}];
    updateScene({...scene,layout,viewport:scene.viewport??{x:0,y:0,zoom:1},areas:area,activeAreaId:scene.activeAreaId??area[0].id});
    setCanvasTool('pan');setSelectedId(null);setAddOpen(false);
  }
  function addScene() {
    const next: Scene = {
      id: uid(),
      title: "Untitled scene",
      subtitle: "A new idea starts here.",
      kind: "slide",
      objects: [],
      connections: [],
    };
    commit({ ...project, scenes: [...project.scenes, next] });
    changeScene(project.scenes.length);
  }
  function addWhiteboard() {
    const areaId=uid();
    const next:Scene={id:uid(),title:"Untitled whiteboard",subtitle:"ROOM TO THINK",kind:"slide",layout:"whiteboard",objects:[],connections:[],viewport:{x:0,y:0,zoom:1},areas:[{id:areaId,label:"Start",x:0,y:0,width:1200,height:675}],activeAreaId:areaId};
    commit({...project,scenes:[...project.scenes,next]});changeScene(project.scenes.length);sendMode({type:"EDIT"});
  }
  function exportProject() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(project, null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project.title.replace(/[^a-z0-9]/gi, "-") || "vizli"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function importProject(file?: File) {
    if (!file) return;
    try {
      const next = JSON.parse(await file.text());
      if (!validProject(next))
        throw new Error("This file is not a supported Vizli project.");
      commit(next);
      changeScene(0);
      setNotice("Project imported. All objects are editable.");
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Unable to import project.",
      );
    }
  }
  function saveCue() {
    if (!selected || !cuePhrase.trim()) return;
    commit({
      ...project,
      cues: [
        ...project.cues,
        {
          id: uid(),
          sceneId: scene.id,
          phrase: cuePhrase.trim(),
          targetId: selected.id,
          action: cueAction,
        },
      ],
    });
    setCuePhrase("");
    setNotice(
      "Cue remembered. Vizli will wait for it during your presentation.",
    );
  }
  const examples = scene.layout === "whiteboard" ? ["Let’s go right", "Draw a software architecture", "Go to Start"] :
    scene.kind === "math"
      ? [
          "Highlight the first row of matrix A",
          "Make matrix A 3 by 2",
          "Reveal the next step",
        ]
      : scene.kind === "architecture"
        ? ["Highlight the API", "Animate the database", "Add a cache"]
        : ["Point to revenue", "Highlight the chart", "An apple on the x axis"];
  const currentCues = project.cues.filter((c) => c.sceneId === scene.id);
  const tour = [
    {
      title: "Your ideas, a little more alive.",
      body: "Start with a prepared scene. Vizli remembers the objects, then waits for your words to bring them to life.",
    },
    {
      title: "Give your canvas a cue.",
      body: "Try a suggested phrase in the assistant panel. Demo mode uses a local rules engine; connected Nemotron interprets richer language.",
    },
    {
      title: "Make it yours.",
      body: "Select any object to edit it. In Rehearse, attach a phrase to that object. Present keeps the stage clean and your cues live.",
    },
  ];
  const canvas = (
    <SceneCanvas
      fillViewport
      presentation={playback.frame}
      onPresentationComplete={playback.complete}
      onPresentationError={playback.fail}
      panTool={canvasTool === "pan"}
      scene={scene}
      selectedId={selectedId}
      effect={effect}
      editable={mode.matches("editing")}
      selectable={!isPresenting}
      onSelect={setSelectedId}
      onChange={updateScene}
      inkTool={inkTool}
      onInkChange={updateSceneInk}
      onApplied={(actionId) => send({ type: "applied", actionId })}
      onAnimationComplete={(actionId) => {
        send({ type: "animation.completed", actionId });
        setEffect((e) => (e?.action.id === actionId ? null : e));
      }}
    />
  );
  return (
    <div className={`app canvas-first ${isPresenting ? "is-presenting" : ""} ${inkTool ? "is-inking" : ""}`}>
      <div className="workspace">
        <header className="floating-header">
          <div className="floating-project">
            <a className="tiny-brand" href="#" onClick={e=>e.preventDefault()} aria-label="Vizli home">vizli<span>✳</span></a>
            <span className="floating-separator"/>
            <div className="floating-title"><input aria-label="Project title" title={saved} value={project.title} onChange={e=>commit({...project,title:e.target.value})}/><span>{scene.title}</span></div>
            <button className={`icon-button ${scenesOpen?'active':''}`} aria-label="Open scenes" title="Scenes" aria-expanded={scenesOpen} data-testid="scenes-toggle" onClick={()=>{setScenesOpen(!scenesOpen);setFilesOpen(false);}}><Layers3 size={17}/></button>
          </div>
          <div className="floating-actions">
            <div className="mode-switch" aria-label="Presentation mode">
              {(["editing", "rehearsing", "presenting"] as const).map(
                (m, i) => (
                  <button
                    key={m}
                    data-testid={`mode-${m}`}
                    aria-label={["Edit", "Rehearse", "Present"][i]}
                    className={mode.matches(m) ? "selected" : ""}
                    onClick={() => {
                      setSelectedId(null);
                      sendMode({
                        type: (["EDIT", "REHEARSE", "PRESENT"] as const)[i],
                      });
                    }}
                  >
                    {i === 0 ? (
                      <MousePointer2 size={14} />
                    ) : i === 1 ? (
                      <AudioLines size={15} />
                    ) : (
                      <Play size={14} />
                    )}
                    <span>{["Edit", "Rehearse", "Present"][i]}</span>
                  </button>
                ),
              )}
            </div>
            <button className={`icon-button floating-menu-toggle ${filesOpen?'active':''}`} aria-label="Open project menu" title="Project menu" data-testid="project-menu-toggle" aria-expanded={filesOpen} onClick={()=>{setFilesOpen(!filesOpen);setScenesOpen(false);}}><MoreHorizontal size={20}/></button>
          </div>
          <div className={`project-menu ${filesOpen?'is-open':''}`} inert={!filesOpen} aria-hidden={!filesOpen}>
          <div className="header-actions">
            <CloudSync
              project={project}
              onLoad={(loaded) => {
                commit(loaded);
                changeScene(0);
                sendMode({ type: "EDIT" });
              }}
              onNotice={setNotice}
            />
            {!isPresenting && (
              <CreateScene
                key={scene.id}
                whiteboard={scene.layout === "whiteboard"}
                onCreate={(newScene) => {
                  const current=projectRef.current.scenes[sceneIndexRef.current];
                  if(current.layout === "whiteboard") { updateScene(appendIllustration(current,newScene));return; }
                  commit({
                    ...projectRef.current,
                    scenes: [...projectRef.current.scenes, newScene],
                  });
                  changeScene(projectRef.current.scenes.length);
                  sendMode({ type: "EDIT" });
                }}
                onNotice={setNotice}
              />
            )}
            <button
              className="status-pill"
              onClick={() => setDialog("providers")}
            >
              <span
                className={`status-dot ${status.modelConfigured ? "live" : ""}`}
              />
              {status.modelConfigured
                ? "Nemotron configured"
                : "Demo workspace"}
              <ChevronDown size={12} />
            </button>
            <button
              className="icon-button"
              title="Import project"
              data-testid="project-import"
              aria-label="Import project"
              onClick={() => importRef.current?.click()}
            >
              <FileUp size={18} />
            </button>
            <button
              data-testid="project-export"
              className="button export-button"
              onClick={exportProject}
            >
              <Download size={15} /> Export
            </button>
          </div>
            <button className="button" onClick={()=>{setDialog('providers');setFilesOpen(false);}}><Settings2 size={15}/> Connections</button>
            <button className="button" onClick={()=>{setTourStep(0);setDialog('tour');setFilesOpen(false);}}><CircleHelp size={15}/> Take a tour</button>
            <span className="menu-save-state"><Check size={12}/>{saved}</span>
          </div>
        </header>
        <main>
          <div className="studio-grid">
            {scenesOpen && (
              <nav className="filmstrip" aria-label="Presentation scenes">
                <button className="panel-close icon-button" aria-label="Close scenes" onClick={()=>setScenesOpen(false)}><X size={16}/></button><div className="section-label">
                  SCENES{" "}
                  <span>{String(project.scenes.length).padStart(2, "0")}</span>
                </div>
                <div className="scene-list">
                  {project.scenes.map((s, index) => (
                    <button
                      key={s.id}
                      data-testid={`scene-button-${s.id}`}
                      onClick={() => changeScene(index)}
                      className={`scene-tile ${index === sceneIndex ? "active" : ""}`}
                    >
                      <div className={`scene-preview preview-${s.kind}`}>
                        <div className="mini-kicker">
                          {s.kind === "math"
                            ? "THE CLASSROOM"
                            : s.kind === "architecture"
                              ? "ON THE WHITEBOARD"
                              : "THE BIG PICTURE"}
                        </div>
                        <strong>{s.title}</strong>
                        {s.kind === "slide" ? (
                          <div className="mini-chart">
                            {[30, 42, 35, 62, 78, 95].map((h, i) => (
                              <i key={i} style={{ height: `${h}%` }} />
                            ))}
                          </div>
                        ) : s.kind === "math" ? (
                          <div className="mini-matrix">
                            [ 1 &nbsp; 2 ]<br />[ 3 &nbsp; 4 ]
                          </div>
                        ) : (
                          <div className="mini-nodes">
                            <i />
                            <span>→</span>
                            <i />
                            <span>→</span>
                            <i />
                          </div>
                        )}
                      </div>
                      <div className="scene-caption">
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <strong>{s.title}</strong>
                        {index === sceneIndex && (
                          <span className="scene-active-dot" />
                        )}
                      </div>
                    </button>
                  ))}
                </div>
                <button className="add-scene new-whiteboard" data-testid="new-whiteboard" onClick={addWhiteboard}><Grid2X2 size={16}/> New whiteboard</button>
                <button className="add-scene" onClick={addScene}>
                  <Plus size={16} /> Add scene
                </button>
              </nav>
            )}
            <section className="stage-column" aria-label="Scene workspace">
              <div className="stage-toolbar">
                <div className="surface-switch" role="group" aria-label="Canvas surface">
                  <button data-testid="surface-slide" aria-pressed={scene.layout!=="whiteboard"} onClick={()=>switchSurface('slide')}>Slide</button>
                  <button data-testid="surface-whiteboard" aria-pressed={scene.layout==="whiteboard"} onClick={()=>switchSurface('whiteboard')}>Whiteboard</button>
                </div>
                {scene.layout==='whiteboard'&&<div className="canvas-tool-switch" role="group" aria-label="Canvas interaction tool"><button className="icon-button" data-testid="tool-select" aria-label="Select tool" title="Select and move objects" aria-pressed={canvasTool==='select'} onClick={()=>setCanvasTool('select')}><MousePointer2 size={14}/></button><button className="icon-button" data-testid="tool-hand" aria-label="Hand tool" title="Drag anywhere to pan the canvas" aria-pressed={canvasTool==='pan'} onClick={()=>{setCanvasTool('pan');setSelectedId(null);setInkTool(null);}}><Hand size={15}/></button></div>}
                <div className="ink-tools" role="group" aria-label="Pen annotations">
                  <button className="icon-button" data-testid="ink-tool-pen" aria-label="Pen" title="Draw on the canvas" aria-pressed={inkTool?.mode==='pen'} onClick={()=>{if(inkTool?.mode==='pen'){setInkTool(null);return;}setInkTool({mode:'pen',...penStyle});setSelectedId(null);setCanvasTool('select');}}><PenLine size={14}/></button>
                  {inkTool?.mode==='pen'&&<>
                    {INK_COLORS.map(c=><button key={c.id} className="ink-swatch-button" data-testid={`ink-color-${c.id}`} aria-label={c.label} title={c.label} aria-pressed={inkTool.color===c.id} onClick={()=>{setPenStyle(p=>({...p,color:c.id}));setInkTool({...inkTool,color:c.id});}}><span className="ink-swatch" style={{background:c.value,opacity:c.opacity}}/></button>)}
                    {(Object.keys(INK_WIDTHS) as InkWidthId[]).map((w,i)=><button key={w} className="ink-width-button" data-testid={`ink-width-${w}`} aria-label={`${w} stroke`} title={`${w} stroke`} aria-pressed={inkTool.width===w} onClick={()=>{setPenStyle(p=>({...p,width:w}));setInkTool({...inkTool,width:w});}}><span className="ink-dot" style={{width:4+i*3,height:4+i*3}}/></button>)}
                  </>}
                  <button className="icon-button" data-testid="ink-tool-eraser" aria-label="Eraser" title="Erase pen strokes" aria-pressed={inkTool?.mode==='eraser'} onClick={()=>{if(inkTool?.mode==='eraser'){setInkTool(null);return;}setInkTool({mode:'eraser'});setSelectedId(null);setCanvasTool('select');}}><Eraser size={14}/></button>
                  <button className="icon-button" data-testid="ink-clear" aria-label="Clear ink" title="Clear all pen strokes" disabled={!scene.ink?.length} onClick={()=>updateSceneInk(clearInk(scene))}><Trash2 size={14}/></button>
                </div>
                <div className="stage-tools">
                  {!isPresenting && (
                    <button
                      className="icon-button"
                      data-testid="scene-settings"
                      title="Edit scene details"
                      aria-label="Edit scene details"
                      onClick={() => {
                        setSceneTitle(scene.title);
                        setSceneSubtitle(scene.subtitle);
                        setDialog("scene");
                      }}
                    >
                      <Settings2 size={15} />
                    </button>
                  )}
                  <button
                    className="icon-button"
                    data-testid="undo-button"
                    title="Undo"
                    aria-label="Undo"
                    disabled={!historyCount && !effect}
                    onClick={undo}
                  >
                    <Undo2 size={16} />
                  </button>
                  <button
                    className="icon-button"
                    title="Clear attention"
                    aria-label="Clear attention"
                    onClick={() => setEffect(null)}
                  >
                    <Square size={14} />
                  </button>
                  <button
                    className="icon-button"
                    title="Present scene"
                    aria-label="Present scene"
                    onClick={() => sendMode({ type: "PRESENT" })}
                  >
                    <Maximize2 size={15} />
                  </button>
                </div>
              </div>
              {scene.layout === "whiteboard" && <WhiteboardControls scene={scene} onChange={updateScene}/>}
              <div className="stage-frame">{canvas}</div>
              {!isPresenting && (
                <div className="canvas-controls">
                  <div className="add-menu-wrap">
                    <button
                      className="button add-button"
                      onClick={() => setAddOpen(!addOpen)}
                    >
                      <Plus size={16} /> Add object <ChevronDown size={13} />
                    </button>
                    {addOpen && (
                      <div className="add-menu">
                        {[
                          { kind: "text" as const, label: "Text", icon: Type },
                          {
                            kind: "matrix" as const,
                            label: "Matrix",
                            icon: Grid2X2,
                          },
                          {
                            kind: "chart" as const,
                            label: "Chart",
                            icon: BarChart3,
                          },
                          {
                            kind: "node" as const,
                            label: "Diagram node",
                            icon: Layers3,
                          },
                        ].map((item) => (
                          <button
                            key={item.kind}
                            data-testid={`add-${item.kind}`}
                            onClick={() => addObject(item.kind)}
                          >
                            <item.icon size={16} />
                            {item.label}
                          </button>
                        ))}
                        <button
                          data-testid="add-image"
                          onClick={() => {
                            setDialog("image");
                            setAddOpen(false);
                          }}
                        >
                          <ImagePlus size={16} />
                          Image
                        </button>
                        <PluginLibrary onAdd={addPlugin}/>
                      </div>
                    )}
                  </div>
                  <div className="scene-nav">
                    <button
                      className="icon-button"
                      aria-label="Previous scene"
                      disabled={sceneIndex === 0}
                      onClick={() => changeScene(sceneIndex - 1)}
                    >
                      <ChevronLeft size={18} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Next scene"
                      disabled={sceneIndex === project.scenes.length - 1}
                      onClick={() => changeScene(sceneIndex + 1)}
                    >
                      <ChevronRight size={18} />
                    </button>
                  </div>
                </div>
              )}

            </section>
            {(activityOpen || (selected && !isPresenting)) && (
            <aside className="assistant-panel">
              <div className="assistant-header">
                <div className="assistant-avatar">
                  <Sparkles size={17} />
                </div>
                <div>
                  <strong>
                    {selected && !isPresenting
                      ? "Object studio"
                      : "Your visual copilot"}
                  </strong>
                  <span>
                    {selected && !isPresenting
                      ? "Make every detail yours"
                      : "A little magic. On your cue."}
                  </span>
                </div>
                {selected && !isPresenting ? (
                  <button
                    className="icon-button"
                    aria-label="Close inspector"
                    onClick={() => setSelectedId(null)}
                  >
                    <X size={16} />
                  </button>
                ) : (
                  <button className="icon-button" aria-label="Close activity" onClick={()=>setActivityOpen(false)}><X size={16}/></button>
                )}
              </div>
              {selected && !isPresenting ? (
                <div className="inspector">
                  <div className="section-label">
                    {selected.kind.toUpperCase()} OBJECT <span>EDITABLE</span>
                  </div>
                  <label>
                    Object name
                    <input
                      data-testid="inspector-label"
                      value={selected.label}
                      onChange={(e) => patchObject({ label: e.target.value })}
                    />
                  </label>
                  {(selected.kind === "text" || selected.kind === "node") && (
                    <label>
                      Text
                      <textarea
                        value={selected.text ?? selected.label}
                        onChange={(e) => patchObject({ text: e.target.value })}
                      />
                    </label>
                  )}
                  {selected.kind === "metric" && (
                    <label>
                      Value
                      <input
                        data-testid="inspector-value"
                        value={selected.value ?? ""}
                        onChange={(e) => patchObject({ value: e.target.value })}
                      />
                    </label>
                  )}
                  <div className="field-row">
                    <label>
                      Width
                      <input
                        type="number"
                        min="30"
                        max="2400"
                        value={Math.round(selected.width)}
                        onChange={(e) =>
                          patchObject({
                            width: Math.min(2400, Math.max(30, Number(e.target.value) || 30)),
                          })
                        }
                      />
                    </label>
                    <label>
                      Height
                      <input
                        type="number"
                        min="30"
                        max="1350"
                        value={Math.round(selected.height)}
                        onChange={(e) =>
                          patchObject({
                            height: Math.min(1350, Math.max(30, Number(e.target.value) || 30)),
                          })
                        }
                      />
                    </label>
                    <label>
                      Color
                      <input
                        className="color-input"
                        type="color"
                        value={selected.color || "#39775e"}
                        onChange={(e) => patchObject({ color: e.target.value })}
                      />
                    </label>
                  </div>
                  {(selected.kind === "matrix" ||
                    selected.kind === "chart") && (
                    <ObjectDataEditor object={selected} onApply={patchObject} />
                  )}
                  {selected.kind === "image" && (
                    <label>
                      Image URL
                      <input
                        value={
                          selected.src?.startsWith("data:")
                            ? "Uploaded image"
                            : selected.src || ""
                        }
                        readOnly={selected.src?.startsWith("data:")}
                        onChange={(e) =>
                          patchObject({
                            src: e.target.value,
                            imageSource: undefined,
                          })
                        }
                      />
                    </label>
                  )}
                  {selected.kind === "image" &&
                    (selected.imageSource || selected.anchor) && (
                      <div
                        className="image-provenance"
                        data-testid="image-provenance"
                      >
                        {selected.anchor && (
                          <p data-testid="image-anchor-status">
                            <strong>Anchored to x-axis</strong>
                            <span>
                              {scene.objects.find(
                                (o) => o.id === selected.anchor?.targetId,
                              )?.label || selected.anchor.targetId}
                            </span>
                          </p>
                        )}
                        {selected.imageSource && (
                          <>
                            <div className="section-label">IMAGE SOURCE</div>
                            <a
                              data-testid="image-source-link"
                              href={selected.imageSource.pageUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              View on {selected.imageSource.provider}{" "}
                              <ArrowRight size={12} />
                            </a>
                            <p>Search: {selected.imageSource.query}</p>
                            {selected.imageSource.attribution && (
                              <p>{selected.imageSource.attribution}</p>
                            )}
                            {selected.imageSource.license && (
                              <p>
                                <strong>License:</strong>{" "}
                                {selected.imageSource.license}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  <PluginInspector object={selected} onApply={patchObject} onCue={submitCue}/>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={!!selected.hidden}
                      onChange={(e) =>
                        patchObject({ hidden: e.target.checked })
                      }
                    />{" "}
                    Hidden until revealed
                  </label>
                  <div className="inspector-actions">
                    <button
                      className="button"
                      onClick={() => submitCue(`Highlight ${selected.label}`)}
                    >
                      <Sparkles size={14} /> Try highlight
                    </button>
                    <button
                      className="icon-button danger"
                      aria-label="Delete selected object"
                      onClick={() => {
                        commit({
                          ...project,
                          scenes: project.scenes.map((s) =>
                            s.id === scene.id
                              ? {
                                  ...s,
                                  objects: s.objects
                                    .filter((o) => o.id !== selected.id)
                                    .map((o) =>
                                      o.anchor?.targetId === selected.id
                                        ? {
                                            ...resolveImageAnchor(o, s),
                                            anchor: undefined,
                                          }
                                        : o,
                                    ),
                                  connections: s.connections.filter(
                                    (c) =>
                                      c.source !== selected.id &&
                                      c.target !== selected.id,
                                  ),
                                }
                              : s,
                          ),
                          cues: project.cues.filter(
                            (c) =>
                              !(
                                c.sceneId === scene.id &&
                                (c.targetId === selected.id ||
                                  c.targetId.startsWith(`${selected.id}:`))
                              ),
                          ),
                        });
                        setSelectedId(null);
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <div className="rehearsal-editor">
                    <div className="section-label">
                      <AudioLines size={13} /> REMEMBER A CUE
                    </div>
                    <p>When you say this, Vizli knows what to do.</p>
                    <input
                      aria-label="Rehearsal phrase"
                      placeholder="e.g. Here's the big number"
                      value={cuePhrase}
                      onChange={(e) => setCuePhrase(e.target.value)}
                    />
                    <div className="field-row">
                      <select
                        aria-label="Cue action"
                        value={cueAction}
                        onChange={(e) =>
                          setCueAction(e.target.value as typeof cueAction)
                        }
                      >
                        <option value="highlight">Highlight</option>
                        <option value="point">Point to</option>
                        <option value="reveal">Reveal</option>
                        <option value="animate">Animate</option>
                      </select>
                      <button
                        className="button primary"
                        disabled={!cuePhrase.trim()}
                        onClick={saveCue}
                      >
                        Remember
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="suggestions">
                    <div className="section-label">TRY SAYING</div>
                    {examples.map((example, i) => (
                      <button
                        key={example}
                        onClick={() => submitCue(example, "demo")}
                      >
                        <span>
                          {i === 0 ? (
                            <MousePointer2 size={14} />
                          ) : i === 1 ? (
                            <WandSparkles size={14} />
                          ) : (
                            <Layers3 size={14} />
                          )}
                        </span>
                        “{example}”<ArrowRight size={13} />
                      </button>
                    ))}
                  </div>
                </>
              )}
              {!isPresenting && currentCues.length > 0 && (
                <div className="remembered-cues">
                  <div className="section-label">
                    REMEMBERED CUES <span>{currentCues.length}</span>
                  </div>
                  {currentCues.map((c) => (
                    <div className="remembered-cue" key={c.id}>
                      <div>
                        <span>“{c.phrase}”</span>
                        <small>
                          {c.action} ·{" "}
                          {scene.objects.find(
                            (o) =>
                              c.targetId === o.id ||
                              c.targetId.startsWith(`${o.id}:`),
                          )?.label || c.targetId}
                        </small>
                      </div>
                      <button
                        className="icon-button"
                        aria-label={`Remove cue ${c.phrase}`}
                        data-testid={`remove-cue-${c.id}`}
                        onClick={() =>
                          commit({
                            ...project,
                            cues: project.cues.filter(
                              (item) => item.id !== c.id,
                            ),
                          })
                        }
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="activity">
                <div className="section-label">
                  {input.matches("listening")
                    ? "LIVE TRANSCRIPT"
                    : "SESSION ACTIVITY"}
                  <span
                    className={
                      connection.matches("ready")
                        ? "connection-ready"
                        : "connection-wait"
                    }
                  >
                    {connection.matches("ready") ? "CONNECTED" : "RECONNECTING"}
                  </span>
                </div>
                {transcript && (
                  <p className="live-transcript">“{transcript}”</p>
                )}
                <div className="activity-log" aria-live="polite">
                  {!logs.length ? (
                    <div className="empty-activity">
                      <span className="small-sparkle">✧</span>
                      <p>
                        Your next cue starts something.
                        <br />
                        <span>No visual changes until you ask.</span>
                      </p>
                    </div>
                  ) : (
                    logs.slice(-5).map((log) => (
                      <div key={log.id} className={`log-entry log-${log.kind}`}>
                        {log.kind === "cue" ? (
                          <span className="log-label">YOU</span>
                        ) : log.kind === "action" ? (
                          <Check size={13} />
                        ) : (
                          <span className="log-label">
                            {log.kind === "skip" ? "SKIP" : "NOTE"}
                          </span>
                        )}
                        <span>{log.text}</span>
                      </div>
                    ))
                  )}
                  <div ref={logEnd} />
                </div>
              </div>
              <div className="assistant-disclaimer">
                {status.modelConfigured
                  ? "Powered by NVIDIA Nemotron on Nebius"
                  : "Cue interpretation uses local rules. No AI inference."}
                <span className="retrieval-note">
                  Image requests search Wikimedia Commons live.
                </span>
              </div>
            </aside>
            )}
          </div>
          <div className="floating-dock" aria-label="Voice and canvas instructions">
            <PlaybackControls playback={playback}/>
            {(transcript || logs.length>0) && <div className="dock-transcript" aria-live="polite"><span>{transcript || logs.at(-1)?.text}</span><button className="icon-button" title="Session activity" aria-label="Open activity" onClick={()=>{setSelectedId(null);setActivityOpen(!activityOpen);}}><AudioLines size={14}/></button></div>}
            <div className="dock-input-row">
              <button data-testid="microphone-toggle" className={`mic-button ${input.matches('listening')?'listening':''}`} onClick={()=>void toggleMic()} aria-label={input.matches('listening')?'Stop microphone':'Start microphone'} title={input.matches('listening')?'Listening · click to stop':status.speechConfigured?'Start microphone':'Configure speech recognition'}>{input.matches('listening')?<Mic size={20}/>:<MicOff size={20}/>}</button>
              <form
                className="cue-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitCue();
                }}
              >
                <textarea
                  data-testid="cue-input"
                  aria-label="Type a visual cue"
                  placeholder={input.matches("listening") ? "Listening… or type an instruction" : "Speak, or tell your canvas what to do…"}
                  value={cue}
                  onChange={(e) => setCue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submitCue();
                    }
                  }}
                />
                <div>
                  <span>
                    <span className="green-dot" />
                    {cueState.toLowerCase() === "searching"
                      ? "Searching Wikimedia Commons…"
                      : cueState.replaceAll("_", " ")}
                  </span>
                  <button
                    data-testid="cue-submit"
                    type="submit"
                    aria-label="Send cue"
                    disabled={!cue.trim()}
                  >
                    <ArrowRight size={17} />
                  </button>
                </div>
              </form>

              <button className="icon-button dock-activity" aria-label="Open activity" title="Activity and cue examples" data-testid="activity-toggle" onClick={()=>{setSelectedId(null);setActivityOpen(!activityOpen);}}><Sparkles size={17}/></button>
            </div>
            <div className="dock-status"><button onClick={()=>setDialog('providers')}><span className={`status-dot ${status.modelConfigured?'live':''}`}/>{status.modelConfigured?'Nemotron · Nebius':'Demo · local rules'}</button><span>{input.matches('listening')?'Microphone on':input.matches('requesting')?'Connecting microphone…':'Microphone off'}</span></div>
          </div>
        </main>
      </div>
      <input
        hidden
        ref={importRef}
        type="file"
        accept="application/json,.json"
        onChange={(e) => {
          void importProject(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        hidden
        ref={imageRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            if (file.size > 4 * 1024 * 1024) {
              setNotice("Use an image smaller than 4 MB.");
              return;
            }
            const reader = new FileReader();
            reader.onload = () => addObject("image", String(reader.result));
            reader.readAsDataURL(file);
          }
          e.target.value = "";
        }}
      />
      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {dialog && (
        <div className="modal-backdrop" onClick={() => setDialog(null)}>
          <section
            ref={modalRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close dialog"
              onClick={() => setDialog(null)}
            >
              <X size={20} />
            </button>
            {dialog === "scene" ? (
              <>
                <span className="modal-symbol">
                  <LayoutTemplate size={25} />
                </span>
                <h2 id="dialog-title">Set the scene.</h2>
                <label>
                  Scene title
                  <input
                    data-testid="scene-title"
                    maxLength={300}
                    value={sceneTitle}
                    onChange={(e) => setSceneTitle(e.target.value)}
                  />
                </label>
                <label>
                  Scene subtitle
                  <input
                    data-testid="scene-subtitle"
                    maxLength={1000}
                    value={sceneSubtitle}
                    onChange={(e) => setSceneSubtitle(e.target.value)}
                  />
                </label>
                <button
                  className="button primary full"
                  data-testid="apply-scene-details"
                  onClick={() => {
                    updateScene({
                      ...scene,
                      title: sceneTitle,
                      subtitle: sceneSubtitle,
                    });
                    setDialog(null);
                  }}
                >
                  Save scene details
                </button>
              </>
            ) : dialog === "providers" ? (
              <>
                <span className="modal-symbol">
                  <Settings2 size={25} />
                </span>
                <div className="eyebrow">YOUR CONNECTIONS</div>
                <h2 id="dialog-title">
                  Bring your voice
                  <br />
                  <em>into the picture.</em>
                </h2>
                <p>
                  Demo cues work through the local interpreter. Enable providers
                  on the server for live speech and Nemotron interpretation.
                </p>
                <div className="provider-row">
                  <div>
                    <strong>Nemotron · Nebius Token Factory</strong>
                    <span>
                      {status.models
                        ? `Nemotron-first routing across three tiers`
                        : status.model || "Visual cue interpretation"}
                    </span>
                  </div>
                  <span
                    className={`provider-badge ${status.modelConfigured ? "configured" : ""}`}
                  >
                    {status.modelConfigured ? "Configured" : "Not configured"}
                  </span>
                </div>
                {status.models && (
                  <div className="provider-tiers" data-testid="provider-tiers">
                    {(
                      [
                        ["fast", "Routes every cue, repairs transcripts"],
                        ["core", "Free-form visual actions, scene planning"],
                        ["reasoning", "Authors lessons for new topics"],
                      ] as const
                    ).map(([tier, role]) => (
                      <div className="provider-tier" key={tier}>
                        <span className="tier-name">{tier}</span>
                        <span className="tier-model" title={status.models![tier]}>
                          {shortModelName(status.models![tier])}
                        </span>
                        <span className="tier-role">{role}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="provider-row">
                  <div>
                    <strong>NVIDIA Nemotron ASR</strong>
                    <span>Streaming speech recognition</span>
                  </div>
                  <span
                    className={`provider-badge ${status.speechConfigured ? "configured" : ""}`}
                  >
                    {status.speechConfigured ? "Configured" : "Not configured"}
                  </span>
                </div>
                <div className="config-note">
                  Set <code>NEBIUS_API_KEY</code>, <code>NEBIUS_MODEL</code>,
                  and <code>NVIDIA_API_KEY</code> in the server environment,
                  then restart. Credentials stay on the server.
                </div>
                <button
                  className="button primary full"
                  onClick={() => {
                    fetch("/api/status")
                      .then((r) => r.json())
                      .then((s) => {
                        setStatus(s);
                        setNotice("Connection status refreshed.");
                      })
                      .catch(() => setNotice("Cannot reach the Vizli server."));
                  }}
                >
                  Refresh connections
                </button>
              </>
            ) : dialog === "image" ? (
              <>
                <span className="modal-symbol">
                  <ImagePlus size={25} />
                </span>
                <h2 id="dialog-title">A picture belongs here.</h2>
                <p>
                  Add an image from your device, or use a direct HTTPS image
                  URL.
                </p>
                <label>
                  Image URL
                  <input
                    placeholder="https://example.com/image.jpg"
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                  />
                </label>
                <button
                  className="button primary full"
                  onClick={() => {
                    try {
                      const url = new URL(imageUrl);
                      if (!["http:", "https:"].includes(url.protocol))
                        throw new Error();
                      addObject("image", url.href);
                      setImageUrl("");
                    } catch {
                      setNotice("Enter a valid HTTP or HTTPS image URL.");
                    }
                  }}
                >
                  Add image
                </button>
                <button
                  className="button full"
                  onClick={() => imageRef.current?.click()}
                >
                  <FileUp size={16} />
                  Upload from device
                </button>
                <small>PNG, JPEG, WebP or GIF · up to 4 MB</small>
              </>
            ) : (
              <>
                <span className="modal-symbol">
                  <Sparkles size={28} />
                </span>
                <div className="eyebrow">MEET VIZLI · {tourStep + 1} / 3</div>
                <h2 id="dialog-title">{tour[tourStep].title}</h2>
                <p>{tour[tourStep].body}</p>
                <div className="tour-dots">
                  {tour.map((_, i) => (
                    <button
                      key={i}
                      aria-label={`Tour step ${i + 1}`}
                      className={i === tourStep ? "active" : ""}
                      onClick={() => setTourStep(i)}
                    />
                  ))}
                </div>
                <button
                  className="button primary full"
                  onClick={() =>
                    tourStep === 2 ? setDialog(null) : setTourStep(tourStep + 1)
                  }
                >
                  {tourStep === 2 ? "Start creating" : "Show me around"}
                  <ArrowRight size={16} />
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
