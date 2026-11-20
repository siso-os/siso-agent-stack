// A throwaway copy of the monorepo (stack, hooks, hub registry) for tests that install with --from-checkout into a
// temporary home: no real seat is read or written.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const stackSource = resolve(import.meta.dirname, '..');
const monoSource = resolve(stackSource, '..', '..', '..');

export function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=stack-test', '-c', 'user.email=stack-test@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// Copies the monorepo paths an install reads into `work`/siso and commits them; returns that checkout.
export function monorepoFixture(work) {
  const mono = join(work, 'siso');
  const skip = (path) => !/\/(node_modules|\.git)(\/|$)/.test(path);
  cpSync(stackSource, join(mono, 'agents/harness/stack'), { recursive: true, filter: skip });
  cpSync(join(monoSource, 'agents/harness/hooks/portable'), join(mono, 'agents/harness/hooks/portable'), { recursive: true, filter: skip });
  cpSync(join(monoSource, 'agents/skills/hub/registry'), join(mono, 'agents/skills/hub/registry'), { recursive: true, filter: skip });
  mkdirSync(join(mono, 'agents/skills/hub/scripts'), { recursive: true });
  cpSync(join(monoSource, 'agents/skills/hub/scripts/skills'), join(mono, 'agents/skills/hub/scripts/skills'));
  git(mono, 'init', '-q');
  git(mono, 'add', '-A');
  git(mono, 'commit', '-qm', 'fixture');
  return mono;
}
