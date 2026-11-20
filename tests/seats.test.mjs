// Per-seat runs from a sisodias/siso checkout. Builds a throwaway copy of the monorepo (stack, hooks, hub
// registry) in a temporary folder and installs into a temporary home: no real seat is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { git, monorepoFixture as checkout, stackSource } from './monorepo-fixture.mjs';

const sourceRoot = resolve(stackSource, '..');

test('a --seat run writes ~/.claude and the named seat only; the other seat is held and checked against its record', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'siso-stack-seats-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const mono = checkout(work);
  const home = join(work, 'home');
  mkdirSync(home);
  const cli = join(mono, 'agents/harness/stack/bin/siso-stack.mjs');
  const stack = (...args) => spawnSync(process.execPath, [cli, ...args, '--home', home], { encoding: 'utf8' });
  const ok = (result) => { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); return result.stdout; };
  const seatA = join(home, '.config', 'seat-a');
  const seatB = join(home, '.config', 'seat-b');
  const receiptPath = join(home, '.siso', 'agent-stack', 'install-receipt.json');
  const stopCommands = (dir) => (JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).hooks?.Stop || [])
    .flatMap((group) => group.hooks.map((hook) => hook.command)).join('\n');

  // The shape the laptop had: every seat in one run, safety-guard only.
  ok(stack('install', '--from-checkout', '--source-root', sourceRoot, '--required-only', '--hooks', 'safety-guard',
    '--skills', 'job-brief', '--claude-dir', seatA, '--claude-dir', seatB));
  // A skill someone else owns, linked into the canonical store by absolute path (as Omarchy does).
  const external = join(work, 'os-skills', 'os-skill');
  mkdirSync(external, { recursive: true });
  writeFileSync(join(external, 'SKILL.md'), '---\nname: os-skill\ndescription: x\n---\n');
  symlinkSync(external, join(home, '.agents', 'skills', 'os-skill'));
  // Make the receipt an old one (no per-seat records), as on the laptop before this change.
  const legacy = JSON.parse(readFileSync(receiptPath, 'utf8'));
  delete legacy.seats; delete legacy.run_seats;
  writeFileSync(receiptPath, JSON.stringify(legacy));
  const seatBSettings = readFileSync(join(seatB, 'settings.json'), 'utf8');
  const seatBSkills = readdirSync(join(seatB, 'skills')).sort();

  // Seat A only: it and ~/.claude get pending-stop and a second skill; seat B is not written.
  const out = ok(stack('install', '--seat', seatA, '--hooks', 'safety-guard,pending-stop', '--skills', 'job-brief,prove-before-claim'));
  assert.match(out, /HOLD .*seat-b/);
  assert.match(stopCommands(join(home, '.claude')), /pending-stop\.mjs' 'stop'/);
  assert.match(stopCommands(seatA), /pending-stop\.mjs' 'stop'/);
  assert.equal(readFileSync(join(seatB, 'settings.json'), 'utf8'), seatBSettings);
  assert.deepEqual(readdirSync(join(seatB, 'skills')).sort(), seatBSkills);
  assert.ok(readdirSync(join(seatA, 'skills')).includes('prove-before-claim'));
  ok(stack('doctor'));

  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.from_checkout, mono);
  assert.deepEqual(receipt.run_seats, [seatA]);
  assert.deepEqual(receipt.seats[seatB].hooks, ['safety-guard']);
  assert.equal(receipt.seats[seatB].skills.includes('os-skill'), false, 'an externally owned skill is not part of a held seat\'s record');
  assert.deepEqual(receipt.seats[seatA].hooks, ['safety-guard', 'pending-stop']);
  assert.equal(receipt.components.find((component) => component.id === 'hooks').path, 'agents/harness/hooks/portable');

  // A plain re-run keeps the split.
  ok(stack('install'));
  assert.equal(readFileSync(join(seatB, 'settings.json'), 'utf8'), seatBSettings);
  ok(stack('doctor'));

  // Doctor holds the held seat to its record.
  const tampered = JSON.parse(seatBSettings);
  tampered.hooks.Stop = JSON.parse(readFileSync(join(seatA, 'settings.json'), 'utf8')).hooks.Stop;
  writeFileSync(join(seatB, 'settings.json'), JSON.stringify(tampered));
  assert.match(stack('doctor').stderr, /seat-b\/settings\.json differ from the receipt's record/);
  writeFileSync(join(seatB, 'settings.json'), seatBSettings);
  ok(stack('doctor'));
  // A tool that saves the file again with its keys in another order changes no hook (Codex does this).
  const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
  const codexHooks = join(home, '.codex', 'hooks.json');
  const codexBefore = readFileSync(codexHooks, 'utf8');
  writeFileSync(join(seatB, 'settings.json'), JSON.stringify(sortKeys(JSON.parse(seatBSettings))));
  writeFileSync(codexHooks, JSON.stringify(sortKeys(JSON.parse(codexBefore))));
  ok(stack('doctor'));
  writeFileSync(join(seatB, 'settings.json'), seatBSettings);
  writeFileSync(codexHooks, codexBefore);

  // The held seat's own run: a subset of the hooks, without changing ~/.claude's selection.
  ok(stack('install', '--seat', seatB, '--seat-hooks', 'safety-guard'));
  assert.equal(stopCommands(seatB), '');
  assert.ok(readdirSync(join(seatB, 'skills')).includes('prove-before-claim'));
  assert.match(stopCommands(join(home, '.claude')), /pending-stop/);
  assert.match(stopCommands(seatA), /pending-stop/);
  ok(stack('doctor'));

  // The checkout moves on: doctor says to re-run install.
  writeFileSync(join(mono, 'agents/harness/hooks/portable/MOVED.md'), 'moved\n');
  git(mono, 'add', '-A');
  git(mono, 'commit', '-qm', 'move');
  assert.match(stack('doctor').stderr, /the checkout is now at .*re-run siso-stack install/);
  ok(stack('install'));
  assert.equal(stopCommands(seatB), '', 'a plain re-run keeps the seat\'s own hook subset');
  ok(stack('doctor'));
  // A dirty checkout path is refused.
  writeFileSync(join(mono, 'agents/harness/hooks/portable/DIRTY.md'), 'dirty\n');
  assert.match(stack('doctor').stderr, /checkout path is dirty/);
  assert.notEqual(stack('install').status, 0);
});

test('--claude-dir and --seat together are refused', () => {
  const result = spawnSync(process.execPath, [join(stackSource, 'bin/siso-stack.mjs'), 'plan', '--seat', '/x', '--claude-dir', '/y'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /pass one of them/);
});
