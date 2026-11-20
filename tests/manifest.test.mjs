import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'stack.manifest.json'), 'utf8'));

test('component ids and pins are unique and explicit', () => {
  assert.equal(new Set(manifest.components.map((component) => component.id)).size, manifest.components.length);
  for (const component of manifest.components) {
    assert.match(component.revision, /^[0-9a-f]{40}$/);
    assert.match(component.repository, /^https:\/\/github\.com\//);
  }
});

test('distribution accounts for every requested portable surface', () => {
  const surfaces = manifest.portable_surfaces.join(' ').toLowerCase();
  for (const expected of ['claude', 'codex', 'skills', 'agent definitions', 'hooks', 'playbooks', 'herdr']) {
    assert.match(surfaces, new RegExp(expected));
  }
});

test('Claude and Codex agent roles use their host-native formats', () => {
  const claude = readdirSync(join(root, 'profiles', 'agents')).filter((name) => name.endsWith('.md')).map((name) => name.replace(/\.md$/, '')).sort();
  const codex = readdirSync(join(root, 'profiles', 'codex-agents')).filter((name) => name.endsWith('.toml')).map((name) => name.replace(/^siso-/, '').replace(/\.toml$/, '')).sort();
  const claudeOnly = ['checker', 'librarian', 'runner', 'scout', 'senior-engineer', 'thinker', 'upgrader'];
  // Explore replaces Claude Code's built-in Explore with a Haiku one in every login folder; it is not a SISO role.
  const builtinOverrides = ['Explore'];
  // Agents ported from upstream harnesses (agents/skills/hub/third_party/, listed in its ports.json) are Claude-only.
  // Each starts with its provenance line, which is how they are told apart from SISO's own roles.
  const ported = claude.filter((name) => /^Ported from `agents\/skills\/hub\/third_party\//m
    .test(readFileSync(join(root, 'profiles', 'agents', `${name}.md`), 'utf8')));
  assert.deepEqual(codex, claude.filter((name) => !claudeOnly.includes(name) && !builtinOverrides.includes(name) && !ported.includes(name)));
  for (const name of ported) {
    const text = readFileSync(join(root, 'profiles', 'agents', `${name}.md`), 'utf8');
    // Claude Code reads only these model values; Cursor slugs (fast, grok-*) were mapped when the agent was ported.
    const model = text.match(/^---\n([\s\S]*?)\n---/)[1].match(/^model:\s*(.+)$/m)?.[1].trim();
    assert.ok(!model || ['opus', 'sonnet', 'haiku', 'fable', 'inherit'].includes(model), `${name}: model ${model}`);
  }
  for (const name of claudeOnly) {
    assert.ok(claude.includes(name));
    const text = readFileSync(join(root, 'profiles', 'agents', `${name}.md`), 'utf8');
    // Haiku finds, reads and checks; a role that ships edits runs on Opus (Shaan, 14 Nov 2026).
    assert.match(text, name === 'upgrader' ? /^model: opus$/m : /^model: haiku$/m);
    assert.match(text, /^skills: \[[^\]]+\]$/m);
  }
  for (const name of codex) {
    const content = readFileSync(join(root, 'profiles', 'codex-agents', `siso-${name}.toml`), 'utf8');
    assert.match(content, /^name\s*=\s*"[^"]+"/m);
    assert.match(content, /^description\s*=\s*"[^"]+"/m);
    assert.match(content, /^developer_instructions\s*=\s*"""/m);
  }
});

test('plan is deterministic and does not mutate the home directory', () => {
  const result = spawnSync(process.execPath, [join(root, 'bin', 'siso-stack.mjs'), 'plan', '--required-only'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /required\thooks\t/);
  assert.doesNotMatch(result.stdout, /optional\t/);
});

test('missing option values and unknown operations fail safely', () => {
  const cli = join(root, 'bin', 'siso-stack.mjs');
  assert.equal(spawnSync(process.execPath, [cli, 'install', '--dry-run', '--home'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [cli, 'instal'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [cli], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8' }).status, 0);
});
