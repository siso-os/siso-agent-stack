# Contributing to SISO Agent Stack

The Stack is a version-pinned public distribution. Contributions should make the complete setup easier to install, verify, understand, or extend without duplicating the source owned by component repositories.

## Choose the owning repository

- Installer, portable profiles, bundled agent definitions, composition pins, and distribution receipts belong here.
- Atomic reusable capabilities belong in [SISO Skills Hub](https://github.com/sisodias/siso-skills-hub).
- Multi-agent scenarios and worker tooling belong in [SISO Agent Playbook](https://github.com/sisodias/siso-agent-playbook-public).
- Claude Code and Codex lifecycle automation belongs in [SISO Agent Hooks](https://github.com/sisodias/siso-agent-hooks).
- Component source changes belong in the component repository named by `stack.manifest.json`.
- Stable identities, Releases, and Stack Assemblies belong in [The Great Library of SISO](https://github.com/sisodias/great-library-of-siso).

Do not add a new component merely because a folder exists. A separate component needs an independent adoption, ownership, security, or release boundary.

## Local verification

Requires Node.js 20 and Git.

```bash
npm test
npm run verify
node bin/siso-stack.mjs plan
```

Installer changes must also preserve these invariants:

- every Git source is pinned to a full commit SHA;
- install is idempotent for managed files;
- unrelated host files are never silently overwritten;
- `doctor` detects missing, altered, dirty, or unpinned managed state;
- the complete publishable tree passes the privacy verifier; and
- the public stack contains no credentials, transcripts, private topology, personal memory, runtime databases, logs, client code, or private repositories.

## Change a component pin

A component whose source is this monorepo (`monorepo_path` in `stack.manifest.json`: Skills Hub and Hooks) moves with one command, run from a sisodias/siso lane:

```bash
node agents/harness/stack/bin/siso-stack.mjs release
```

It moves each of those pins to the newest main commit that touches the component's paths (its `monorepo_path`, plus, for the Skills Hub, every registered skill whose `source_path` is outside the hub, such as Agent Zero's in `agents/zero/.claude/skills`), runs `sh check.sh` (the full gate, including a clean isolated install from the new pins) in a throwaway worktree, and opens the PR listing what the release adds by PR number and title. Merge the PR once its checks are green, then run the same command again: it tags the newest main commit touching the stack `stack-<YYYYMMDD>-<HHMM>-<sha8>` and publishes the release. A failed gate pushes nothing and leaves its whole output in the checkout's git directory (`siso-stack-gate.log`). A run with nothing new merged changes nothing and says so; `--dry-run` shows the next step without taking it. Each machine then runs `siso-stack install --release latest` and `siso-stack doctor`.

A component with its own repository, including the borrowed Herdr engine, keeps its own bump PR:

1. Make and verify the change in the owning component repository.
2. Publish the exact public commit.
3. Update only that component's `revision`, repository, or license evidence in `stack.manifest.json`.
4. Run the full Stack verification gate and a clean isolated install.
5. Explain the user-visible change and the exact clean-install receipt in the pull request.
6. After merge, run `siso-stack release` to publish the Stack release, and update its immutable Great Library Release and Assembly selection.

Components keep their own licenses and ownership. Herdr is an external Apache-2.0 dependency and must never be presented as SISO-owned.
