# Vizli agent handoff

## Read first
1. `docs/STATUS.md`: current progress and verification; `docs/STATUS-PENDING.md`: every unfinished item.
2. `PLAN.md`: product requirements and selected architecture.
3. `docs/DESIGN.md`: system/visual design and invariants.
4. `BUILD_CONTRACT.md`: implementation interfaces and initial agent ownership.
5. `docs/PLUGINS.md`: domain contracts, renderer/motion separation and extension patterns.
6. `docs/NARRATED_LESSONS.md`: sequence player, domain planners, demo script and verification.
7. Relevant `docs/BACKEND.md`, `docs/CANVAS.md`, `docs/WORKSPACE.md`.
8. `docs/SECURITY.md`: access model (edit tokens, read-only demo), per-client limits, headers, privacy and the deployment checklist.

## Working rules
- User authorized implementation on 8 October 2026 and explicitly requested delegation and durable documentation.
- Keep `docs/STATUS.md` current after meaningful work. Record actual commands/results and unresolved issues; do not claim unrun tests passed.
- Update module documentation with behavior changes. Preserve the distinction between implemented, proposed, and externally unverified features.
- Never expose provider keys in client code, logs, or commits. Do not fetch credentials from unrelated applications.
- Preserve scene IDs and object IDs. Speech effects must validate the current scene revision.
- Listening and animation are concurrent lifecycles. Do not stop narration merely because an animation is running.
- Ambiguous automatic cues skip. Rendered effects must be cancellable and have bounded lifetimes.
- Demo mode must be labelled; it is not live model inference. Configured providers must use actual runtime APIs.
- Hackathon target is Best Apps and Agents: core visual interpretation/planning must use NVIDIA Nemotron on Nebius Token Factory. NVIDIA-hosted ASR is supplementary and does not replace this requirement. Do not change the primary model/provider without checking `docs/HACKATHON.md`. Run `pnpm check:hackathon` before deployment/submission and separately verify live inference; a configuration check is not proof of eligibility.
- Live interpretation is Nemotron-first and tiered (12 October 2026): the fast tier (`NEBIUS_FAST_MODEL`, Nemotron 3 Nano) routes every final cue before deterministic grounding, the core tier (`NEBIUS_MODEL`, Nemotron 3 Super) resolves free-form actions and plans scenes, and the reasoning tier (`NEBIUS_REASONING_MODEL`, Nemotron 3 Ultra) authors lessons. Keep the router in front of the planners, keep every action's `served` metadata honest about which model or rule produced it, and measure with `pnpm bench:nebius` after changing prompts or tiers. The Nebius-hosted deployment path is `deploy/nebius/`.
- Do not deploy or publish unless requested. The public repository is https://github.com/rishulmatta/vizli under the Apache-2.0 license, chosen on 11 October 2026 to satisfy the hackathon rule that the repository carry a detectable open-source license; keep LICENSE/NOTICE intact. Commit when the user asks and never commit `.env` or `.data`.
- Test meaningful state transitions, stale-result cancellation, API validation, and core browser workflows.
- Access model (12 October 2026): a project id is a read capability and the edit token a write capability; the server decides roles. Never put tokens in the Yjs document, in URLs the server logs, or in client bundles; viewers must stay unable to write, cue or use the microphone; keep `docs/SECURITY.md` current when limits, headers or roles change.

## Development
Use pnpm workspaces. See README.md for commands once initial implementation completes. Root owns configuration/integration; initial concurrent ownership is in BUILD_CONTRACT.md. Coordinate before editing another active agent's files.
