# Security and abuse prevention

Updated: 12 October 2026. Owner: root. This document describes the controls that exist in the code, the
assumptions behind them, and what they do not cover. Every control here is implemented and verified locally
(see "Verification" at the end); the public deployment has not run yet, so nothing below is proof that the
hosted instance is configured correctly. Treat the deployment checklist as a hard requirement.

## Threat model

Vizli is a public, account-free web app with paid provider keys on the server. Visitors include judges and
anyone who finds the URL. One container holds every room in memory; inference runs on Nebius Token Factory
and NVIDIA's hosted ASR under the operator's keys.

Assets, in order of importance:

1. The provider budget and the server's availability: one abusive visitor must not lock everyone else out.
2. Project content: a stranger must not be able to vandalise a presentation they were only shown.
3. Viewers' privacy: opening a link must not reveal a visitor's address to third parties, and microphone
   audio must only leave the device with consent.
4. Secrets: provider keys and the admin token never reach a client, a log line or the repository.

Out of scope: authenticated identities and per-user quotas (deferred, see `docs/STATUS-PENDING.md`), abuse by
someone who holds an edit link (they are a trusted collaborator by definition), volumetric attacks beyond what
one process can absorb (the hosting platform's job), and content moderation (nothing in the app judges text
or images; the operator can wipe a project).

## Access model: links are capabilities

There are no accounts. Two secrets govern a project:

| Capability | Form | Grants | Where it lives |
| --- | --- | --- | --- |
| Project id | `p-` plus 16 hex characters (64 random bits), e.g. `/p/p-0123456789abcdef` | Read: open the project, follow live changes, see presence | The URL; `<id>.yjs` / `<id>.json` on the server |
| Edit token | 24 random bytes, base64url (32 characters) | Write: edit, ink, cue, narrate, import over HTTP | Browser `localStorage['vizli.edit.v1']`; only its SHA-256 on the server in `<id>.access.json` |

Rules the server enforces (`apps/server/src/collab/access.ts`, `rooms.ts`, `app.ts`):

- Every socket joins with a role. `joined.role` is `editor` when `join.token` matches the project's stored
  hash, otherwise `viewer`. The shared demo `/p/default` is always `viewer`. Projects created before access
  records existed (no `<id>.access.json`) are open to everyone; convert one by creating a new project from its
  JSON (`POST /api/projects` with `project`) and sharing the new link.
- Viewers receive sync step 1/2, awareness and effects. Any write (a non-empty sync step 2 or update) is
  refused with `error {code: "read-only"}`, is never applied, and closes the socket with code 4004
  (`CLOSE_WRITE_REFUSED`). Cues and microphone requests from viewers are refused with the same error code but
  keep the socket open. Viewers' awareness (cursor, name) is relayed like anyone else's.
- HTTP: `GET /api/projects/:id` needs only the id. `POST /api/projects` creates a project and returns
  `{id, editToken}` exactly once. `PUT /api/projects/:id` needs `Authorization: Bearer <editToken>` (or the
  admin token) and never creates projects. `DELETE /api/projects/:id` needs the admin token.
- A join that creates a project from a `seed` must carry the token the client minted for it; the server
  stores the hash and the client becomes the editor.
- Tokens are compared in constant time against the stored hash; a project's token cannot be recovered from
  the server. There is no rotation: to revoke access, create a new project from the current content and
  delete the old one.

On the client (`apps/web/src/collab/access.ts`, `useCollabDoc.ts`, `PresenceBar.tsx`):

- Edit links are `/p/<id>#edit=<token>`. The fragment never reaches the server or its logs; the app stores
  the token and removes the fragment from the address bar. View links are plain `/p/<id>`.
- Editors see two share buttons (edit link, view-only link). Viewers see a "View only" pill, a disabled cue
  box, no ink or add controls, and "Make a copy", which posts the current snapshot as a new project owned by
  that browser and navigates to it. `/` creates a personal copy for a new visitor; nobody edits the demo.
- A viewer's local replica is discarded on join when it holds edits made while disconnected, and any replica
  is discarded after a refused write, because Yjs updates depend on earlier ones: once the server refuses an
  update, nothing later from that replica could ever apply. The person loses that one change (and any other
  unsynced local change) and sees the server's state again.

## Per-client limits

All limits are per server process and reset on restart. The ones below key on the client address so one
visitor cannot drain the shared budgets; the shared ones from before still apply on top.

| Variable | Default | Scope | Effect when exceeded |
| --- | --- | --- | --- |
| `MAX_LLM_REQUESTS_PER_HOUR_PER_CLIENT` | 120 | client | model calls refused with "Your hourly AI request limit" (cues skip, `POST /api/scenes/generate` 429) |
| `MAX_CONCURRENT_LLM_REQUESTS_PER_CLIENT` | 2 | client | "You already have AI requests in progress" |
| `MAX_CONCURRENT_VOICE_SESSIONS_PER_CLIENT` | 2 | client | microphone refused |
| `MAX_SOCKETS_PER_CLIENT` | 16 | client | new `/api/session` sockets closed with 4001; the client retries after 30 s |
| `MAX_PROJECTS_CREATED_PER_HOUR_PER_CLIENT` | 20 | client | `POST /api/projects` 429, seeded joins `project-limit` |
| `SOCKET_JOIN_TIMEOUT_MS` | 15000 | socket | a socket that has not joined is closed with 4002 |
| `MAX_LLM_REQUESTS_PER_HOUR`, `MAX_CONCURRENT_LLM_REQUESTS`, `MAX_CONCURRENT_VOICE_SESSIONS`, `MAX_VOICE_SECONDS_PER_SESSION` | 1200, 3, 5, 600 | shared | as before (`docs/BACKEND.md`) |
| `MAX_PROJECTS_CREATED_PER_HOUR`, `MAX_ROOMS`, `MAX_ROOM_SOCKETS`, sync and awareness rates | see `.env.example` | shared | as before (`docs/COLLAB.md`) |
| cues per socket | 10 per 2 s | socket | cue skipped |

The client key is `request.ip`. Behind a reverse proxy that is the proxy's address unless `TRUST_PROXY` is
set: an integer trusts that many `X-Forwarded-For` hops (`1` behind one managed HTTPS proxy, which is what
`deploy/nebius/deploy-endpoint.sh` sets), `true` trusts every entry (a client can then choose its own key by
sending the header). Without it every visitor shares one bucket and the per-client limits become global ones.
Visitors behind one NAT or VPN exit share a key by design.

## Shared document size

`COLLAB_MAX_DOC_BYTES` (default 32 MiB) bounds each project's encoded Yjs document. The room tracks the size
at its last persist plus the bytes of updates applied since (an upper bound); a write that would pass the cap
is refused with `error {code: "document-full"}` and closes the socket with 4004, exactly like a viewer's
write. Updates of at most 1 KiB are still accepted up to 25% past the cap so a full project can be cleaned
up (deleting content shrinks the document after Yjs garbage collection). `POST` and `PUT` bodies that would
exceed the cap return 413. Awareness frames above `COLLAB_AWARENESS_MAX_BYTES` (16 KiB) count as unreadable
frames. Ink tombstones and embedded images are the usual reasons a document grows.

## Browser hardening

Every response carries, from `apps/server/src/app.ts`:

- `Content-Security-Policy`: `default-src 'self'`; scripts only from this origin; styles from this origin,
  inline (React and KaTeX set style attributes) and Google Fonts; fonts from this origin, data URLs and
  Google Fonts; images from this origin, data URLs and the two Wikimedia hosts the image search returns;
  connections to this origin (its `ws://`/`wss://` form spelled out for older browsers) plus `CSP_CONNECT_SRC`
  entries such as a Supabase URL; `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`,
  `form-action 'self'`. The Vite dev server serves its own HTML without this header; the built app gets it.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (so project
  URLs never leak in a Referer, including to Wikimedia image loads), `Permissions-Policy` allowing only the
  microphone for this origin, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`.
- `Strict-Transport-Security` once a trusted proxy reports HTTPS (`X-Forwarded-Proto`), never over plain HTTP.

Images: the scene schema still accepts any http(s) `src` so older projects stay valid, but clients only load
embedded data URLs and `https://upload.wikimedia.org` / `thumb.wikimedia.org` (`isAllowedImageSource` in
`packages/shared`). Anything else renders as a labelled placeholder without a network request, the inspector
explains why, and the image dialog refuses other hosts. Loading arbitrary remote images would hand every
viewer's address to whoever controls the URL.

Rendering: React escapes all text. The only raw HTML sink is KaTeX output rendered with `trust: false`.
`pnpm audit --prod` reports no known vulnerabilities after the upgrades to `@fastify/static` 10.1.6 and
`katex` 0.19.0 on 12 October 2026.

Origins: `ALLOWED_ORIGINS` is an exact allowlist; browser requests and WebSocket upgrades from any other
origin get 403, and cross-site mutations are rejected via `Sec-Fetch-Site`. Requests without an Origin header
(scripts, curl) pass: this is CSRF protection, not authentication; the edit token is the authentication.

## Model and provider safety

- Model output is constrained three times: provider-side strict JSON schema, Zod, then semantic grounding
  (targets must exist in the live scene, plugin ids must be built in, no URLs or images from the model,
  generated scenes may not contain images, hidden objects or out-of-bounds placement, ids are re-minted).
- The model has no tools, no fetch and no code execution. The only outbound request besides inference is the
  Wikimedia Commons search at a fixed endpoint with query text; returned URLs are checked against a Commons
  hostname allowlist. No server-side request forgery path exists.
- System prompts mark speech and scene labels as untrusted. A collaborator can still put instructions in a
  label that another presenter's cue sees as context; the worst case is a wrong but schema-valid, visible,
  undoable action.
- Prompts omit image data and source metadata. Failed provider calls still count against the hourly budget.

## Privacy

- Microphone audio streams to NVIDIA's hosted Nemotron ASR; transcripts plus the labels of the current scene
  go to Nemotron on Nebius Token Factory. The first microphone start in a browser shows a consent dialog that
  says so (`vizli.micConsent.v1` remembers the acknowledgement). Vizli never records or stores audio;
  transcripts are not persisted. Collaborators receive actions and effects, never audio or transcripts.
- Request logs redact project ids (`/api/projects/[id]`, `/p/[id]`); room-level warnings still name the
  project they concern, and log access must be restricted because a project id is a read capability.
- The server stores, under `DATA_DIR`: the Yjs document, the derived JSON, and the hashed edit token.
  Presence (name, colour, cursor, camera, mode) is relayed live and never stored.
- Names and colours are self-declared labels, not identities.

## Operations

- `ADMIN_TOKEN` enables `DELETE /api/projects/:id` with `Authorization: Bearer <token>`: connected sockets
  receive `error {code: "project-deleted"}` and are closed with 4003 (clients stay closed instead of
  reconnecting), the room is dropped without a final write, and `<id>.yjs`, `<id>.json` and
  `<id>.access.json` are removed. Deleting `default` resets the demo to the built-in project on the next
  join. Without `ADMIN_TOKEN` the route answers 403 and nothing can be deleted remotely.
- Reset the demo: `curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/api/projects/default`.
- Wipe a vandalised or abusive project the same way with its id; the people on it are disconnected at once.

Deployment checklist (all required for the public URL):

1. `NEBIUS_API_KEY`, `NVIDIA_API_KEY` and `ADMIN_TOKEN` supplied as platform secrets, never baked into the
   image; `.env` and `.data` are excluded from the image and the repository.
2. `ALLOWED_ORIGINS` set to the exact public origin.
3. `TRUST_PROXY=1` (one managed proxy hop) so per-client limits and HSTS see real visitors; verify with
   `/api/status` from two networks that they get separate socket caps.
4. `HOST=0.0.0.0`, the usage and collaboration limits from `.env.example` reviewed for the expected audience.
5. `pnpm audit --prod` clean, `pnpm check:hackathon` passing, and a live cue through the deployed app.
6. Restrict who can read platform logs.

## Known gaps

- No accounts, no per-person quotas, no token rotation or expiry; an edit link, once shared, is shared.
- No content moderation. Offensive text or images on a project reach everyone on that link; the remedy is the
  admin delete.
- Per-client limits key on the network address: shared NATs share a bucket, and a visitor with many addresses
  has many buckets. Limits are per process, so several instances multiply them.
- A refused write discards the offending replica's unsynced changes, not only the refused one.
- `style-src` allows inline styles; a script injection would still be stopped by `script-src 'self'`.
- Read requests (`GET /api/projects/:id`, static files) have no per-client rate limit beyond the platform's.
- The Supabase cloud path keeps its own RLS model and has never been exercised live.
- The hosted deployment itself, `TRUST_PROXY` behaviour behind the Nebius proxy, and WebSocket upgrades
  through the managed URL are unverified until the first deploy.

## Verification

Recorded in `docs/STATUS.md` under "Access control and abuse prevention, 12 October 2026", with the exact
commands and counts. Unit coverage: `apps/server/src/security.test.ts` (headers and CSP, HSTS behind a proxy,
log redaction and `TRUST_PROXY` parsing, viewer refusals over the socket, document size cap with POST/PUT
413, oversized awareness frames, join timeout, per-client socket cap with and without a trusted proxy,
per-client creation cap, admin deletion and its absence), `collab/rooms.test.ts` (token hashing, roles for
tokens, viewers, the demo and legacy files, refused viewer writes, size cap tolerance, deletion),
`usage.test.ts` (per-client before shared budgets), `collab/limits.test.ts` (keyed windows, connection
table, env parsing), and `tests/collab.spec.ts` in the browser (edit and view links, view-only mode, live
following, "Make a copy"), plus the narrow-viewport check for viewer mode in `tests/workspace.spec.ts`.
