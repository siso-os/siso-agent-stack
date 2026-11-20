// `siso-stack release` and `install --release`, against a local fixture monorepo and a stub `gh`: no network,
// no real home, no GitHub writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const stackSource = resolve(import.meta.dirname, '..');
const monoSource = resolve(stackSource, '..', '..', '..');
const identity = { GIT_AUTHOR_NAME: 'stack-test', GIT_AUTHOR_EMAIL: 'stack-test@example.invalid', GIT_COMMITTER_NAME: 'stack-test', GIT_COMMITTER_EMAIL: 'stack-test@example.invalid' };

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...identity } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function commit(repo, message, files) {
  for (const [path, text] of Object.entries(files)) write(join(repo, path), text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', message);
  return git(repo, 'rev-parse', 'HEAD');
}

// A stand-in for gh: open PRs and releases live in a JSON file; every call is logged there.
function stubGh(work) {
  const state = join(work, 'gh.json');
  writeFileSync(state, JSON.stringify({ calls: [], prs: [], releases: {} }));
  const script = join(work, 'gh');
  writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const a = process.argv.slice(2);
const flag = (name) => a[a.indexOf(name) + 1];
s.calls.push(a.slice(0, 2).join(' '));
let code = 0;
if (a[0] === 'pr' && a[1] === 'list') console.log(JSON.stringify(s.prs.filter((p) => p.open)));
else if (a[0] === 'pr' && a[1] === 'create') {
  const number = 100 + s.prs.length;
  s.prs.push({ number, url: 'https://github.test/pull/' + number, headRefName: flag('--head'), open: true, title: flag('--title'), body: fs.readFileSync(flag('--body-file'), 'utf8') });
  console.log('https://github.test/pull/' + number);
} else if (a[0] === 'pr' && a[1] === 'close') s.prs.find((p) => String(p.number) === a[2]).open = false;
else if (a[0] === 'release' && a[1] === 'view') code = s.releases[a[2]] ? 0 : 1;
else if (a[0] === 'release' && a[1] === 'create') { s.releases[a[2]] = fs.readFileSync(flag('--notes-file'), 'utf8'); console.log('https://github.test/releases/' + a[2]); }
else code = 3;
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
process.exit(code);
`);
  chmodSync(script, 0o755);
  return { script, read: () => JSON.parse(readFileSync(state, 'utf8')) };
}

const fixtureManifest = (pin) => JSON.stringify({
  schema_version: 1, name: 'siso-agent-stack', version: '0.2.0',
  monorepo: { repository: 'https://github.com/sisodias/siso.git' },
  components: [
    { id: 'skills', monorepo_path: 'agents/skills/hub', repository: 'https://github.com/sisodias/siso-skills-hub.git', revision: pin, required: true, install: 'skills-registry' },
    { id: 'hooks', monorepo_path: 'agents/harness/hooks/portable', repository: 'https://github.com/sisodias/siso-agent-hooks.git', revision: pin, required: true, install: 'hooks' },
    { id: 'herdr', repository: 'https://github.com/herdrdev/herdr.git', revision: '26a7bc860e4af516ef687d90b9f9dd2830f88d2a', required: false, install: 'external-source' }
  ]
}, null, 2) + '\n';

test('release: pins PR, wait, publish after merge, then nothing new; a failed gate pushes nothing', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'siso-stack-release-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const origin = join(work, 'origin.git');
  git(work, 'init', '-q', '--bare', '-b', 'main', origin);
  const lane = join(work, 'lane');
  git(work, 'init', '-q', '-b', 'main', lane);
  git(lane, 'remote', 'add', 'origin', origin);
  // The hub lists one skill kept outside it, as Agent Zero's are: a change there moves the skills pin too.
  const registry = JSON.stringify({ skills: [{ skill_id: 'z', source_path: 'agents/zero/.claude/skills/z' }] });
  const base = commit(lane, 'start', { 'agents/skills/hub/a.md': 'a\n', 'agents/skills/hub/registry/skills_registry.json': registry,
    'agents/zero/.claude/skills/z/SKILL.md': 'z\n', 'agents/harness/hooks/portable/b.mjs': 'b\n', 'agents/harness/stack/check.sh': 'true\n' });
  commit(lane, 'stack: pin the mirrors', { 'agents/harness/stack/stack.manifest.json': fixtureManifest(base) });
  const hub = commit(lane, 'hub: one (#11)', { 'agents/skills/hub/a.md': 'a2\n' });
  const hooks = commit(lane, 'hooks: two (#12)', { 'agents/harness/hooks/portable/b.mjs': 'b2\n' });
  commit(lane, 'docs: elsewhere (#13)', { 'docs/x.md': 'x\n' });
  git(lane, 'push', '-q', 'origin', 'main');
  const gh = stubGh(work);
  const cli = join(stackSource, 'bin', 'siso-stack.mjs');
  const release = (...args) => spawnSync(process.execPath, [cli, 'release', '--checkout', lane, '--gate', 'true', ...args],
    { encoding: 'utf8', env: { ...process.env, ...identity, SISO_STACK_GH: gh.script } });
  const ok = (result) => { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); return result.stdout; };
  const remote = () => git(lane, 'ls-remote', 'origin').split('\n').sort().join('\n');
  const pinsAt = (ref) => JSON.parse(git(lane, 'show', `${ref}:agents/harness/stack/stack.manifest.json`)).components;

  // 1. The pins lag main: a gated PR moves them, and only them.
  let out = ok(release());
  assert.match(out, /PIN {3}skills .* -> .*agents\/skills\/hub and 1 skill source\(s\) outside it/);
  assert.match(out, /PIN {3}hooks /);
  assert.match(out, /KEEP {2}herdr .*own repository/);
  assert.match(out, /#11 hub: one/);
  assert.match(out, /#12 hooks: two/);
  assert.doesNotMatch(out, /#13/);
  assert.match(out, /OPENED https:\/\/github\.test\/pull\/100/);
  const branch = `stack/pins-${hooks.slice(0, 8)}`;
  git(lane, 'fetch', '-q', 'origin', branch);
  const pinsCommit = git(lane, 'rev-parse', 'FETCH_HEAD');
  const [skills, hooksPin, herdr] = pinsAt(pinsCommit);
  assert.deepEqual([skills.revision, skills.repository], [hub, 'https://github.com/sisodias/siso.git']);
  assert.deepEqual([hooksPin.revision, hooksPin.repository], [hooks, 'https://github.com/sisodias/siso.git']);
  assert.equal(herdr.revision, '26a7bc860e4af516ef687d90b9f9dd2830f88d2a');
  assert.deepEqual(git(lane, 'diff', '--name-only', 'origin/main', pinsCommit).split('\n'), ['agents/harness/stack/stack.manifest.json']);
  assert.match(gh.read().prs[0].body, /#12 hooks: two/);

  // 2. The same PR is still open: nothing changes.
  const before = remote();
  out = ok(release());
  assert.match(out, /WAIT .*pull\/100/);
  assert.equal(remote(), before);
  assert.equal(gh.read().calls.filter((call) => call === 'pr create').length, 1);

  // 3. Merged: the release is tagged at the merge and published with what it adds.
  git(lane, 'push', '-q', 'origin', `${pinsCommit}:refs/heads/main`);
  const state = gh.read();
  state.prs[0].open = false;
  writeFileSync(join(work, 'gh.json'), JSON.stringify(state));
  out = ok(release());
  const tag = out.match(/PUBLISHED (stack-\d{8}-\d{4}-[0-9a-f]{8})/)?.[1];
  assert.ok(tag, out);
  git(lane, 'fetch', '-q', 'origin');
  assert.equal(git(lane, 'ls-remote', 'origin', `refs/tags/${tag}`).split('\t')[0], git(lane, 'rev-parse', 'origin/main'));
  const notes = gh.read().releases[tag];
  assert.match(notes, /#11 hub: one/);
  assert.match(notes, /#12 hooks: two/);
  assert.doesNotMatch(notes, /#13/);
  assert.match(notes, /siso-stack install --release stack-/);
  assert.match(gh.read().calls.join('\n'), /release create/);

  // 4. Run again with nothing new merged: it says so and changes nothing.
  const published = remote();
  out = ok(release());
  assert.match(out, /NOTHING NEW +release stack-.* Nothing changed/);
  assert.equal(remote(), published);
  assert.equal(gh.read().calls.filter((call) => call === 'release create').length, 1);

  // 5. New work on main: a failing gate pushes nothing; a passing one opens a PR listing only the new work.
  git(lane, 'checkout', '-q', '--detach', 'origin/main');
  commit(lane, 'hub: three (#14)', { 'agents/skills/hub/a.md': 'a3\n' });
  git(lane, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const failed = release('--gate', 'false');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /nothing pushed/);
  assert.equal(git(lane, 'ls-remote', 'origin', 'refs/heads/stack/pins-*').split('\n').filter(Boolean).length, 1, 'only the merged PR branch');
  out = ok(release());
  assert.match(out, new RegExp(`since ${tag}`));
  assert.match(out, /#14 hub: three/);
  assert.doesNotMatch(out, /#11/);

  // 6. Main moves again before that PR merges: the newer PR supersedes it.
  commit(lane, 'hooks: four (#15)', { 'agents/harness/hooks/portable/b.mjs': 'b4\n' });
  git(lane, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  out = ok(release());
  assert.match(out, /CLOSED .*pull\/101 \(superseded\)/);
  assert.match(out, /OPENED .*pull\/102/);
  assert.deepEqual(gh.read().prs.filter((pull) => pull.open).map((pull) => pull.number), [102]);

  // 7. A change only to a skill the hub lists from outside it still moves the skills pin.
  const zero = commit(lane, 'zero: skill z (#16)', { 'agents/zero/.claude/skills/z/SKILL.md': 'z2\n' });
  git(lane, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  out = ok(release());
  assert.match(out, /#16 zero: skill z/);
  assert.match(out, /OPENED .*pull\/103/);
  git(lane, 'fetch', '-q', 'origin', `stack/pins-${zero.slice(0, 8)}`);
  assert.equal(pinsAt('FETCH_HEAD')[0].revision, zero);

  // A shallow copy (an installed release) has no history to read: refused.
  const shallow = join(work, 'shallow');
  git(work, 'clone', '-q', '--depth', '1', `file://${origin}`, shallow);
  const refused = spawnSync(process.execPath, [cli, 'release', '--checkout', shallow], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /shallow copy/);
});

test('install --release installs a published release at its monorepo pins, and doctor runs from it', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'siso-stack-release-install-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const origin = join(work, 'siso.git');
  git(work, 'init', '-q', '--bare', '-b', 'main', origin);
  const mono = join(work, 'mono');
  const skip = (path) => !/\/(node_modules|\.git)(\/|$)/.test(path);
  cpSync(stackSource, join(mono, 'agents/harness/stack'), { recursive: true, filter: skip });
  cpSync(join(monoSource, 'agents/harness/hooks/portable'), join(mono, 'agents/harness/hooks/portable'), { recursive: true, filter: skip });
  cpSync(join(monoSource, 'agents/skills/hub/registry'), join(mono, 'agents/skills/hub/registry'), { recursive: true, filter: skip });
  cpSync(join(monoSource, 'agents/skills/hub/scripts/skills'), join(mono, 'agents/skills/hub/scripts/skills'));
  // research-fleet is registered with its source in agents/zero (no copy in the hub): a stand-in sits there.
  write(join(mono, 'agents/zero/.claude/skills/research-fleet/SKILL.md'), '---\nname: research-fleet\ndescription: fixture\n---\n');
  git(work, 'init', '-q', '-b', 'main', mono);
  git(mono, 'remote', 'add', 'origin', origin);
  const pin = commit(mono, 'components', {});
  // The release: skills and hooks pinned to that monorepo commit, nothing that needs the network.
  const manifestPath = join(mono, 'agents/harness/stack/stack.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.monorepo.repository = origin;
  manifest.components = manifest.components.filter((component) => ['skills', 'hooks'].includes(component.id))
    .map((component) => ({ ...component, repository: origin, revision: pin }));
  const released = commit(mono, 'stack: pin skills, hooks', { 'agents/harness/stack/stack.manifest.json': `${JSON.stringify(manifest, null, 2)}\n` });
  git(mono, 'push', '-q', 'origin', 'main', `${released}:refs/tags/stack-20260101-0000-${released.slice(0, 8)}`);
  const tag = `stack-20260101-0000-${released.slice(0, 8)}`;

  const home = join(work, 'home');
  // The machine was last installed from a checkout: the receipt remembers it, and --release still installs.
  write(join(home, '.siso/agent-stack/install-receipt.json'), JSON.stringify({ from_checkout: join(work, 'some-lane') }));
  const ok = (result) => { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); return result.stdout; };
  const both = spawnSync(process.execPath, [join(mono, 'agents/harness/stack/bin/siso-stack.mjs'), 'install', '--release', 'latest', '--from-checkout', '--home', home], { encoding: 'utf8' });
  assert.equal(both.status, 2);
  assert.match(both.stderr, /pass one of them/);
  // The dry run fetches the release and its pins into a temporary folder, lists every write and leaves the home as it was.
  const homeBefore = readdirSync(home, { recursive: true }).sort();
  const receiptBefore = readFileSync(join(home, '.siso/agent-stack/install-receipt.json'), 'utf8');
  const dry = ok(spawnSync(process.execPath, [join(mono, 'agents/harness/stack/bin/siso-stack.mjs'), 'install', '--release', 'latest', '--dry-run',
    '--home', home, '--hooks', 'safety-guard', '--skills', 'job-brief,research-fleet'], { encoding: 'utf8' })).split('\n');
  for (const path of ['.siso/agent-stack/release', '.local/bin/siso-stack', '.agents/skills/research-fleet', '.claude/settings.json']) {
    assert.ok(dry.some((line) => /^(NEW|MERGE) /.test(line) && line.includes(` ${join(home, path)}  (`)), `the release dry run does not list ${path}:\n${dry.join('\n')}`);
  }
  assert.ok(dry.some((line) => line.startsWith(`NEW     ${join(home, '.local/bin/siso-stack')}  (`)));
  assert.deepEqual(readdirSync(home, { recursive: true }).sort(), homeBefore, 'the release dry run wrote to the home');
  assert.equal(readFileSync(join(home, '.siso/agent-stack/install-receipt.json'), 'utf8'), receiptBefore);
  // With a target that is someone else's, the install refuses before its first write, the release copy included.
  write(join(home, '.claude/agents/Explore.md'), 'another agent\'s file\n');
  const refusedInstall = spawnSync(process.execPath, [join(mono, 'agents/harness/stack/bin/siso-stack.mjs'), 'install', '--release', 'latest',
    '--home', home, '--hooks', 'safety-guard', '--skills', 'job-brief,research-fleet'], { encoding: 'utf8' });
  assert.equal(refusedInstall.status, 1, `${refusedInstall.stdout}\n${refusedInstall.stderr}`);
  assert.ok(refusedInstall.stderr.includes(`COLLIDE ${join(home, '.claude/agents/Explore.md')}: a file the stack did not make`), refusedInstall.stderr);
  assert.match(refusedInstall.stderr, /REFUSED: 1 path\(s\) above .* stopped before writing anything/);
  assert.deepEqual(readdirSync(home, { recursive: true }).sort(), [...homeBefore, '.claude', '.claude/agents', '.claude/agents/Explore.md'].sort());
  rmSync(join(home, '.claude'), { recursive: true });
  const install = spawnSync(process.execPath, [join(mono, 'agents/harness/stack/bin/siso-stack.mjs'), 'install', '--release', 'latest',
    '--home', home, '--hooks', 'safety-guard', '--skills', 'job-brief,research-fleet'], { encoding: 'utf8' });
  const out = ok(install);
  assert.match(out, new RegExp(`RELEASE ${tag}`));
  assert.match(out, /PIN {3}hooks .*\(agents\/harness\/hooks\/portable\)/);
  const stackRoot = join(home, '.siso', 'agent-stack');
  const releaseCli = join(stackRoot, 'release', 'agents/harness/stack/bin/siso-stack.mjs');
  assert.match(readFileSync(join(home, '.local/bin/siso-stack'), 'utf8'), new RegExp(releaseCli.replaceAll('/', '\\/')));
  assert.ok(existsSync(join(stackRoot, 'repos/monorepo/hooks/agents/harness/hooks/portable/bin/siso-hooks.mjs')));
  assert.equal(existsSync(join(stackRoot, 'repos/monorepo/hooks/agents/skills')), false, 'only the component path is checked out');
  assert.equal(existsSync(join(stackRoot, 'repos/monorepo/hooks/agents/zero')), false, 'hooks lists no skills');
  assert.ok(existsSync(join(stackRoot, 'repos/monorepo/skills/agents/zero/.claude/skills/research-fleet/SKILL.md')), 'the hub checkout holds the skills it lists from outside');
  assert.match(readFileSync(join(home, '.agents/skills/research-fleet/SKILL.md'), 'utf8'), /name: research-fleet/);
  const receipt = JSON.parse(readFileSync(join(stackRoot, 'install-receipt.json'), 'utf8'));
  assert.equal(receipt.release, tag);
  assert.equal(receipt.from_checkout, null);
  assert.deepEqual(receipt.components.find((component) => component.id === 'hooks'), { id: 'hooks', revision: pin, repository: origin, path: 'agents/harness/hooks/portable' });
  const doctor = () => spawnSync(process.execPath, [releaseCli, 'doctor', '--home', home], { encoding: 'utf8' });
  assert.match(ok(doctor()), new RegExp(`PASS SISO Agent Stack .*\\(release ${tag}\\)`));
  // An edited release copy or component is caught.
  writeFileSync(join(stackRoot, 'release', 'agents/harness/stack/EDITED.md'), 'x\n');
  assert.match(doctor().stderr, /release checkout is dirty/);
  rmSync(join(stackRoot, 'release', 'agents/harness/stack/EDITED.md'));
  writeFileSync(join(stackRoot, 'repos/monorepo/skills/agents/skills/hub/EDITED.md'), 'x\n');
  assert.match(doctor().stderr, /skills: managed checkout is dirty/);
  rmSync(join(stackRoot, 'repos/monorepo/skills/agents/skills/hub/EDITED.md'));
  ok(doctor());
  // Installing the same release again changes nothing it manages.
  ok(spawnSync(process.execPath, [releaseCli, 'install', '--home', home], { encoding: 'utf8' }));
  ok(doctor());
});
