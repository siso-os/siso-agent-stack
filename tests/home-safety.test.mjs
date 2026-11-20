// An install on a home that already holds other agents' files (the Mac mini's shape): the dry run lists every write,
// the install refuses before its first write when a target is not the stack's, and no write goes through a link.
// Each case uses a throwaway monorepo copy and a temporary home; the "outside" file stands for one that other agents read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { monorepoFixture } from './monorepo-fixture.mjs';

const installArgs = ['--from-checkout', '--required-only', '--no-external', '--hooks', 'safety-guard,pending-stop', '--skills', 'job-brief,prove-before-claim'];
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

// Every path under `root` with what it is: a link's target (never followed), a folder, or a file's mode and hash.
function snapshot(root) {
  const entries = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const key = relative(root, path);
      if (stat.isSymbolicLink()) entries[key] = `link ${readlinkSync(path)}`;
      else if (stat.isDirectory()) { entries[key] = 'dir'; walk(path); }
      else entries[key] = `file ${(stat.mode & 0o777).toString(8)} ${sha256(path)}`;
    }
  };
  walk(root);
  return entries;
}

function changedPaths(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => before[key] !== after[key]).sort();
}

// The dry run's rows as { action, path }.
function planRows(stdout) {
  return stdout.split('\n').map((line) => line.match(/^(NEW|SAME|REPLACE|ARCHIVE|REMOVE|MERGE|COLLIDE)\s+(\S+)\s+\(/))
    .filter(Boolean).map(([, action, path]) => ({ action, path }));
}

function setup(t) {
  const work = mkdtempSync(join(tmpdir(), 'siso-stack-home-safety-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const mono = monorepoFixture(work);
  const home = join(work, 'home');
  const outside = join(work, 'outside', 'AGENTS.md');
  mkdirSync(home);
  mkdirSync(join(work, 'outside'));
  writeFileSync(outside, '# The shared brain every seat imports\n');
  const cli = join(mono, 'agents/harness/stack/bin/siso-stack.mjs');
  const stack = (...args) => spawnSync(process.execPath, [cli, ...args, '--home', home], { encoding: 'utf8' });
  return { home, outside, stack };
}

// The Mac mini's collision case: an agent file the stack did not make, and ~/.codex/AGENTS.md linked to
// ~/.agents/AGENTS.md, itself a link to a file outside the home.
function miniHome(home, outside) {
  mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(home, '.claude', 'agents', 'Explore.md'), '---\nname: Explore\n---\nanother agent\'s file\n');
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), '@~/.agents/AGENTS.md\n');
  mkdirSync(join(home, '.agents'));
  symlinkSync(outside, join(home, '.agents', 'AGENTS.md'));
  mkdirSync(join(home, '.codex'));
  symlinkSync('../.agents/AGENTS.md', join(home, '.codex', 'AGENTS.md'));
}

test('the dry run lists every collision and writes nothing; the install refuses before its first write and names them all', (t) => {
  const { home, outside, stack } = setup(t);
  miniHome(home, outside);
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'brief-lint'), '#!/bin/sh\necho someone else\'s command\n', { mode: 0o755 });
  const before = snapshot(home);
  const outsideSha = sha256(outside);

  const dry = stack('install', '--dry-run', ...installArgs);
  assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
  assert.deepEqual(snapshot(home), before, 'the dry run wrote to the home');
  const rows = planRows(dry.stdout);
  const collided = rows.filter((row) => row.action === 'COLLIDE').map((row) => row.path).sort();
  assert.deepEqual(collided, [join(home, '.claude/agents/Explore.md'), join(home, '.codex/AGENTS.md'), join(home, '.local/bin/brief-lint')].sort());
  const codexRow = dry.stdout.split('\n').find((line) => line.startsWith(`COLLIDE ${join(home, '.codex/AGENTS.md')} `));
  assert.ok(codexRow.includes(join(home, '.agents/AGENTS.md')) && codexRow.includes(outside), `the row names each file the link reaches: ${codexRow}`);
  for (const path of ['.claude/CLAUDE.md', '.claude/settings.json', '.codex/hooks.json', '.local/bin/siso-stack', '.siso/agent-stack/install-receipt.json']) {
    assert.ok(rows.some((row) => row.path === join(home, path)), `the dry run does not list ${path}`);
  }
  assert.match(dry.stdout, /3 COLLIDE: the install would refuse before its first write/);

  const real = stack('install', ...installArgs);
  assert.equal(real.status, 1, `${real.stdout}\n${real.stderr}`);
  for (const path of collided) assert.ok(real.stderr.includes(`COLLIDE ${path}: `), `the refusal does not name ${path}:\n${real.stderr}`);
  assert.match(real.stderr, /REFUSED: 3 path\(s\) above are not the stack's to write, so the install stopped before writing anything/);
  assert.deepEqual(snapshot(home), before, 'the refused install wrote to the home');
  assert.equal(sha256(outside), outsideSha, 'the file behind the link changed');
});

test('once the collisions are moved aside, the install writes only paths its dry run listed', (t) => {
  const { home, outside, stack } = setup(t);
  miniHome(home, outside);
  // The plan's prep steps: move the agent file aside, and make ~/.codex/AGENTS.md Codex's own file.
  renameSync(join(home, '.claude', 'agents', 'Explore.md'), join(home, 'Explore.md.aside'));
  unlinkSync(join(home, '.codex', 'AGENTS.md'));
  writeFileSync(join(home, '.codex', 'AGENTS.md'), readFileSync(outside));
  const outsideSha = sha256(outside);
  const before = snapshot(home);

  const dry = stack('install', '--dry-run', ...installArgs);
  assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
  assert.match(dry.stdout, /No collisions\./);
  assert.deepEqual(snapshot(home), before, 'the dry run wrote to the home');
  const listed = planRows(dry.stdout).map((row) => row.path);

  const real = stack('install', ...installArgs);
  assert.equal(real.status, 0, `${real.stdout}\n${real.stderr}`);
  const archiveRoot = join(home, 'SISO_Workspace', '_archive');
  const covered = (path) => path.startsWith(archiveRoot + sep) || listed.some((row) => path === row || path.startsWith(row + sep)
    || row.startsWith(path + sep) || new RegExp(`^${row.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.siso-backup-\\d+$`).test(path));
  const unlisted = changedPaths(before, snapshot(home)).map((key) => join(home, key)).filter((path) => !covered(path));
  assert.deepEqual(unlisted, [], 'the install wrote paths its dry run did not list');
  assert.equal(sha256(outside), outsideSha);
  assert.ok(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8').includes('<!-- BEGIN SISO AGENT STACK -->'));
  assert.equal(stack('doctor').status, 0);

  const again = stack('install', '--dry-run', ...installArgs);
  assert.equal(again.status, 0);
  assert.deepEqual(planRows(again.stdout).filter((row) => row.action === 'NEW'), [], 'a second dry run still plans new paths');
});

test('an instruction file that is a link is refused, never written through', (t) => {
  const { home, outside, stack } = setup(t);
  mkdirSync(join(home, '.codex'));
  symlinkSync(outside, join(home, '.codex', 'AGENTS.md'));
  const outsideSha = sha256(outside);
  const before = snapshot(home);

  const real = stack('install', ...installArgs);
  assert.equal(real.status, 1, `${real.stdout}\n${real.stderr}`);
  assert.ok(real.stderr.includes(`COLLIDE ${join(home, '.codex/AGENTS.md')}: a link to ${outside}: the stack never writes through a link`), real.stderr);
  assert.equal(sha256(outside), outsideSha, 'the install wrote through the link');
  assert.equal(readlinkSync(join(home, '.codex', 'AGENTS.md')), outside);
  assert.deepEqual(snapshot(home), before);
});
