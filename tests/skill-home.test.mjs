import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installSkill, linkSkill, skillDoctor } from '../lib/skill-home.mjs';

test('shared home archives conflicts, preserves tool state, and repeat install is unchanged', () => {
  const home = mkdtempSync(join(tmpdir(), 'skill-home-'));
  const source = join(home, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'SKILL.md'), '---\nname: fixture\ndescription: fixture\n---\nregistry wins\n');
  for (const tool of ['.agents', '.claude', '.codex']) {
    mkdirSync(join(home, tool, 'skills', 'fixture'), { recursive: true });
    writeFileSync(join(home, tool, 'skills', 'fixture', 'SKILL.md'), `${tool} original`);
  }
  writeFileSync(join(home, '.codex', 'auth.json'), 'private fixture');
  const first = installSkill(source, 'fixture', home);
  assert.equal(first.codex_archived, 1);
  assert.equal(lstatSync(join(home, '.agents/skills/fixture')).isSymbolicLink(), false);
  assert.equal(lstatSync(join(home, '.claude/skills/fixture')).isSymbolicLink(), true);
  assert.equal(readFileSync(join(home, '.codex/auth.json'), 'utf8'), 'private fixture');
  const manifests = join(home, '.claude/backups/dot-agents-20261021/MANIFEST.txt');
  const before = readFileSync(manifests, 'utf8');
  const records = before.trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 3);
  for (const record of records) assert.match(readFileSync(join(record.archived, 'SKILL.md'), 'utf8'), /original/);
  assert.deepEqual(installSkill(source, 'fixture', home), { name: 'fixture', changed: 0, codex_archived: 0 });
  assert.equal(readFileSync(manifests, 'utf8'), before);
  assert.deepEqual(skillDoctor(home).issues, []);
  symlinkSync('missing', join(home, '.claude/skills/broken'));
  assert.match(skillDoctor(home).issues.join('\n'), /broken link/);
  mkdirSync(join(home, '.codex/skills/fixture'));
  writeFileSync(join(home, '.codex/skills/fixture/SKILL.md'), 'duplicate fixture');
  assert.match(skillDoctor(home).issues.join('\n'), /Codex duplicate/);
});

test('registered module projection installs declared files only', () => {
  const home = mkdtempSync(join(tmpdir(), 'skill-module-'));
  const source = join(home, 'source');
  mkdirSync(join(source, 'scripts'), { recursive: true });
  writeFileSync(join(source, 'SKILL.md'), 'fixture');
  writeFileSync(join(source, 'scripts/run'), 'support');
  writeFileSync(join(source, 'private-unlisted'), 'must stay here');
  const files = ['SKILL.md', 'scripts/run'];
  installSkill(source, 'fixture', home, files);
  assert.deepEqual(readdirSync(join(home, '.agents/skills/fixture')).sort(), ['SKILL.md', 'scripts']);
  assert.equal(installSkill(source, 'fixture', home, files).changed, 0);
});

test('extra Claude config dirs link to the one canonical skill; system-provided links are ignored', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'skill-seats-')));
  const source = join(home, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'SKILL.md'), '---\nname: fixture\ndescription: fixture\n---\nbody\n');
  installSkill(source, 'fixture', home);
  const seat = join(home, '.config', 'claude-seat');
  assert.equal(linkSkill('fixture', home, seat), 1);
  assert.equal(linkSkill('fixture', home, seat), 0);
  assert.equal(realpathSync(join(seat, 'skills', 'fixture')), join(home, '.agents', 'skills', 'fixture'));
  const system = join(home, 'usr-share-skill');
  mkdirSync(system);
  writeFileSync(join(system, 'SKILL.md'), 'system');
  // Simulate an OS-owned skill (e.g. /usr/share/omarchy/...) by linking outside a nested home.
  const nested = join(home, 'nested');
  installSkill(source, 'fixture', mkdirSync(nested, { recursive: true }) || nested);
  for (const tool of ['.agents', '.claude']) symlinkSync(system, join(nested, tool, 'skills', 'os-skill'));
  assert.deepEqual(skillDoctor(nested).issues, []);
  assert.deepEqual(skillDoctor(home, seat).issues, []);
  // A project inside home that ships its own skill through an absolute link is not the stack's either.
  const project = join(home, 'Projects', 'people', 'skills', 'project-skill');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'SKILL.md'), 'project');
  symlinkSync(project, join(home, '.claude', 'skills', 'project-skill'));
  assert.deepEqual(skillDoctor(home).issues, []);
});
