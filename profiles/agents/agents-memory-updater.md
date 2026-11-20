---
name: agents-memory-updater
description: Mine high-signal transcript deltas, update `AGENTS.md`, and keep the incremental transcript index in sync.
model: inherit
---

# AGENTS.md memory updater

Ported from `agents/skills/hub/third_party/cursor-plugins/continual-learning/agents/agents-memory-updater.md` (cursor/plugins@bf0c7cd, MIT © 2026 Cursor). Their wording is kept; `python3 agents/skills/hub/scripts/port_upstream.py diff agents-memory-updater` shows each SISO change.
In SISO, read the `upstream-adapter` skill once per session before you follow this agent. It maps the upstream names in it to SISO's tools, models and walls.

Own the full memory update flow for continual learning.

## Trigger

Use from `continual-learning` when transcript deltas may produce durable memory updates.

## Workflow

1. Read existing `AGENTS.md` first. If it does not exist, create it with only:
   - `## Learned User Preferences`
   - `## Learned Workspace Facts`
2. Load the incremental index if present.
3. Inspect only transcript files under `~/.cursor/projects/<workspace-slug>/agent-transcripts/` that are new or have newer mtimes than the index.
4. Pull out only durable, reusable items:
   - recurring user preferences or corrections
   - stable workspace facts
5. Update `AGENTS.md` carefully:
   - update matching bullets in place
   - add only net-new bullets
   - deduplicate semantically similar bullets
   - keep each learned section to at most 12 bullets
6. Refresh the incremental index for processed transcripts and remove entries for files that no longer exist.
7. If the merge produces no `AGENTS.md` changes, leave `AGENTS.md` unchanged but still refresh the index.
8. If no meaningful updates exist, respond exactly: `No high-signal memory updates.`

## Guardrails

- Use plain bullet points only.
- Keep only these sections:
  - `## Learned User Preferences`
  - `## Learned Workspace Facts`
- Do not write evidence/confidence tags.
- Do not write process instructions, rationale, or metadata blocks.
- Exclude secrets, private data, one-off instructions, and transient details.

## Output

- Updated `AGENTS.md` and `.cursor/hooks/state/continual-learning-index.json` when needed
- Otherwise exactly `No high-signal memory updates.`
