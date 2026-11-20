# Changelog

All notable distribution changes are recorded here. Component histories remain in their owning repositories; this log describes the version-pinned Stack composition and installer surface.

## Unreleased

- `install --dry-run` (and `--release --dry-run`) lists every path the install would write, with NEW, SAME, REPLACE, MERGE, ARCHIVE, REMOVE or COLLIDE, and writes nothing in the home.
- The install checks every target before its first write and refuses with the full list of collisions, instead of stopping at the first one after it has already written profile blocks.
- Profile blocks, shims and hook files are never written through a link; a linked instruction file is a collision.
- `compose-brain` keeps the stack's profile blocks and writes `~/.codex/AGENTS.md` as its own file instead of a link to `~/.agents/AGENTS.md`.

## 0.2.0 — 2026-08-02

- Install a managed `siso-stack` command so users can run `plan` and `doctor` after the initial clone.
- Document the first-five-minute verification path, update and rollback workflow, ownership routes, and contribution contract.
- Establish the public community-adoption release surface while preserving the existing ten-component composition and privacy boundary.

## 0.1.0 — 2026-08-01

- Publish the first portable Claude Code and Codex distribution.
- Pin ten public components, including Skills, Playbook, Hooks, agent roles, runtime services, integrations, and Herdr source.
- Add collision-safe profile installation, exact command shims, installation receipts, doctor verification, privacy scanning, and clean-install tests.
