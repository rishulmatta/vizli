<p align="center">
  <img src="docs/brand/vizli-logo.png" alt="Vizli" width="380">
</p>

<p align="center">
  <strong>Visual explanations that follow your voice.</strong><br>
  Speak, and the canvas points, highlights, draws and edits. Editable slides and infinite whiteboards,<br>
  powered by <strong>NVIDIA Nemotron</strong> on <strong>Nebius Token Factory</strong>.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-173f35?style=flat-square"></a>
  <a href="docs/HACKATHON.md"><img alt="Nebius x NVIDIA Global AI Hackathon" src="https://img.shields.io/badge/Nebius%20x%20NVIDIA-Best%20Apps%20%26%20Agents-4f7a52?style=flat-square"></a>
  <img alt="Nemotron 3 Super on Token Factory" src="https://img.shields.io/badge/model-Nemotron%203%20Super-8fa17a?style=flat-square">
  <img alt="Node 24+" src="https://img.shields.io/badge/node-%E2%89%A524-244d3c?style=flat-square">
  <img alt="pnpm 12" src="https://img.shields.io/badge/pnpm-12-244d3c?style=flat-square">
  <img alt="Tests" src="https://img.shields.io/badge/tests-93%20unit%20%C2%B7%2023%20browser-4f7a52?style=flat-square">
</p>

<p align="center">
  <a href="#run-locally">Run locally</a> ·
  <a href="#how-vizli-uses-nvidia-nemotron-and-nebius-token-factory">How it uses Nemotron</a> ·
  <a href="#narrate-a-matrix-multiplication-lesson">Narrated lesson</a> ·
  <a href="docs/STATUS.md">Status</a> ·
  <a href="docs/STATUS-PENDING.md">Pending work</a> ·
  <a href="docs/HACKATHON.md">Hackathon</a>
</p>

<p align="center">
  <img src="docs/screenshots/hero-marketing.png" alt="Vizli marketing scene after the spoken cue “Point to revenue”" width="920">
</p>

## What it does

Vizli is a presentation studio for people who explain things out loud: teachers, presenters, e-learning authors and anyone thinking at a whiteboard. Every scene is editable JSON with stable object and part IDs, so a spoken sentence can land on exactly the right bar, matrix row or diagram node.

| Say it | Vizli does it |
| --- | --- |
| “Point to revenue” · “Highlight the second row of matrix A” | A red pointer or highlight lands on that exact object or part. |
| “Reveal the takeaway” · “Animate matrix A with draw effect” | Prepared content appears on cue; motion presets play and can be cancelled. |
| “Make matrix A 3 by 2” · “Change Revenue to $4.5M” | The object is edited in place, atomically, with one undo step. |
| “Draw a software architecture” · “Let's go right” · “Go to Start” | Nemotron plans editable objects onto the whiteboard; the camera travels and returns. |
| “An apple on the x axis” | A sourced Wikimedia image is placed on the chart axis with attribution. |
| “A is three by two and B is two by three…” | A narrated matrix-multiplication lesson draws itself step by step. |

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/hero-matrix.png" alt="Matrix lesson with a highlighted row"></td>
    <td width="50%"><img src="docs/screenshots/whiteboard.png" alt="Expanding whiteboard with an architecture diagram"></td>
  </tr>
  <tr>
    <td align="center"><sub>Addressable matrices, equations and plugin parts</sub></td>
    <td align="center"><sub>Infinite whiteboard with named areas and a persistent camera</sub></td>
  </tr>
</table>

Listening and animation are separate lifecycles: the microphone keeps working while a lesson plays, ambiguous cues skip instead of guessing, and every action is fenced by the scene revision it was made for. Without credentials the app runs in a clearly labelled demo mode that performs no model inference.

## How Vizli uses NVIDIA Nemotron and Nebius Token Factory

Built for the Nebius x NVIDIA Global AI Hackathon, **Best Apps and Agents** track. Project work began in October 2026, inside the submission period.

Vizli is **Nemotron-first**: in live mode every final spoken or typed cue is decided by a Nemotron model on Nebius Token Factory before any rule runs, and three Nemotron tiers share the work the way the track describes it.

```
microphone ──▶ NVIDIA-hosted Nemotron ASR ──▶ transcript
                                                 │
                         ┌───────────────────────▼───────────────────────┐
                         │  FAST · Nemotron 3 Nano on Token Factory       │
                         │  classifies intent, repairs the transcript,    │
                         │  declines tentative speech (every final cue)   │
                         └──────┬───────────────────────────┬────────────┘
                                │ grounded by a trusted tool │ no tool matches
          ┌─────────────────────▼──────────┐    ┌───────────▼─────────────────────────┐
          │ deterministic planners          │    │ CORE · Nemotron 3 Super              │
          │ matrix lesson · targets · edits │    │ free-form visual action, strict JSON │
          │ camera · images                 │    │ scene & illustration planning        │
          └─────────────────────┬──────────┘    └───────────┬─────────────────────────┘
                                │   lesson with no planner   │
                                │  ┌─────────────────────────▼──────────┐
                                │  │ REASONING · Nemotron 3 Ultra         │
                                │  │ authors a lesson plan → compiled and │
                                │  │ validated into presentation steps    │
                                │  └─────────────────────────┬──────────┘
                                ▼                            ▼
                    validated VisualAction (with `served`: model, tier, latency) ──▶ canvas
```

| Tier | Model on Token Factory | What it does in Vizli | Measured p50 (12 Oct 2026) |
| --- | --- | --- | --- |
| Fast | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | Routes every cue (`apps/server/src/intent.ts`): picks the grounding tool, repairs ASR errors, skips hedged speech, flags lesson requests | 1.13 s |
| Core | `nvidia/nemotron-3-super-120b-a12b` | Free-form visual actions under a strict JSON Schema (`resolver.ts`); scene and illustration planning (`generate.ts`) | 1.48 s |
| Reasoning | `nvidia/Nemotron-3-Ultra-550b-a55b` | Authors lessons for topics without a hand-written planner (`lessons.ts`); the server compiles and validates the plan | 4.76 s |

- **Every action says who made it.** Actions carry `served` metadata (provider, model, tier, deterministic planner, router decision, latency) and the activity log prints it, for example “Nemotron 3 Nano routed “attention” 1.1 s → grounded by explicit-target” or “Nemotron 3 Super on Nebius 1.5 s”. Demo mode never claims a model ran.
- **Thinking is switched off** for interactive calls through `chat_template_kwargs.enable_thinking=false`, and all outputs use `response_format: json_schema` with `strict: true`. One small client (`apps/server/src/nebius.ts`) serves every tier.
- **Speech: NVIDIA-hosted Nemotron ASR** (`apps/server/src/speech.ts`) streams microphone PCM over TLS gRPC and returns partial and final transcripts. Partial speech only guides attention and never pays for routing or authoring.
- **What stays deterministic, on purpose:** arithmetic, target IDs, layout and validation. The matrix-multiplication planner, explicit targets, edits, camera moves and Wikimedia image search are trusted tools that Nemotron selects; they never bypass scene-revision validation.
- **Measured, not assumed.** `pnpm bench:nebius` makes real calls through the router, the interpreter and the lesson author and prints p50/p95 per tier; the latest table is in [docs/STATUS.md](docs/STATUS.md). `pnpm check:hackathon` verifies that every configured tier is an NVIDIA Nemotron model on a Token Factory endpoint.
- **Hosted on Nebius too.** `deploy/nebius/` contains the Serverless AI Endpoint script and steps for running the whole app as one container next to Token Factory.

Live verification of the Token Factory path (tiered cues, lesson authoring, scene generation and hosted ASR → Nemotron → visual action) is recorded in [docs/STATUS.md](docs/STATUS.md).

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/nemotron-provenance.png" alt="Activity log showing Nemotron 3 Nano routing a cue and Nemotron 3 Super resolving it" /></td>
    <td width="50%"><img src="docs/screenshots/nemotron-lesson.png" alt="A DNS resolution lesson authored by Nemotron 3 Ultra drawn as cards on the whiteboard" /></td>
  </tr>
  <tr>
    <td align="center"><sub>“Point to revenue”: Nano routes, Super resolves, the log says so.</sub></td>
    <td align="center"><sub>“Explain how DNS resolution works”: Ultra authors, the server compiles and validates, the canvas draws.</sub></td>
  </tr>
</table>

## Run locally

Requirements: Node.js 24 or newer and pnpm 12.

```sh
pnpm install
pnpm dev
```

Open **http://127.0.0.1:5173**. The API listens on port 3001 by default; set `PORT` in the root `.env` if that port is taken by another local service, and the Vite proxy and default allowed origins follow it. The app works without API credentials in explicitly labelled demo mode. Type a cue or use the example cues to exercise the same visual action pipeline.

The workspace is a full-screen canvas with floating controls. Open the stacked-scenes button beside the project title to navigate scenes; use the top-right menu for project actions. Voice and typing stay available in the bottom dock.

Try the marketing metrics, matrix lesson, and architecture diagram. Click objects to edit them. Switch to Rehearse to bind a phrase to a selected object; Present hides editing controls and waits for cues.

Use the visible **Slide / Whiteboard** switch to turn the current scene into an expanding workspace without losing its objects. Whiteboard enables the **Hand** tool: drag anywhere to pan, including over objects. Choose **Select** to move/edit objects, or hold Space while dragging for temporary panning. **New whiteboard** creates a separate blank scene. Try **“Draw a software architecture”**, **“Let's go right”**, **“Draw a matrix lesson”**, then **“Go to Start”**. Earlier objects stay in place. You can name areas, pan the background, scroll to pan, and Ctrl/⌘-scroll to zoom. **“Move Web client right”** changes an object's position; **“Highlight Web client”** brings it into view. Drawing uses labelled example templates without Nebius credentials and the configured Nemotron planner when live. Boards currently support up to 300 objects.

On the marketing slide, type **“An apple on the x axis.”** Vizli searches Wikimedia Commons live and inserts a sourced, editable image attached to the chart's x-axis. This works without provider keys (internet required). Moving the chart keeps the attachment; dragging the image detaches it. Source attribution and license appear in the inspector. The current command requires one visible chart; it does not yet create axes or search arbitrary websites.

## Amend objects by voice

Existing objects can be edited with spoken or typed instructions. Try **“Make matrix A 3 by 2”**, **“Set row 3 column 2 of matrix A to 9”**, or **“Change Revenue to $4.5M.”** You can also request label/text/color changes, explicit dimensions, and individual chart values. Name the object clearly; ambiguous edits are skipped. Each completed edit is atomic and undoable, and matrix resizing preserves overlapping values while filling new cells with zero. Symbolic calculation and automatic derivation updates remain separate work.

## Collaborate

Open a project link, `/p/<id>`, and send it to others. Several people on Macs and iPads can open the same link and work on one project together: edits, ink and attention (pointers and highlights) sync live. Each person keeps their own whiteboard camera and their own undo. Two kinds of link exist: the edit link (`/p/<id>#edit=<token>`, from the link button) lets whoever opens it change the project, and the plain view link (`/p/<id>`) only lets people follow along. There are no accounts, so share edit links only with people you trust; viewers can make their own editable copy with one click. The shared demo at `/p/default` is view only. See [docs/SECURITY.md](docs/SECURITY.md) for the access model, per-visitor limits, browser hardening and privacy notes. The collaboration limits and related environment variables are listed in `.env.example`, and the design, wire protocol and known limits are in [docs/COLLAB.md](docs/COLLAB.md).

## Live speech and AI

Copy `.env.example` to `.env` at the repository root. Set:

- `NVIDIA_API_KEY` to enable NVIDIA-hosted Nemotron ASR microphone transcription. Obtain a key with access from [NVIDIA's model API page](https://build.nvidia.com/nvidia/nemotron-asr-streaming/api). The hosted endpoint/function ID defaults are in `.env.example`.
- `NEBIUS_API_KEY` and `NEBIUS_MODEL` to enable Nemotron interpretation through Nebius Token Factory. The core model is `nvidia/nemotron-3-super-120b-a12b` (Nemotron 3 Super), populated in `.env.example`; verify it is enabled for your account.
- `NEBIUS_FAST_MODEL` (Nemotron 3 Nano) for the intent router and `NEBIUS_REASONING_MODEL` (Nemotron 3 Ultra) for lesson authoring; both default to `NEBIUS_MODEL` when empty, so one model still runs everything.
- Optionally `NEBIUS_PLANNING_MODEL` for a different model used by **Create from an idea**; otherwise it uses `NEBIUS_MODEL`.

Restart the server after changing configuration. Keys remain on the server. Browser microphone permission is required and microphone capture needs localhost or HTTPS.

Demo mode uses a deterministic resolver, not an AI model. Live provider latency and accuracy must be measured with configured accounts; offline tests cannot establish them.

For the hackathon, the selected path is **NVIDIA-hosted Nemotron ASR + Nemotron reasoning on Nebius Token Factory**, with guest entry and no paid TTS. The backend streams PCM audio to NVIDIA over TLS gRPC; it does not host a speech GPU. Mandatory signup is deferred. Server limits are configured through `MAX_CONCURRENT_VOICE_SESSIONS`, `MAX_VOICE_SECONDS_PER_SESSION`, `MAX_LLM_REQUESTS_PER_HOUR`, and `MAX_CONCURRENT_LLM_REQUESTS`; see `.env.example` and `docs/BACKEND.md`. These are lightweight single-process safeguards, not a durable billing system or a guaranteed spend cap. Per-visitor ceilings (`*_PER_CLIENT`, keyed on the request address; set `TRUST_PROXY` behind a reverse proxy) sit in front of them, and `ADMIN_TOKEN` enables wiping a project or resetting the demo; see `docs/SECURITY.md`.

**Hackathon readiness:** NVIDIA-hosted speech alone does not satisfy the Nebius requirement. Configure `NEBIUS_API_KEY` and an actual NVIDIA Nemotron `NEBIUS_MODEL` on Token Factory, then verify meaningful live agent calls. The rule-based local demo is not evidence of Nebius execution. See [docs/HACKATHON.md](docs/HACKATHON.md) for the required validation and remaining submission work.

Hosting direction: one container on a Nebius Serverless AI Endpoint next to Token Factory (see [deploy/nebius/README.md](deploy/nebius/README.md)); Vercel plus Railway remains the fallback. The public deployment is still pending; the existing Supabase feature below is optional and is not required for the demo.

## Optional cloud library

The Cloud button supports Supabase email-link sign-in and explicit project save/load. Follow [docs/CLOUD.md](docs/CLOUD.md) to configure the public browser URL/key and apply the owner-scoped database migration. Local editing works without a cloud account. Uploaded images are embedded in project JSON; retrieved web images retain external URLs and provenance.

## Commands

```sh
pnpm typecheck
pnpm check:hackathon
pnpm build
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm start
pnpm bench:nebius
```

`pnpm start` runs the API and serves the built web application after `pnpm build`. Development uses Vite with an API/WebSocket proxy.

`pnpm check:hackathon` checks server configuration for the required Nebius/NVIDIA model path, including every Nemotron tier, without spending credits or printing secrets. Missing keys cause a nonzero exit; the check does not certify live provider access or submission eligibility.

`pnpm bench:nebius` makes real, billable Token Factory calls through the router, the interpreter and the lesson author and prints a per-tier latency table (`BENCH_RUNS` sets runs per cue).

## Architecture

- React + TypeScript + Vite for the studio.
- SVG/HTML for addressable slides, matrices, charts, and images.
- React Flow for editable architecture diagrams; ELK for layout.
- XState for explicit interaction/session transitions.
- Fastify + WebSockets for speech and validated actions.
- NVIDIA-hosted Nemotron ASR for live transcription; three Nemotron tiers on Nebius Token Factory (Nano router, Super interpreter and planner, Ultra lesson author) for interpretation.
- Validated project JSON and local persistence, with optional Supabase Auth/Postgres cloud save/load.

The project targets the Nebius x NVIDIA hackathon. Runtime Nemotron inference through Token Factory is the intended qualifying integration. A demo-only run does not demonstrate that integration.

## Handoff and current limitations

Start with [docs/STATUS.md](docs/STATUS.md) for verified progress and outstanding work. [PLAN.md](PLAN.md) records product decisions. [docs/DESIGN.md](docs/DESIGN.md) describes implementation boundaries. [BUILD_CONTRACT.md](BUILD_CONTRACT.md) records cross-component interfaces.

This is initially a local single-user application. Supabase cloud rows have owner-scoped access policies; the local API/session server is still single-user and must gain authentication before public deployment. No deployment, account provisioning, or hackathon submission has been performed.

## Domain libraries and motion

Open **Add object** for **Mathematics**, **AWS architecture**, or **UML diagrams**. Insert matrices/equations, representative AWS service shapes, or editable UML classes. Select an object to choose **Target part** and highlight an internal member, or select a **Motion preset** and preview it. Try “Animate matrix A with draw effect” or “Highlight methods of Customer”. Draw progressively reveals content; it is not handwritten font tracing. AWS artwork is an original representative palette, not the official full icon catalogue.

The implementation separates shared plugin contracts, renderer modules and motion adapters. Existing projects remain compatible. Read [docs/PLUGINS.md](docs/PLUGINS.md) for extension patterns, target IDs, supported scope and file ownership.

## Narrate a matrix multiplication lesson

On a whiteboard, say or type:

1. “Today we'll learn about matrix multiplication.”
2. “There are two matrices A and B. A is three by two and B is two by three.”
3. “Point to the first row of A.”
4. “Highlight the second row of A in blue.”
5. “Now let's scroll down to see the multiplication.”
6. “The rows of A can be multiplied with the columns of B.”

Matrices draw progressively; the pointer traces an outline, highlights fade in, and the view pans smoothly. The lesson fills nine output cells one at a time while showing each dot product. Dimensions alone use symbolic entries. Edit the source values to numbers for numeric multiplication. Pause/resume/skip/cancel controls appear while a sequence plays. Editing sources cancels playback and hides stale derived results.

The generic sequence schema and player are reusable across domain plugins; the first narrated lesson planner is matrix multiplication. See [docs/NARRATED_LESSONS.md](docs/NARRATED_LESSONS.md) for architecture, validation, evidence and limits.

## License

Vizli is released under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE) for attribution and third-party notices. Vendored NVIDIA Riva protocol files keep their MIT/Apache-2.0 licenses.

JSON project import/export is the editable interchange format. Arbitrary PowerPoint/PDF reconstruction, symbolic mathematics, and automatic editable decomposition of raster images are separate work.

Browser regression tests (`pnpm test:e2e`) launch isolated demo servers on ports 5174/3002 with temporary storage and paid providers disabled; they do not reuse the live development app.
