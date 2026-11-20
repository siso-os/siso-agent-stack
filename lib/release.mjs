// `siso-stack release`: takes merged work on main to a published stack release. Each run does the next step and
// says which, so it is safe to run again at any time:
//   1. a component whose source is this monorepo (`monorepo_path` in stack.manifest.json) is pinned behind the
//      newest main commit that touches its paths (lib/sources.mjs): pin it there, run the gate in a throwaway worktree, push
//      `stack/pins-<sha8>` and open the PR (an older open pins PR is closed as superseded);
//   2. that PR is still open: say so and change nothing;
//   3. every such pin is current and main's stack has changes no release holds: tag the newest commit touching the
//      stack `stack-<YYYYMMDD>-<HHMM>-<sha8>` and publish a GitHub release (never marked Latest: SISO Code's
//      laptop builds own that);
//   4. otherwise: nothing new, nothing changed.
// Components with their own repository (borrowed engines such as Herdr, and the published sisodias repos) keep
// their pins: each moves by its own PR. A machine then installs a release with `siso-stack install --release TAG`.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { monorepoPaths } from './sources.mjs';

export const STACK_PATH = 'agents/harness/stack';
const MANIFEST = `${STACK_PATH}/stack.manifest.json`;
const SHOWN = 30; // changes printed to the terminal; the PR body and release notes carry all of them

function run(command, args, configuration = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...configuration });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  return result.stdout.trim();
}

function parse(args) {
  const parsed = { gate: 'sh check.sh', dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => {
      const next = args[++index];
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === '--checkout') parsed.checkout = value();
    else if (arg === '--gate') parsed.gate = value();
    else if (arg === '--dry-run') parsed.dryRun = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

export function release(args, defaults) {
  try {
    return publish({ ...defaults, ...parse(args) });
  } catch (error) {
    console.error(`ERROR ${error.message}`);
    return 1;
  }
}

// Commits in `ranges` (each { from, to, paths }; no `from` means all history), newest first, as PR number and title.
function changes(git, ranges) {
  const seen = new Map();
  for (const { from, to, paths } of ranges) {
    for (const line of git('log', '--format=%H%x09%ct%x09%s', from ? `${from}..${to}` : to, '--', ...paths).split('\n').filter(Boolean)) {
      const [sha, time, subject] = line.split('\t');
      const pr = subject.match(/^(.*?)\s*\(#(\d+)\)$/);
      seen.set(sha, { sha, time: Number(time), pr: pr ? Number(pr[2]) : null, title: pr ? pr[1] : subject });
    }
  }
  return [...seen.values()].sort((a, b) => b.time - a.time);
}

const changeLine = (change) => (change.pr ? `#${change.pr} ${change.title}` : `${change.sha.slice(0, 8)} ${change.title}`);

function printChanges(list, since) {
  console.log(`ADDS  ${list.length} change(s) since ${since}${list.length > SHOWN ? ` (newest ${SHOWN} shown; all are in the PR or release notes)` : ''}`);
  for (const change of list.slice(0, SHOWN)) console.log(`      ${changeLine(change)}`);
}

export function publish(options) {
  const repo = options.checkout;
  const git = (...args) => run('git', ['-C', repo, ...args]);
  const gh = (...args) => run(process.env.SISO_STACK_GH || 'gh', args);
  const isAncestor = (ancestor, of) => spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', ancestor, of]).status === 0;
  if (spawnSync('git', ['-C', repo, 'rev-parse', '--git-dir']).status !== 0) throw new Error(`${repo} is not a git checkout: pass --checkout with a sisodias/siso lane`);
  if (git('rev-parse', '--is-shallow-repository') === 'true') {
    throw new Error(`${repo} is a shallow copy (an installed release?): run release from a sisodias/siso lane with history, or pass --checkout LANE`);
  }
  git('fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  const main = git('rev-parse', 'refs/remotes/origin/main');
  const manifest = JSON.parse(git('show', `${main}:${MANIFEST}`));
  const monorepo = manifest.monorepo.repository;
  const slug = monorepo.match(/github\.com[/:](.+?)(?:\.git)?$/)?.[1];
  if (!slug) throw new Error(`monorepo.repository is not a GitHub URL: ${monorepo}`);
  const own = manifest.components.filter((component) => component.monorepo_path);
  const show = (path) => {
    const shown = spawnSync('git', ['-C', repo, 'show', `${main}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return shown.status === 0 ? shown.stdout : null;
  };
  const sources = new Map(own.map((component) => [component.id, monorepoPaths(component, show)]));
  const ownPaths = [...new Set(own.flatMap((component) => sources.get(component.id)))];
  const paths = [STACK_PATH, ...ownPaths];
  const newest = (at, ...within) => git('log', '-1', '--format=%H', at, '--', ...within);
  const pins = own.map((component) => ({ component, to: newest(main, ...sources.get(component.id)) }));
  const lagging = pins.filter(({ component, to }) => component.revision !== to || component.repository !== monorepo);
  const where = (component) => {
    const outside = sources.get(component.id).length - 1;
    return `${component.monorepo_path}${outside ? ` and ${outside} skill source(s) outside it` : ''}`;
  };
  for (const { component, to } of pins) {
    console.log(lagging.some((pin) => pin.component === component)
      ? `PIN   ${component.id} ${component.revision.slice(0, 12)} -> ${to.slice(0, 12)} (newest main commit touching ${where(component)})`
      : `KEEP  ${component.id} ${to.slice(0, 12)} (current: ${where(component)})`);
  }
  for (const component of manifest.components.filter((candidate) => !candidate.monorepo_path)) {
    console.log(`KEEP  ${component.id} ${component.revision.slice(0, 12)} (own repository: moves by its own PR)`);
  }
  const tags = run('git', ['-C', repo, 'ls-remote', '--tags', '--refs', 'origin', 'refs/tags/stack-*']).split('\n').filter(Boolean)
    .map((line) => { const [sha, ref] = line.split('\t'); return { sha, tag: ref.replace('refs/tags/', '') }; })
    .sort((a, b) => a.tag.localeCompare(b.tag));

  // What a release at `to` adds: everything since the newest earlier release; before the first release, each
  // component since its previous pin (`previous` gives it) and the distribution since its start.
  const added = (to, previous) => {
    const earlier = tags.filter((entry) => entry.sha !== to && isAncestor(entry.sha, to)).at(-1);
    if (earlier) return { since: earlier.tag, list: changes(git, [{ from: earlier.sha, to, paths }]) };
    const ranges = [{ from: null, to, paths: [STACK_PATH] }, ...own.map((component) => {
      const from = previous(component);
      return { from: from && isAncestor(from, to) ? from : null, to, paths: sources.get(component.id) };
    })];
    return { since: 'the previous pins (no earlier stack release)', list: changes(git, ranges) };
  };

  if (lagging.length) return openPinsPullRequest();
  return publishRelease();

  function openPinsPullRequest() {
    const head = newest(main, ...ownPaths);
    const branch = `stack/pins-${head.slice(0, 8)}`;
    const { since, list } = added(main, (component) => component.revision);
    printChanges(list, since);
    const open = JSON.parse(gh('pr', 'list', '--repo', slug, '--state', 'open', '--json', 'number,url,headRefName', '--limit', '500'))
      .filter((pull) => pull.headRefName.startsWith('stack/pins-'));
    const same = open.find((pull) => pull.headRefName === branch);
    if (same) {
      console.log(`WAIT  ${same.url} already holds these pins: merge it once its checks are green, then run siso-stack release again. Nothing changed.`);
      return 0;
    }
    if (options.dryRun) {
      console.log(`DRY   would pin ${lagging.map(({ component }) => component.id).join(', ')}, run \`${options.gate}\`, push ${branch} and open its PR`);
      return 0;
    }
    const work = mkdtempSync(join(tmpdir(), 'siso-stack-release-'));
    try {
      git('worktree', 'add', '-q', '--no-checkout', '--detach', work, main);
      const inWork = (...args) => run('git', ['-C', work, ...args]);
      inWork('sparse-checkout', 'set', ...paths);
      inWork('checkout', '-q', '--detach', main);
      const file = join(work, MANIFEST);
      // Edit the text, not a re-serialised object, so the PR diff is the pins alone. Each edit stays inside its
      // component's block (from its "id" to the next one): two components may share a revision.
      let text = readFileSync(file, 'utf8');
      const edit = (id, field, from, to) => {
        const start = text.indexOf(`"id": "${id}"`);
        const next = text.indexOf('"id": "', start + 1);
        const end = next === -1 ? text.length : next;
        const block = text.slice(start, end);
        if (start === -1 || block.split(`"${field}": "${from}"`).length !== 2) throw new Error(`${MANIFEST}: no single ${field} ${from} in component ${id}`);
        text = text.slice(0, start) + block.replace(`"${field}": "${from}"`, `"${field}": "${to}"`) + text.slice(end);
      };
      for (const { component, to } of lagging) {
        edit(component.id, 'revision', component.revision, to);
        if (component.repository !== monorepo) edit(component.id, 'repository', component.repository, monorepo);
      }
      const bumped = JSON.parse(text);
      const expected = manifest.components.map((component) => {
        const pin = lagging.find((entry) => entry.component === component);
        return pin ? { ...component, revision: pin.to, repository: monorepo } : component;
      });
      if (JSON.stringify(bumped) !== JSON.stringify({ ...manifest, components: expected })) throw new Error(`${MANIFEST}: the edit changed more than the pins`);
      writeFileSync(file, text);
      console.log(`GATE  \`${options.gate}\` in ${STACK_PATH} (a clean install from the new pins: takes minutes)`);
      const gate = spawnSync('sh', ['-c', options.gate], { cwd: join(work, STACK_PATH), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const output = `${gate.stdout || ''}\n${gate.stderr || ''}`;
      const summary = output.split('\n')
        .filter((line) => /^# (tests|pass|fail)\b|^not ok\b|^(PASS|FAIL)\b/.test(line)).slice(-12).join('\n');
      console.log(summary.replace(/^/gm, '      '));
      // The worktree goes when this run ends: the whole gate output stays beside the checkout's git data.
      const log = join(git('rev-parse', '--path-format=absolute', '--git-common-dir'), 'siso-stack-gate.log');
      writeFileSync(log, output);
      if (gate.status !== 0) throw new Error(`gate \`${options.gate}\` failed (exit ${gate.status}): nothing pushed; its whole output is in ${log}`);
      const ids = lagging.map(({ component }) => component.id).join(', ');
      const title = `stack: pin ${ids} to main (${head.slice(0, 8)})`;
      const table = lagging.map(({ component, to }) => `| ${component.id} | \`${component.monorepo_path}\` | ${component.revision.slice(0, 12)} | ${to.slice(0, 12)} |`);
      const body = [
        'Made by `siso-stack release`: each component whose source is this monorepo moves to the newest main commit that touches its path. Components with their own repository keep their pins.',
        '', '| component | path | from | to |', '|---|---|---|---|', ...table,
        '', `## What the release adds (${list.length}, since ${since})`, '', ...list.map((change) => `- ${changeLine(change)}`),
        '', `## Gate: \`${options.gate}\` (local, ${STACK_PATH})`, '', '```', summary, '```',
        '', 'After merge, run `siso-stack release` again to publish the release, then `siso-stack install --release latest` on each machine.'
      ].join('\n');
      inWork('commit', '-q', '-m', title, '-m', 'Made by siso-stack release.', '--', MANIFEST);
      inWork('push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
      const bodyFile = join(work, '.pins-pr.md');
      writeFileSync(bodyFile, body);
      const url = gh('pr', 'create', '--repo', slug, '--base', 'main', '--head', branch, '--title', title, '--body-file', bodyFile).split('\n').at(-1);
      for (const old of open) {
        gh('pr', 'close', String(old.number), '--repo', slug, '--comment', `Superseded by ${url}`, '--delete-branch');
        console.log(`CLOSED ${old.url} (superseded)`);
      }
      console.log(`OPENED ${url}`);
      console.log('NEXT  merge it once its checks are green, then run siso-stack release again to publish the release');
      return 0;
    } finally {
      spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', work]);
      rmSync(work, { recursive: true, force: true });
    }
  }

  function publishRelease() {
    const target = newest(main, ...paths);
    const tagged = tags.find((entry) => entry.sha === target);
    const released = tagged && spawnSync(process.env.SISO_STACK_GH || 'gh', ['release', 'view', tagged.tag, '--repo', slug, '--json', 'tagName']).status === 0;
    if (released) {
      console.log(`NOTHING NEW  release ${tagged.tag} already holds main's stack (${target.slice(0, 12)}) and every monorepo pin is current. Nothing changed.`);
      return 0;
    }
    const stamp = new Date(Number(git('show', '-s', '--format=%ct', target)) * 1000).toISOString();
    const tag = tagged?.tag || `stack-${stamp.slice(0, 10).replaceAll('-', '')}-${stamp.slice(11, 16).replace(':', '')}-${target.slice(0, 8)}`;
    // Before the first release, a component's previous pin is the one its last pin change replaced.
    const previousPin = (component) => {
      for (const commit of git('log', '--format=%H', target, '--', MANIFEST).split('\n').filter(Boolean)) {
        const before = spawnSync('git', ['-C', repo, 'show', `${commit}^:${MANIFEST}`], { encoding: 'utf8' });
        if (before.status !== 0) return null;
        const prior = JSON.parse(before.stdout).components.find((candidate) => candidate.id === component.id);
        if (prior && prior.revision !== component.revision) return prior.revision;
      }
      return null;
    };
    const { since, list } = added(target, previousPin);
    printChanges(list, since);
    if (options.dryRun) {
      console.log(`DRY   would tag ${target.slice(0, 12)} ${tag} and publish its release`);
      return 0;
    }
    if (!tagged) git('push', '-q', 'origin', `${target}:refs/tags/${tag}`);
    const notes = [
      `SISO Agent Stack at \`${target}\`: the distribution (\`${STACK_PATH}\`) and these pins.`, '',
      '| component | revision | source |', '|---|---|---|',
      ...manifest.components.map((component) => `| ${component.id} | ${component.revision.slice(0, 12)} | ${component.monorepo_path && component.repository === monorepo ? `\`${component.monorepo_path}\`` : component.repository} |`),
      '', `## What it adds (${list.length}, since ${since})`, '', ...list.map((change) => `- ${changeLine(change)}`),
      '', '## Install', '', '```', `siso-stack install --release ${tag}`, 'siso-stack doctor', '```'
    ].join('\n');
    const work = mkdtempSync(join(tmpdir(), 'siso-stack-notes-'));
    try {
      writeFileSync(join(work, 'notes.md'), notes);
      const url = gh('release', 'create', tag, '--repo', slug, '--verify-tag', '--latest=false', '--title', `SISO Agent Stack ${tag}`, '--notes-file', join(work, 'notes.md')).split('\n').at(-1);
      console.log(`PUBLISHED ${tag} ${url}`);
      console.log(`INSTALL siso-stack install --release ${tag}`);
      return 0;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
