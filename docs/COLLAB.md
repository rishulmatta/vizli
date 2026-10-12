# Real-time collaboration

Owner: root. Implementation: `packages/shared/src/ydoc.ts`, `apps/server/src/collab/`, `apps/web/src/collab/`.

## Model

One shared Yjs document per project. Every browser holds a replica, edits it locally, and the server relays updates between the replicas in a project room. Conflicts merge per field with last-writer-wins for scalars; arrays of objects, connections, areas and ink strokes merge by id. The strict zod schemas remain the contract for exports, the HTTP project API and the voice session: every reader runs `repairProject` on the plain snapshot so a merged document is always schema-valid (dangling connections, duplicate ids, ragged matrix rows, anchors to removed charts and over-cap collections are repaired deterministically on read, never written back).

Not in the document: the whiteboard camera (`viewport`) and `activeAreaId`, which are per-user view state kept in `localStorage['vizli.view.<projectId>']`. Shared named `areas` are in the document.

Chosen over a custom server-ordered operation log on 12 October 2026 because the sync engine, reconnect, offline buffering, per-user undo and presence are proven library code.

## Document shape

`doc.getMap('project')`: `id`, `title`, `updatedAt`, `meta {schema: 1, docId}`, `scenes: Y.Array<Y.Map>`, `cues: Y.Array<plain>`. A scene map has scalar leaves (`id`, `title`, `subtitle`, `kind`, `layout`), a plain `lesson`, and Y.Arrays `areas` (Y.Maps), `objects` (Y.Maps), `connections` (Y.Maps) and `ink` (immutable plain strokes). An object map stores every schema field as a leaf; `cells`, `data`, `labels`, `anchor`, `imageSource`, `aliases`, `derivedFrom` and plugin payloads are whole-value leaves because they are edited and validated as units. `text` is a plain string (last writer wins), not `Y.Text`, because the inspector commits per keystroke without a bound editor and character merges inside LaTeX produce markup nobody typed. Nothing stores `undefined`.

Shared helpers: `fromPlain` seeds an empty document; `toPlain` derives a snapshot with deterministic key order and per-scene structural sharing; `applyDiff(doc, base, next, origin)` writes only the fields that differ between `base` and `next` (three-way, id-keyed, one transaction, no transaction when nothing differs); `repairProject`; `observeProject` reports the touched scenes and sections once per transaction; `canonicalScene`/`canonicalProject` give order-independent JSON for equality checks. `base` must be the exact snapshot `next` was derived from: an older base is harmless, a newer one would overwrite a peer's edit.

## Wire protocol (one socket, `/api/session`)

Text frames are the existing JSON messages. The old `scene` snapshot message is gone; the strict union rejects it. Added: `join {projectId, userId, clientId, name, color, sceneId?, seed?, token?}` and `view {sceneId}`. Server additions: `joined {projectId, docId, version}`, `effect {action, clientId, name}` (a peer's transient attention), `error {message, code?}`.

Binary frames carry a varuint channel prefix:

| Channel | Payload | Direction |
| --- | --- | --- |
| 0 | y-protocols sync message (step 1, step 2, update) | both |
| 1 | `writeVarUint8Array(encodeAwarenessUpdate(...))` | both |
| 2 | raw PCM16 audio for speech recognition | client → server |

Join flow: `ready` → `join` → `joined` → the server sends sync step 1 and the current awareness states → the client sends its step 1 → both sides exchange step 2 → updates flow as they happen. Messages other than `join` before a successful join are answered with `error{code:'not-joined'}`; binary frames before join are dropped.

Error codes: `not-joined`, `already-joined`, `project-not-found`, `project-unreadable`, `invalid-seed`, `project-limit`, `rooms-full`, `room-full`, `bad-frame`.

## Rooms (`apps/server/src/collab/rooms.ts`)

`RoomRegistry.join` dedupes concurrent loads and waits for an in-progress eviction. Load order: `<id>.yjs` (authoritative) → `<id>.json` migrated through `fromPlain` and persisted as `.yjs` within a second → `join.seed` when it is schema-valid and carries the same id (bounded by the hourly creation cap) → the demo project for `default` → `project-not-found`. A `docId` is stored in `meta` at creation and returned in `joined` so a client can discard a cached replica from a different history (the Nebius container wipes `.data` on restart).

`DocRoom` relays every applied update to all sockets except its author, rebroadcasts awareness changes, records which awareness client ids each socket introduced and removes them when it leaves, and keeps a lazily repaired plain `project` for the voice sessions and HTTP. Members are told `self` or `peer` about 50 ms after a change so the session can keep interpreting through a peer's edit while a self edit resets it as before. Slow clients are closed with 1013 when their socket buffer exceeds the limit instead of queueing. Rooms evict after `COLLAB_ROOM_IDLE_MS` without sockets, after a final flush; `preClose` flushes every room.

Persistence: writes are debounced (`COLLAB_SAVE_DEBOUNCE_MS`) with a max wait (`COLLAB_SAVE_MAX_WAIT_MS`), serialized per room; `<id>.yjs` is the full encoded state (tombstones are the only growth), then `<id>.json` is derived through repair and the schema for `GET /api/projects/:id`, export and backups. A plain file newer than the document is ignored with a warning; use `PUT /api/projects/:id` to import it, which applies a diff into the live room or the stored document rather than replacing history.

HTTP: `GET /api/projects/:id` (live room, stored document, or plain file; 404 except `default`), `POST /api/projects` creates a project with a server-generated id, `PUT /api/projects/:id` imports.

## Limits (`apps/server/src/collab/limits.ts`, env)

| Variable | Default | Effect |
| --- | --- | --- |
| `MAX_ROOMS` | 100 | idle rooms are evicted first, then `rooms-full` |
| `MAX_ROOM_SOCKETS` | 8 | `room-full` |
| `COLLAB_ROOM_IDLE_MS` | 60000 | eviction after the last socket leaves |
| `COLLAB_SAVE_DEBOUNCE_MS` / `COLLAB_SAVE_MAX_WAIT_MS` | 1000 / 5000 | persistence cadence |
| `MAX_PROJECTS_CREATED_PER_HOUR` | 200 | seeds and `POST` |
| `COLLAB_SYNC_BYTES_PER_SECOND` / `COLLAB_SYNC_MAX_MESSAGE_BYTES` | 2 MB / 10 MB | over the rate closes 1008, over the size closes 1009 (never a silent drop) |
| `COLLAB_AWARENESS_PER_SECOND` | 30 | excess awareness frames are dropped |
| `COLLAB_MAX_BUFFERED_BYTES` | 16 MB | slow-client disconnect threshold |

Voice budgets, LLM limits and cue bursts stay per socket and unchanged.

## Voice session

`VisualSession` reads the scene through a `ProjectSource` (the room) instead of client snapshots: `attach(source, sceneId)`, `view(sceneId)`, `sync('self' | 'peer')`. A self content edit resets interpretation as before unless it is owned by a running narrated sequence (ownership is recorded by object id at dispatch, replacing the former SHA-256 snapshot fingerprints). A peer edit never aborts interpretation; it only invalidates dispatched actors whose target vanished. Before dispatch, a proposal is revalidated against the live scene and skipped with "The scene changed while I was interpreting that; say it again." when it no longer applies. Attention actions reach the requester as `action` and every peer as `effect`; only the requester acknowledges. Persistent actions (add, edit, move, reveal, sequences) are applied by the requesting client through its normal commit, so they are undoable by that user; the server does not write them into the document in this phase.

## Client (`apps/web/src/collab/`)

`transport.ts` owns the socket and reconnect; `provider.ts` speaks the sync and awareness protocols over it; `useCollabDoc` exposes the repaired plain project through `useSyncExternalStore`, `commit(next, {base})`, a `Y.UndoManager` tracking only this replica's `LocalOrigin` transactions (one step per gesture, keystrokes within 800 ms merge, one step per narrated sequence), and the connection status. `y-indexeddb` caches the replica so a project renders immediately and offline edits reconcile on reconnect. Identity: `vizli.identity.v1` (user id, name, color) plus a per-tab client id. Projects are addressed as `/p/<id>`; `/` redirects to the cached project or creates a new one; `/p/default` is the shared demo.

## Known limits

- Two people editing the same text field at once: the later edit wins whole.
- Array order is not merged; moving an item is delete plus insert, and undoing a move recreates it.
- Over-cap objects or strokes stay in the document but are hidden by repair until deletions expose them.
- Anyone with a project link can edit it; there is no authentication (`join.token` and the identity hooks are the seam for it).
- A single server process holds every room in memory; embedded data-URL images make rooms large.

## Verification

Recorded in `docs/STATUS.md` under the collaboration entry; do not treat anything here as verified unless it is listed there.
