import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { IndexeddbPersistence } from 'y-indexeddb';
import {
  CLOSE_WRITE_REFUSED,
  LocalOrigin,
  PROJECT_ROOT,
  ProjectSchema,
  RepairError,
  applyDiff,
  createDemoProject,
  createPlainCache,
  fromPlain,
  invalidateDerivedResults,
  observeProject,
  repairProject,
  toPlain,
  type ClientMessage,
  type CollabRole,
  type DiffSkip,
  type PlainCache,
  type Project,
  type ProjectChange,
} from '@vizli/shared';
import { getIdentity, type Identity } from './identity';
import { ensureEditToken, getEditToken } from './access';
import { CHANNEL_AUDIO, SessionTransport } from './transport';
import { YSocketProvider } from './provider';

export type PresenceMode = 'editing' | 'rehearsing' | 'presenting';
export type PresenceCamera = { x: number; y: number; zoom: number };
/** Awareness payload every client publishes (flat fields; `user`/`clientId` are kept for the server's roster). */
export type PresenceState = {
  userId: string;
  clientId: string;
  name: string;
  color: string;
  sceneId: string | null;
  cursor: { x: number; y: number } | null;
  selectedId: string | null;
  camera: PresenceCamera | null;
  mode: PresenceMode;
  listening: boolean;
};
export type Peer = PresenceState & { awarenessId: number };
/** Roster peers omit the cursor so cursor motion never re-renders the workspace; cursors come from `PeerStore`. */
export type RosterPeer = Omit<Peer, 'cursor'>;
export interface PeerStore {
  subscribe(listener: () => void): () => void;
  getPeers(): Peer[];
}
const MODES = ['editing', 'rehearsing', 'presenting'];
function toPeer(awarenessId: number, raw: unknown): Peer | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, any>;
  const userId = s.userId ?? s.user?.id;
  const clientId = s.clientId;
  if (typeof userId !== 'string' || typeof clientId !== 'string') return null;
  const num = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const cursor = s.cursor && num(s.cursor.x) && num(s.cursor.y) ? { x: s.cursor.x as number, y: s.cursor.y as number } : null;
  const camera = s.camera && num(s.camera.x) && num(s.camera.y) && num(s.camera.zoom) ? { x: s.camera.x, y: s.camera.y, zoom: s.camera.zoom } : null;
  return {
    awarenessId,
    userId,
    clientId,
    name: typeof (s.name ?? s.user?.name) === 'string' ? String(s.name ?? s.user.name).slice(0, 80) : 'Guest',
    color: typeof (s.color ?? s.user?.color) === 'string' && /^#[0-9a-fA-F]{3,6}$/.test(s.color ?? s.user?.color) ? (s.color ?? s.user.color) : '#2f6c56',
    sceneId: typeof s.sceneId === 'string' ? s.sceneId : null,
    cursor,
    selectedId: typeof s.selectedId === 'string' ? s.selectedId : null,
    camera,
    mode: MODES.includes(s.mode) ? s.mode : 'editing',
    listening: s.listening === true,
  };
}
const rosterKey = (p: Peer) => JSON.stringify([p.awarenessId, p.clientId, p.userId, p.name, p.color, p.sceneId, p.selectedId, p.camera, p.mode, p.listening]);

export type CollabStatus = 'loading' | 'cached' | 'connecting' | 'live' | 'offline';
export type CommitSource = 'user' | 'ai' | 'sequence';
export type CommitOptions = { base?: Project; source?: CommitSource; sequenceId?: string };
export type CommitResult = { ok: boolean; skipped: DiffSkip[]; error?: string; code?: 'read-only' };
type Snapshot = {
  project: Project | null;
  issues: string[];
  status: CollabStatus;
  undoCount: number;
  redoCount: number;
  docId: string | undefined;
  /** Increments on every successful `joined`; session messages (view, cue, listen) are accepted after it. */
  joinEpoch: number;
  /** The socket has joined the project room; session messages are accepted. */
  joined: boolean;
  /** Server-assigned role from `joined`; null until then. Viewers follow the project live but cannot change it. */
  role: CollabRole | null;
  storageFull: boolean;
  peers: RosterPeer[];
};

/** Plain mirror of the open project. Kept while specs and recovery tooling read it; written once per task after changes. */
export const MIRROR_KEY = 'vizli.project.v1';
export const docIdKey = (projectId: string) => `vizli.docid.${projectId}`;
const CAPTURE_MS = 800;
const OFFLINE_SEED_MS = 3000;
const IDB_WAIT_MS = 2000;

export function readLegacyProject(): Project | null {
  try {
    const parsed = ProjectSchema.safeParse(JSON.parse(localStorage.getItem(MIRROR_KEY) ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
const hasScenes = (doc: Y.Doc) => {
  const scenes = doc.getMap<unknown>(PROJECT_ROOT).get('scenes');
  return scenes instanceof Y.Array && scenes.length > 0;
};
const metaDocId = (doc: Y.Doc) => {
  const meta = doc.getMap<unknown>(PROJECT_ROOT).get('meta');
  const id = meta instanceof Y.Map ? meta.get('docId') : undefined;
  return typeof id === 'string' ? id : undefined;
};

/**
 * One collaborative project: Y.Doc + IndexedDB cache + socket provider + undo manager.
 * Shared by every hook instance for the same project (module registry), released after a
 * `setTimeout(0)` grace so React StrictMode's mount/unmount/mount reuses one doc and socket.
 */
class CollabEntry {
  refs = 0;
  releaseTimer: ReturnType<typeof setTimeout> | undefined;
  readonly transport = new SessionTransport();
  readonly provider: YSocketProvider;
  doc!: Y.Doc;
  awareness!: Awareness;
  undoManager!: Y.UndoManager;
  private persistence: IndexeddbPersistence | undefined;
  private idbReady: Promise<void> = Promise.resolve();
  private cache: PlainCache = createPlainCache();
  private unobserve: () => void = () => {};
  private readonly listeners = new Set<() => void>();
  private readonly remote = new Set<(change: ProjectChange) => void>();
  private snapshot: Snapshot;
  private latest: Project | null = null;
  private issues: string[] = [];
  private socketOpen = false;
  private everClosed = false;
  private offlineSeeded = false;
  private storageFull = false;
  private peerList: Peer[] = [];
  private roster: RosterPeer[] = [];
  private rosterSig = '';
  private readonly peerListeners = new Set<() => void>();
  private presence: Partial<PresenceState> = {};
  private joinEpoch = 0;
  private inSequence = false;
  private role: CollabRole | null = null;
  /** Local edits made while not joined; a viewer's are discarded on join because the server would refuse them. */
  private offlineEdits = false;
  /** The server refused a write and closed the socket: discard the local replica at the next join. */
  private resetOnJoin = false;
  private seedTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposers: (() => void)[] = [];
  viewSceneId: string | undefined;
  readonly identity: Identity;

  constructor(readonly projectId: string) {
    this.identity = getIdentity();
    this.snapshot = this.buildSnapshot();
    this.createDoc();
    this.provider = new YSocketProvider(this.doc, this.awareness, this.transport, {
      join: () => this.joinMessage(),
      onJoined: (docId, role) => this.handleJoined(docId, role),
      onSynced: () => this.emit(),
      onReady: () => this.emit(),
      onJoinError: () => {
        this.emit();
      },
    });
    this.disposers.push(
      this.transport.onOpen(() => {
        this.socketOpen = true;
        this.emit();
      }),
      this.transport.onClose((event) => {
        this.socketOpen = false;
        this.everClosed = true;
        if (event.code === CLOSE_WRITE_REFUSED) this.resetOnJoin = true;
        this.emit();
      }),
    );
    this.seedTimer = setTimeout(() => this.seedOffline(), OFFLINE_SEED_MS);
  }

  private localAwareness() {
    const p = this.presence;
    return { user: { id: p.userId, name: p.name, color: p.color }, ...p };
  }
  private recomputePeers() {
    const peers: Peer[] = [];
    for (const [id, raw] of this.awareness.getStates()) {
      if (id === this.awareness.clientID) continue;
      const peer = toPeer(id, raw);
      if (peer && peer.clientId !== this.identity.clientId) peers.push(peer);
    }
    peers.sort((a, b) => a.awarenessId - b.awarenessId);
    this.peerList = peers;
    for (const listener of [...this.peerListeners]) listener();
    const sig = peers.map(rosterKey).join('|');
    if (sig !== this.rosterSig) {
      this.rosterSig = sig;
      this.roster = peers.map(({ cursor: _cursor, ...rest }) => rest);
      this.emit();
    }
  }
  readonly peerStore: PeerStore = {
    subscribe: (listener) => {
      this.peerListeners.add(listener);
      return () => void this.peerListeners.delete(listener);
    },
    getPeers: () => this.peerList,
  };
  /** Merges `patch` into this client's awareness state; no-op when nothing changed. */
  setPresence = (patch: Partial<Omit<PresenceState, 'userId' | 'clientId'>>) => {
    const next = { ...this.presence, ...patch };
    const same = (Object.keys(patch) as (keyof typeof patch)[]).every((key) => JSON.stringify(this.presence[key]) === JSON.stringify(next[key]));
    if (same) return;
    this.presence = next;
    this.awareness.setLocalState(this.localAwareness());
  };

  /* ---------------------------- document lifecycle ---------------------------- */

  private createDoc() {
    const doc = new Y.Doc();
    this.doc = doc;
    this.awareness = new Awareness(doc);
    this.presence = {
      userId: this.identity.userId,
      clientId: this.identity.clientId,
      name: this.presence.name ?? this.identity.name,
      color: this.presence.color ?? this.identity.color,
      sceneId: this.presence.sceneId ?? null,
      cursor: null,
      selectedId: this.presence.selectedId ?? null,
      camera: this.presence.camera ?? null,
      mode: this.presence.mode ?? 'editing',
      listening: this.presence.listening ?? false,
    };
    this.awareness.setLocalState(this.localAwareness());
    this.awareness.on('change', () => this.recomputePeers());
    this.recomputePeers();
    this.cache = createPlainCache();
    const root = doc.getMap<unknown>(PROJECT_ROOT);
    this.undoManager = new Y.UndoManager(root, { trackedOrigins: new Set([LocalOrigin]), captureTimeout: CAPTURE_MS });
    const counts = () => this.emit();
    this.undoManager.on('stack-item-added', counts);
    this.undoManager.on('stack-item-popped', counts);
    this.undoManager.on('stack-cleared', counts);
    this.unobserve = observeProject(doc, (change) => {
      if (change.local && !this.provider?.joined) this.offlineEdits = true;
      this.recompute();
      // Undo/redo transactions carry the UndoManager as origin; they are this replica's own edits.
      if (!change.local && !(change.origin instanceof Y.UndoManager) && change.origin !== 'seed-local') for (const listener of [...this.remote]) listener(change);
    });
    try {
      const persistence = new IndexeddbPersistence(`vizli:${this.projectId}`, doc);
      this.persistence = persistence;
      this.idbReady = persistence.whenSynced.then(
        () => {
          if (this.doc === doc) this.recompute();
        },
        () => {},
      );
    } catch {
      // IndexedDB can be unavailable (private browsing); the doc then lives in memory only.
      this.persistence = undefined;
      this.idbReady = Promise.resolve();
    }
  }

  /**
   * The server's document differs from the cached one (new docId, or a locally seeded copy):
   * destroy the IndexedDB copy and start from an empty doc before the buffered server step 1 is processed.
   */
  private async resetDoc() {
    this.unobserve();
    this.undoManager.destroy();
    const persistence = this.persistence;
    this.persistence = undefined;
    try {
      await persistence?.clearData();
    } catch {
      /* the next IndexeddbPersistence overwrites what remains */
    }
    this.awareness.destroy();
    this.doc.destroy();
    this.latest = null;
    this.issues = [];
    this.offlineSeeded = false;
    this.createDoc();
    this.emit();
    return { doc: this.doc, awareness: this.awareness };
  }

  private async handleJoined(docId: string, role: CollabRole) {
    clearTimeout(this.seedTimer);
    this.role = role;
    // Decide only after the IndexedDB copy has loaded, otherwise an unloaded cache looks empty.
    await Promise.race([this.idbReady, new Promise((resolve) => setTimeout(resolve, IDB_WAIT_MS))]);
    let cached: string | null = null;
    try {
      cached = localStorage.getItem(docIdKey(this.projectId));
    } catch {
      /* ignore */
    }
    const local = cached ?? metaDocId(this.doc);
    // Replace the cached replica when it belongs to another document, when the server refused a write from it,
    // or when a viewer edited while disconnected (the server would refuse those edits as well).
    const replace =
      hasScenes(this.doc) && (local !== docId || this.resetOnJoin || (role === 'viewer' && this.offlineEdits));
    this.resetOnJoin = false;
    this.offlineEdits = false;
    try {
      localStorage.setItem(docIdKey(this.projectId), docId);
    } catch {
      /* ignore */
    }
    this.joinEpoch++;
    const replacement = replace ? await this.resetDoc() : undefined;
    this.emit();
    return replacement;
  }

  private joinMessage(): Extract<ClientMessage, { type: 'join' }> {
    const identity = getIdentity();
    let seed: Project | undefined;
    if (this.offlineSeeded && this.latest) seed = this.latest;
    else {
      const legacy = readLegacyProject();
      if (legacy?.id === this.projectId) seed = legacy;
    }
    // Carrying a seed creates the project, so this replica mints and keeps its edit token; otherwise send the stored one.
    const token = seed ? ensureEditToken(this.projectId) : getEditToken(this.projectId);
    return {
      type: 'join',
      projectId: this.projectId,
      userId: identity.userId,
      clientId: identity.clientId,
      name: identity.name,
      color: identity.color,
      ...(this.viewSceneId ? { sceneId: this.viewSceneId } : {}),
      ...(seed ? { seed: { ...seed, id: this.projectId } } : {}),
      ...(token ? { token } : {}),
    };
  }

  /** No server after 3 s and nothing cached: open the legacy local project (same id) or a fresh demo, offline. */
  private seedOffline() {
    if (this.latest || this.provider.joined || hasScenes(this.doc)) return;
    void this.idbReady.then(() => {
      if (this.latest || this.provider.joined || hasScenes(this.doc)) return;
      const legacy = readLegacyProject();
      const project = legacy?.id === this.projectId ? legacy : { ...createDemoProject(), id: this.projectId };
      fromPlain(this.doc, project, 'seed-local');
      this.offlineSeeded = true;
      this.recompute();
      // A join refused because the project did not exist can now carry this copy as its seed.
      this.provider.rejoin();
    });
  }

  private recompute() {
    if (!hasScenes(this.doc)) {
      this.emit();
      return;
    }
    try {
      const { project, issues } = repairProject(toPlain(this.doc, this.cache), this.projectId);
      this.latest = project;
      this.issues = issues;
    } catch (error) {
      if (!(error instanceof RepairError)) throw error;
      this.issues = [error.message];
    }
    this.scheduleMirror();
    this.emit();
  }

  /**
   * Coalesces mirror writes per task (microtask), so a test or recovery tool that reads storage right
   * after a UI event sees that event's change. A 300 ms debounce raced the existing specs' immediate reads.
   */
  private mirrorQueued = false;
  private scheduleMirror() {
    if (this.mirrorQueued) return;
    this.mirrorQueued = true;
    queueMicrotask(() => {
      this.mirrorQueued = false;
      if (!this.latest) return;
      try {
        localStorage.setItem(MIRROR_KEY, JSON.stringify(this.latest));
        if (this.storageFull) {
          this.storageFull = false;
          this.emit();
        }
      } catch {
        this.storageFull = true;
        this.emit();
      }
    });
  }

  /* -------------------------------- store API -------------------------------- */

  private status(): CollabStatus {
    if (this.provider?.synced) return 'live';
    if (this.socketOpen && this.latest) return 'connecting';
    if (!this.latest) return this.socketOpen ? 'connecting' : 'loading';
    return this.everClosed || this.offlineSeeded ? 'offline' : 'cached';
  }
  private buildSnapshot(): Snapshot {
    return {
      project: this.latest,
      issues: this.issues,
      status: this.status(),
      undoCount: this.undoManager?.undoStack.length ?? 0,
      redoCount: this.undoManager?.redoStack.length ?? 0,
      docId: this.provider?.docId,
      joinEpoch: this.joinEpoch,
      joined: this.provider?.joined ?? false,
      role: this.role,
      storageFull: this.storageFull,
      peers: this.roster,
    };
  }
  private emit() {
    const next = this.buildSnapshot();
    const prev = this.snapshot;
    if (
      prev &&
      prev.project === next.project &&
      prev.issues === next.issues &&
      prev.status === next.status &&
      prev.undoCount === next.undoCount &&
      prev.redoCount === next.redoCount &&
      prev.docId === next.docId &&
      prev.joinEpoch === next.joinEpoch &&
      prev.joined === next.joined &&
      prev.role === next.role &&
      prev.storageFull === next.storageFull &&
      prev.peers === next.peers
    )
      return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getProject = () => this.latest;

  commit = (next: Project, options: CommitOptions = {}): CommitResult => {
    const latest = this.latest;
    if (!latest) return { ok: false, skipped: [], error: 'the project is still opening' };
    // The server refuses every write from a viewer; refusing here keeps the local replica in step with the room.
    if (this.role === 'viewer') return { ok: false, skipped: [], error: 'this link is view only', code: 'read-only' };
    const source = options.source ?? 'user';
    const candidate = source === 'sequence' ? next : { ...next, scenes: next.scenes.map(invalidateDerivedResults) };
    const parsed = ProjectSchema.safeParse(candidate);
    if (!parsed.success)
      return { ok: false, skipped: [], error: parsed.error.issues[0]?.message ?? 'it would make the project invalid' };
    if (!this.inSequence) this.undoManager.stopCapturing();
    const result = applyDiff(
      this.doc,
      options.base ?? latest,
      parsed.data,
      new LocalOrigin(this.identity.clientId, source, options.sequenceId),
    );
    return { ok: true, skipped: result.skipped };
  };
  /** Undoes this replica's last change; returns false when there was nothing to undo. */
  undo = () => this.undoManager.undo() !== null;
  redo = () => this.undoManager.redo() !== null;
  beginSequence = (_id: string) => {
    this.inSequence = true;
    this.undoManager.captureTimeout = Number.MAX_SAFE_INTEGER;
    this.undoManager.stopCapturing();
  };
  endSequence = () => {
    if (!this.inSequence) return;
    this.inSequence = false;
    this.undoManager.captureTimeout = CAPTURE_MS;
    this.undoManager.stopCapturing();
  };
  onRemoteChange = (listener: (change: ProjectChange) => void) => {
    this.remote.add(listener);
    return () => void this.remote.delete(listener);
  };
  /** Session JSON messages are only accepted after `joined`; returns false otherwise. */
  send = (message: ClientMessage) => {
    if (message.type !== 'join' && !this.provider.joined) return false;
    return this.transport.sendJson(message);
  };
  sendAudio = (bytes: Uint8Array) => this.provider.joined && this.transport.sendBinary(CHANNEL_AUDIO, bytes);

  destroy() {
    clearTimeout(this.seedTimer);
    if (this.latest) {
      try {
        localStorage.setItem(MIRROR_KEY, JSON.stringify(this.latest));
      } catch {
        /* ignore */
      }
    }
    for (const dispose of this.disposers) dispose();
    this.provider.destroy();
    this.transport.dispose();
    this.unobserve();
    this.undoManager.destroy();
    this.persistence?.destroy();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

const registry = new Map<string, CollabEntry>();
function acquire(projectId: string): CollabEntry {
  let entry = registry.get(projectId);
  if (!entry) {
    entry = new CollabEntry(projectId);
    registry.set(projectId, entry);
  }
  clearTimeout(entry.releaseTimer);
  entry.refs++;
  return entry;
}
function release(entry: CollabEntry, graceMs = 0) {
  entry.refs--;
  clearTimeout(entry.releaseTimer);
  entry.releaseTimer = setTimeout(() => {
    if (entry.refs > 0 || registry.get(entry.projectId) !== entry) return;
    registry.delete(entry.projectId);
    entry.destroy();
  }, graceMs);
}

export function useCollabDoc(projectId: string, _identity?: Identity) {
  // Acquire during render so the first render already has the entry; the effect balances the reference.
  const entryRef = useRef<CollabEntry | null>(null);
  if (!entryRef.current || entryRef.current.projectId !== projectId) entryRef.current = registry.get(projectId) ?? acquireDetached(projectId);
  const entry = entryRef.current;
  useEffect(() => {
    const held = acquire(projectId);
    entryRef.current = held;
    return () => release(held);
  }, [projectId]);
  const snapshot = useSyncExternalStore(entry.subscribe, entry.getSnapshot);
  const setViewScene = useCallback((sceneId: string) => {
    entry.viewSceneId = sceneId;
  }, [entry]);
  return useMemo(
    () => ({
      ...snapshot,
      commit: entry.commit,
      undo: entry.undo,
      redo: entry.redo,
      beginSequence: entry.beginSequence,
      endSequence: entry.endSequence,
      onRemoteChange: entry.onRemoteChange,
      transport: entry.transport,
      send: entry.send,
      sendAudio: entry.sendAudio,
      getProject: entry.getProject,
      setViewScene,
      awareness: entry.awareness,
      identity: entry.identity,
      setPresence: entry.setPresence,
      peerStore: entry.peerStore,
    }),
    [snapshot, entry, setViewScene],
  );
}

/** Creates (or reuses) an entry for the first render; it is released after the grace period unless an effect acquires it. */
function acquireDetached(projectId: string) {
  const entry = acquire(projectId);
  // Longer grace: passive effects of the first render may run after a zero-delay timer.
  release(entry, 1000);
  return entry;
}
