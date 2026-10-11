# Vizli agent handoff

## Read first
1. `docs/STATUS.md`: current progress, verification, next actions.
2. `PLAN.md`: product requirements and selected architecture.
3. `docs/DESIGN.md`: system/visual design and invariants.
4. `BUILD_CONTRACT.md`: implementation interfaces and initial agent ownership.
5. `docs/PLUGINS.md`: domain contracts, renderer/motion separation and extension patterns.
6. `docs/NARRATED_LESSONS.md`: sequence player, domain planners, demo script and verification.
7. Relevant `docs/BACKEND.md`, `docs/CANVAS.md`, `docs/WORKSPACE.md`.

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
- Do not deploy or publish unless requested. The public repository is https://github.com/rishulmatta/vizli under the Apache-2.0 license, chosen on 11 October 2026 to satisfy the hackathon rule that the repository carry a detectable open-source license; keep LICENSE/NOTICE intact. Commit when the user asks and never commit `.env` or `.data`.
- Test meaningful state transitions, stale-result cancellation, API validation, and core browser workflows.

## Development
Use pnpm workspaces. See README.md for commands once initial implementation completes. Root owns configuration/integration; initial concurrent ownership is in BUILD_CONTRACT.md. Coordinate before editing another active agent's files.
