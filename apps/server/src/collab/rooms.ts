import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import {
  messageYjsSyncStep1,
  readSyncMessage,
  writeSyncStep1,
  writeUpdate,
} from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { randomUUID } from "node:crypto";
import {
  PROJECT_ROOT,
  ProjectSchema,
  RepairError,
  applyDiff,
  createDemoProject,
  createPlainCache,
  fromPlain,
  observeProject,
  repairProject,
  toPlain,
  type CollabRole,
  type Project,
  type ServerMessage,
} from "@vizli/shared";
import type { ProjectStore } from "../store.js";
import type { CollabLimits } from "./limits.js";
import { KeyedWindow } from "./limits.js";
import {
  DEMO_PROJECT_ID,
  accessRecord,
  isUsableToken,
  mintEditToken,
  roleFor,
  type AccessRecord,
} from "./access.js";

/** Binary frame channels: one varuint prefix byte, then the channel payload. */
export const CHANNEL_SYNC = 0;
export const CHANNEL_AWARENESS = 1;
export const CHANNEL_AUDIO = 2;

const ID = /^[a-zA-Z0-9_-]{1,120}$/;
const PLAIN_NOTIFY_MS = 50;
/** Updates no larger than this are still accepted a little past the size cap so a full project can be cleaned up. */
const SMALL_UPDATE_BYTES = 1024;
const OVERFLOW_TOLERANCE = 1.25;
export const READ_ONLY_MESSAGE =
  "This link is view only. Make an editable copy to change or narrate it.";

export type RoomSocket = {
  readyState: number;
  bufferedAmount: number;
  send(data: string | Uint8Array, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
};
export type MemberInput = {
  socket: RoomSocket;
  clientId: string;
  userId: string;
  name: string;
  color: string;
  /** Editors presented the project's edit token; viewers receive sync and presence but every write is refused. */
  role: CollabRole;
  /** The room's plain project changed; `self` when this member's socket authored part of the change. */
  onPlain: (origin: "self" | "peer") => void;
};
export type Member = MemberInput & { awarenessIds: Set<number> };
export type Logger = {
  warn: (message: string) => void;
  info?: (message: string) => void;
};
export class RoomError extends Error {
  constructor(
    readonly code:
      | "project-not-found"
      | "project-unreadable"
      | "invalid-seed"
      | "project-limit"
      | "project-exists"
      | "rooms-full"
      | "room-full"
      | "bad-frame"
      | "read-only"
      | "document-full",
    message: string,
  ) {
    super(message);
    this.name = "RoomError";
  }
}

export function frame(channel: number, body: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, channel);
  encoding.writeUint8Array(encoder, body);
  return encoding.toUint8Array(encoder);
}
const fullMessage = (limits: CollabLimits) =>
  `This project has reached its size limit of ${Math.max(1, Math.round(limits.maxDocBytes / 1048576))} MB. Remove large images or ink before adding more.`;

/**
 * One collaborative document per project. The room relays Yjs sync and awareness frames between its sockets,
 * persists the document, and exposes the repaired plain project for the voice sessions and the HTTP API.
 */
export class DocRoom {
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  readonly sockets = new Map<RoomSocket, Member>();
  /** Counts applied updates; stamped into actions so clients can tell which state an action saw. */
  version = 0;
  docId = "";
  /** Hashed edit token; null for the demo and for projects created before access records existed. */
  access: AccessRecord | null = null;
  private readonly plainCache = createPlainCache();
  private cachedPlain: Project | undefined;
  private plainStale = true;
  private repairWarned = false;
  private dirtySince: number | null = null;
  private saveTimer: NodeJS.Timeout | undefined;
  private plainTimer: NodeJS.Timeout | undefined;
  private evictTimer: NodeJS.Timeout | undefined;
  private saving: Promise<void> = Promise.resolve();
  private readonly authorsSinceNotify = new Set<unknown>();
  private stopObserving: (() => void) | undefined;
  private started = false;
  private destroyed = false;
  private discarded = false;
  /** Encoded size at the last persist plus the bytes of updates applied since: an upper bound on the document size. */
  private storedBytes = 0;
  private pendingBytes = 0;
  onEmpty: () => void = () => {};

  constructor(
    readonly projectId: string,
    private readonly store: ProjectStore,
    private readonly limits: CollabLimits,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.awareness = new Awareness(this.doc);
    // The server has no presence of its own.
    this.awareness.setLocalState(null);
  }

  /** Attach listeners once the initial state is loaded so loading itself is not persisted or broadcast. */
  start() {
    if (this.started) return;
    this.started = true;
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.version++;
      this.plainStale = true;
      this.pendingBytes += update.byteLength;
      this.authorsSinceNotify.add(origin);
      this.markDirty();
      const data = frame(CHANNEL_SYNC, encodeUpdateMessage(update));
      for (const socket of this.sockets.keys())
        if (socket !== origin) this.sendBinary(socket, data);
    });
    this.stopObserving = observeProject(this.doc, () => this.schedulePlainNotify());
    this.awareness.on(
      "update",
      (
        change: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const member = this.memberOf(origin);
        if (member) {
          for (const id of change.added) member.awarenessIds.add(id);
          for (const id of change.removed) member.awarenessIds.delete(id);
        }
        const clients = [...change.added, ...change.updated, ...change.removed];
        if (!clients.length) return;
        const data = frame(
          CHANNEL_AWARENESS,
          encodeAwarenessMessage(this.awareness, clients),
        );
        for (const socket of this.sockets.keys())
          if (!member || socket !== member.socket) this.sendBinary(socket, data);
      },
    );
  }

  private memberOf(origin: unknown): Member | undefined {
    return typeof origin === "object" && origin !== null
      ? this.sockets.get(origin as RoomSocket)
      : undefined;
  }

  /** Repaired plain project; recomputed lazily so a cue inside the notify window still sees the latest document. */
  get project(): Project {
    if (!this.plainStale && this.cachedPlain) return this.cachedPlain;
    try {
      const { project, issues } = repairProject(
        toPlain(this.doc, this.plainCache),
        this.projectId,
      );
      if (issues.length && !this.repairWarned) {
        this.repairWarned = true;
        this.log.warn(
          `Project ${this.projectId} needed ${issues.length} repair(s): ${issues[0]}`,
        );
      }
      this.cachedPlain = project;
      this.plainStale = false;
      return project;
    } catch (error) {
      if (error instanceof RepairError && this.cachedPlain) {
        if (!this.repairWarned) {
          this.repairWarned = true;
          this.log.warn(
            `Project ${this.projectId} is not schema-valid after a merge: ${error.message}`,
          );
        }
        return this.cachedPlain;
      }
      throw error;
    }
  }

  /** Upper bound on the encoded document size right now. */
  get approximateBytes() {
    return this.storedBytes + this.pendingBytes;
  }
  /** Called once by the registry after the initial state is in the document. */
  recordLoadedBytes(bytes: number) {
    this.storedBytes = bytes;
    this.pendingBytes = 0;
  }
  /**
   * Refuses a write that would push the document past its size cap. Small updates are still accepted a little
   * past the cap so collaborators can delete content from a full project; nothing is accepted beyond that.
   */
  private admitWrite(bytes: number) {
    const cap = this.limits.maxDocBytes;
    const projected = this.approximateBytes + bytes;
    if (projected <= cap) return;
    if (bytes <= SMALL_UPDATE_BYTES && projected <= cap * OVERFLOW_TOLERANCE) return;
    throw new RoomError("document-full", fullMessage(this.limits));
  }
  /** An HTTP import may not grow a live room past the tolerance either; the exact size is measured at the next persist. */
  admitImport(bytes: number) {
    if (this.approximateBytes + bytes > this.limits.maxDocBytes * OVERFLOW_TOLERANCE)
      throw new RoomError("document-full", fullMessage(this.limits));
  }

  join(input: MemberInput) {
    if (this.destroyed) throw new RoomError("project-unreadable", "Room closed");
    if (this.sockets.size >= this.limits.maxRoomSockets)
      throw new RoomError(
        "room-full",
        "This project already has the maximum number of connected collaborators.",
      );
    if (this.evictTimer) {
      clearTimeout(this.evictTimer);
      this.evictTimer = undefined;
    }
    const member: Member = { ...input, awarenessIds: new Set() };
    this.sockets.set(input.socket, member);
    const step1 = encoding.createEncoder();
    writeSyncStep1(step1, this.doc);
    this.sendBinary(input.socket, frame(CHANNEL_SYNC, encoding.toUint8Array(step1)));
    const present = [...this.awareness.getStates().keys()];
    if (present.length)
      this.sendBinary(
        input.socket,
        frame(CHANNEL_AWARENESS, encodeAwarenessMessage(this.awareness, present)),
      );
    return member;
  }

  leave(socket: RoomSocket) {
    const member = this.sockets.get(socket);
    if (!member) return;
    this.sockets.delete(socket);
    if (member.awarenessIds.size)
      removeAwarenessStates(this.awareness, [...member.awarenessIds], null);
    if (this.sockets.size === 0 && !this.destroyed) {
      this.evictTimer = setTimeout(() => this.onEmpty(), this.limits.roomIdleMs);
      this.evictTimer.unref?.();
    }
  }

  /**
   * Sync step 1 (a state request) is answered for everyone. Step 2 and updates are writes: they are refused
   * for viewers (`read-only`) and when the document would exceed its size cap (`document-full`); neither is
   * applied, so peers never see a refused change.
   */
  handleSync(socket: RoomSocket, body: Uint8Array) {
    let messageType: number;
    try {
      messageType = decoding.readVarUint(decoding.createDecoder(body));
    } catch (error) {
      throw new RoomError("bad-frame", `Unreadable sync frame: ${(error as Error).message}`);
    }
    if (messageType !== messageYjsSyncStep1) {
      const member = this.sockets.get(socket);
      if (member && member.role !== "editor") {
        // A viewer's step 2 reply to our step 1 is empty when its replica holds nothing new; anything else is a write.
        if (!isEmptyWrite(body)) throw new RoomError("read-only", READ_ONLY_MESSAGE);
        return;
      }
      this.admitWrite(body.byteLength);
    }
    try {
      const decoder = decoding.createDecoder(body);
      const encoder = encoding.createEncoder();
      readSyncMessage(decoder, encoder, this.doc, socket);
      if (encoding.length(encoder) > 0)
        this.sendBinary(socket, frame(CHANNEL_SYNC, encoding.toUint8Array(encoder)));
    } catch (error) {
      throw new RoomError("bad-frame", `Unreadable sync frame: ${(error as Error).message}`);
    }
  }

  handleAwareness(socket: RoomSocket, body: Uint8Array) {
    if (body.byteLength > this.limits.awarenessMaxBytes)
      throw new RoomError("bad-frame", "Awareness frame too large");
    try {
      applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoding.createDecoder(body)),
        socket,
      );
    } catch (error) {
      throw new RoomError("bad-frame", `Unreadable awareness frame: ${(error as Error).message}`);
    }
  }

  sendBinary(socket: RoomSocket, data: Uint8Array) {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > this.limits.maxBufferedBytes) {
      socket.close(1013, "Client is too slow");
      return;
    }
    socket.send(data, { binary: true });
  }

  sendJson(socket: RoomSocket, message: ServerMessage) {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > this.limits.maxBufferedBytes) {
      socket.close(1013, "Client is too slow");
      return;
    }
    socket.send(JSON.stringify(message));
  }

  broadcastJson(message: ServerMessage, except?: RoomSocket) {
    for (const socket of this.sockets.keys())
      if (socket !== except) this.sendJson(socket, message);
  }

  /** Replace the document contents with an imported project; peers converge through the normal update path. */
  import(project: Project) {
    return applyDiff(this.doc, this.project, project, "import");
  }

  private schedulePlainNotify() {
    if (this.plainTimer || this.destroyed) return;
    this.plainTimer = setTimeout(() => {
      this.plainTimer = undefined;
      const authors = new Set(this.authorsSinceNotify);
      this.authorsSinceNotify.clear();
      for (const member of this.sockets.values())
        member.onPlain(authors.has(member.socket) ? "self" : "peer");
    }, PLAIN_NOTIFY_MS);
  }

  private markDirty() {
    if (this.discarded) return;
    const at = this.now();
    this.dirtySince ??= at;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const wait = Math.min(
      this.limits.saveDebounceMs,
      Math.max(0, this.limits.saveMaxWaitMs - (at - this.dirtySince)),
    );
    this.saveTimer = setTimeout(() => void this.flush(), wait);
  }

  get dirty() {
    return this.dirtySince !== null;
  }

  /** Force a write even when no update event marked the room dirty (initial seeding or migration). */
  persistNow(): Promise<void> {
    this.dirtySince ??= this.now();
    return this.flush();
  }

  /** Persist the document (authoritative) and the derived plain project; writes are serialized per room. */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.dirtySince === null || this.discarded) return this.saving;
    this.dirtySince = null;
    this.saving = this.saving.then(async () => {
      if (this.discarded) return;
      try {
        const update = Y.encodeStateAsUpdate(this.doc);
        // Measured synchronously with the encode so updates arriving during the write stay counted.
        this.storedBytes = update.byteLength;
        this.pendingBytes = 0;
        await this.store.saveUpdate(this.projectId, update);
        const parsed = ProjectSchema.safeParse(this.project);
        if (parsed.success) await this.store.save(parsed.data);
        else
          this.log.warn(
            `Project ${this.projectId} plain copy not written: ${parsed.error.issues[0]?.message}`,
          );
      } catch (error) {
        this.dirtySince ??= this.now();
        this.log.warn(`Project ${this.projectId} save failed: ${(error as Error).message}`);
      }
    });
    return this.saving;
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.evictTimer) clearTimeout(this.evictTimer);
    if (this.plainTimer) clearTimeout(this.plainTimer);
    await this.flush();
    this.stopObserving?.();
    this.awareness.destroy();
    this.doc.destroy();
  }

  /** Tear the room down without persisting (the project was deleted). In-flight writes finish first so no file reappears. */
  async discard() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.discarded = true;
    if (this.evictTimer) clearTimeout(this.evictTimer);
    if (this.plainTimer) clearTimeout(this.plainTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.dirtySince = null;
    await this.saving;
    this.stopObserving?.();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

/** True when a step 2 or update message carries no structs and no deletions. */
function isEmptyWrite(body: Uint8Array): boolean {
  try {
    const decoder = decoding.createDecoder(body);
    decoding.readVarUint(decoder);
    const { structs, ds } = Y.decodeUpdate(decoding.readVarUint8Array(decoder));
    return structs.length === 0 && ds.clients.size === 0;
  } catch {
    return false;
  }
}
function encodeUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}
function encodeAwarenessMessage(awareness: Awareness, clients: number[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(encoder);
}
function ensureDocId(doc: Y.Doc): string {
  const root = doc.getMap<unknown>(PROJECT_ROOT);
  let meta = root.get("meta");
  let id = meta instanceof Y.Map ? meta.get("docId") : undefined;
  if (typeof id === "string" && id) return id;
  id = randomUUID();
  doc.transact(() => {
    if (!(meta instanceof Y.Map)) {
      meta = new Y.Map<unknown>();
      root.set("meta", meta);
    }
    (meta as Y.Map<unknown>).set("docId", id);
  }, "load");
  return id as string;
}

export type JoinRequest = {
  projectId: string;
  seed?: Project;
  /** Edit token; decides the member's role. Required when `seed` creates the project. */
  token?: string;
  /** Client key (normally the IP address) for per-client creation limits. */
  client?: string;
};
export type CreateOptions = { token?: string; client?: string };

/** Loads, caches and evicts rooms; one instance per server process. */
export class RoomRegistry {
  private readonly rooms = new Map<string, DocRoom>();
  private readonly loading = new Map<string, Promise<DocRoom>>();
  private readonly evicting = new Map<string, Promise<void>>();
  private created: number[] = [];
  private readonly clientCreations: KeyedWindow;
  constructor(
    private readonly store: ProjectStore,
    readonly limits: CollabLimits,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.clientCreations = new KeyedWindow(limits.projectsCreatedPerHourPerClient, 3_600_000, now);
  }

  get size() {
    return this.rooms.size;
  }
  peek(projectId: string) {
    return this.rooms.get(projectId);
  }

  async join(request: JoinRequest, member: Omit<MemberInput, "role">): Promise<DocRoom> {
    const id = request.projectId;
    if (!ID.test(id)) throw new RoomError("project-not-found", "Invalid project ID");
    await this.evicting.get(id);
    let room = this.rooms.get(id);
    if (!room) {
      if (this.rooms.size >= this.limits.maxRooms) await this.evictIdle();
      if (this.rooms.size >= this.limits.maxRooms)
        throw new RoomError("rooms-full", "The server is hosting its maximum number of projects.");
      room = await (this.loading.get(id) ?? this.load(id, request));
    }
    room.join({ ...member, role: roleFor(id, room.access, request.token) });
    return room;
  }

  private load(id: string, request: JoinRequest): Promise<DocRoom> {
    const pending = (async () => {
      const room = new DocRoom(id, this.store, this.limits, this.log, this.now);
      const update = await this.store.loadUpdate(id);
      let migrated = false;
      if (update) {
        Y.applyUpdate(room.doc, update, "load");
        room.recordLoadedBytes(update.byteLength);
        room.access = await this.store.loadAccess(id);
        if (await this.store.jsonNewerThanUpdate(id))
          this.log.warn(
            `Project ${id}: the plain file is newer than the document and was ignored; import it with PUT to apply it.`,
          );
      } else {
        const json = await this.loadJsonOrThrow(id);
        if (json) {
          fromPlain(room.doc, json, "load");
          room.access = await this.store.loadAccess(id);
        } else if (request.seed) {
          const parsed = ProjectSchema.safeParse(request.seed);
          if (!parsed.success || parsed.data.id !== id)
            throw new RoomError("invalid-seed", "The seed project is invalid or has a different ID.");
          if (!isUsableToken(request.token))
            throw new RoomError("invalid-seed", "A new project needs an edit token of at least 16 characters.");
          fromPlain(room.doc, parsed.data, "load");
          this.admitSize(Y.encodeStateAsUpdate(room.doc).byteLength);
          this.admitCreation(request.client);
          room.access = accessRecord(request.token, this.now);
          await this.store.saveAccess(id, room.access);
        } else if (id === DEMO_PROJECT_ID) fromPlain(room.doc, createDemoProject(), "load");
        else throw new RoomError("project-not-found", "Project not found");
        room.recordLoadedBytes(Y.encodeStateAsUpdate(room.doc).byteLength);
        migrated = true;
      }
      room.docId = ensureDocId(room.doc);
      try {
        room.project;
      } catch (error) {
        throw new RoomError("project-unreadable", (error as Error).message);
      }
      room.start();
      if (migrated) {
        // A project that only existed as plain JSON (or was just seeded) gets its document written promptly.
        await room.persistNow();
      }
      room.onEmpty = () => this.evict(id);
      this.rooms.set(id, room);
      return room;
    })();
    this.loading.set(id, pending);
    return pending.finally(() => this.loading.delete(id));
  }

  private async loadJsonOrThrow(id: string): Promise<Project | null> {
    try {
      return await this.store.loadJson(id);
    } catch (error) {
      throw new RoomError(
        "project-unreadable",
        `Project ${id} could not be read; the file was preserved. ${(error as Error).message}`,
      );
    }
  }

  private admitSize(bytes: number) {
    if (bytes > this.limits.maxDocBytes)
      throw new RoomError("document-full", fullMessage(this.limits));
  }

  private admitCreation(client?: string) {
    const at = this.now();
    this.created = this.created.filter((t) => at - t < 3_600_000);
    if (this.created.length >= this.limits.projectsCreatedPerHour)
      throw new RoomError("project-limit", "Too many projects were created recently. Try again later.");
    if (client !== undefined && !this.clientCreations.allow(client))
      throw new RoomError("project-limit", "You have created too many projects recently. Try again later.");
    this.created.push(at);
  }

  private evict(id: string) {
    const room = this.rooms.get(id);
    if (!room || room.sockets.size) return;
    this.rooms.delete(id);
    const done = room.destroy().finally(() => this.evicting.delete(id));
    this.evicting.set(id, done);
  }

  private async evictIdle() {
    const idle = [...this.rooms.values()].filter((room) => room.sockets.size === 0);
    for (const room of idle) this.evict(room.projectId);
    await Promise.all([...this.evicting.values()]);
  }

  /** Plain project for HTTP readers: the live room, else the stored document, else the plain file. */
  async readPlain(id: string): Promise<Project | null> {
    if (!ID.test(id)) throw new Error("Invalid project ID");
    const live = this.rooms.get(id);
    if (live) return live.project;
    const update = await this.store.loadUpdate(id);
    if (update) {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, update, "load");
        return repairProject(toPlain(doc), id).project;
      } finally {
        doc.destroy();
      }
    }
    return this.store.loadJson(id);
  }

  /** Role an HTTP caller has on a project, or null when the project does not exist. */
  async authorize(id: string, token: unknown): Promise<CollabRole | null> {
    if (!ID.test(id)) return null;
    const live = this.rooms.get(id);
    if (live) return roleFor(id, live.access, token);
    if (id === DEMO_PROJECT_ID) return "viewer";
    if (!(await this.store.exists(id))) return null;
    return roleFor(id, await this.store.loadAccess(id), token);
  }

  /** Create a new project on disk without opening a room; returns the edit token exactly once. */
  async createProject(project: Project, options: CreateOptions = {}): Promise<{ editToken: string }> {
    if (await this.store.exists(project.id))
      throw new RoomError("project-exists", "A project with this ID already exists.");
    const editToken = options.token ?? mintEditToken();
    if (!isUsableToken(editToken))
      throw new RoomError("invalid-seed", "An edit token needs at least 16 characters.");
    const doc = new Y.Doc();
    try {
      fromPlain(doc, project, "load");
      ensureDocId(doc);
      const update = Y.encodeStateAsUpdate(doc);
      this.admitSize(update.byteLength);
      this.admitCreation(options.client);
      await this.store.saveAccess(project.id, accessRecord(editToken, this.now));
      await this.store.saveUpdate(project.id, update);
      await this.store.save(repairProject(toPlain(doc), project.id).project);
    } finally {
      doc.destroy();
    }
    return { editToken };
  }

  /** Import into a live room (peers converge) or onto disk. Never discards an existing document history. */
  async importProject(project: Project): Promise<"room" | "document" | "created"> {
    const probe = new Y.Doc();
    let importBytes: number;
    try {
      fromPlain(probe, project, "load");
      importBytes = Y.encodeStateAsUpdate(probe).byteLength;
    } finally {
      probe.destroy();
    }
    const live = this.rooms.get(project.id);
    if (live) {
      live.admitImport(importBytes);
      live.import(project);
      await live.flush();
      return "room";
    }
    const update = await this.store.loadUpdate(project.id);
    const doc = new Y.Doc();
    try {
      if (update) {
        Y.applyUpdate(doc, update, "load");
        applyDiff(doc, repairProject(toPlain(doc), project.id).project, project, "import");
      } else fromPlain(doc, project, "load");
      ensureDocId(doc);
      const encoded = Y.encodeStateAsUpdate(doc);
      this.admitSize(encoded.byteLength);
      await this.store.saveUpdate(project.id, encoded);
      await this.store.save(repairProject(toPlain(doc), project.id).project);
      return update ? "document" : "created";
    } finally {
      doc.destroy();
    }
  }

  /**
   * Remove a project: connected sockets are told and closed, the room is discarded without a final write,
   * and every file is deleted. Deleting the demo resets it to the built-in project on the next join.
   */
  async deleteProject(id: string): Promise<boolean> {
    if (!ID.test(id)) throw new Error("Invalid project ID");
    await this.loading.get(id)?.catch(() => undefined);
    await this.evicting.get(id);
    const live = this.rooms.get(id);
    if (live) {
      this.rooms.delete(id);
      for (const socket of [...live.sockets.keys()]) {
        live.sendJson(socket, { type: "error", code: "project-deleted", message: "This project was deleted." });
        socket.close(4003, "Project deleted");
      }
      await live.discard();
    }
    const existed = await this.store.deleteProject(id);
    return existed || !!live;
  }

  async closeAll() {
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    await Promise.all(rooms.map((room) => room.destroy()));
    await Promise.all([...this.evicting.values()]);
  }
}
