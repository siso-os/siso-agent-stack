#!/usr/bin/env node
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { archiveRoot, installSkill, linkSkill, planSkill, skillDoctor, skillStoreCollisions } from '../lib/skill-home.mjs';
import { withManagedBlock } from '../lib/managed-block.mjs';
import { monorepoPaths } from '../lib/sources.mjs';

const distributionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(distributionRoot, 'stack.manifest.json'), 'utf8'));
const operation = process.argv[2] || '';
// `release` works on a sisodias/siso lane and GitHub, never on an installed home: it takes its own options.
if (operation === 'release') {
  const { release } = await import('../lib/release.mjs');
  process.exit(release(process.argv.slice(3), { checkout: resolve(distributionRoot, '..', '..', '..') }));
}
let options;
try {
  options = parseOptions(process.argv.slice(3));
} catch (error) {
  console.error(`ERROR ${error.message}`);
  printUsage();
  process.exit(2);
}
const targetHome = resolve(options.home || homedir());
const stackRoot = resolve(options.root || join(targetHome, '.siso', 'agent-stack'));
const repositoriesRoot = join(stackRoot, 'repos');
const profileRoot = join(stackRoot, 'profile');
const binRoot = join(targetHome, '.local', 'bin');
const receiptPath = join(stackRoot, 'install-receipt.json');
const defaultClaudeDir = join(targetHome, '.claude');
// Extra Claude config dirs (one per account, the CLAUDE_CONFIG_DIR a seat runs with). They get the same
// profile block, agent links, skill links and managed hooks as ~/.claude, all pointing at one source.
// A re-run without flags keeps the seats and hook selection recorded by the last install.
const savedReceipt = (() => {
  try { return JSON.parse(readFileSync(receiptPath, 'utf8')); } catch { return {}; }
})();
const savedClaudeDirs = savedReceipt.claude_dirs || [];
if (!options.hooks && Array.isArray(savedReceipt.hooks)) options.hooks = savedReceipt.hooks;
if (!options.skills && Array.isArray(savedReceipt.skills)) options.skills = savedReceipt.skills;
if (operation === 'install' && savedReceipt.selection && !process.argv.includes('--full')) {
  options.requiredOnly ||= savedReceipt.selection.required_only;
  options.noExternal ||= savedReceipt.selection.no_external;
}
if (options.hooks && options.hooks.length === 1 && options.hooks[0] === 'all') options.hooks = null;
if (options.skills && options.skills.length === 1 && options.skills[0] === 'curated') options.skills = null;
// --from-checkout: components with a `monorepo_path` are read from the sisodias/siso checkout this stack runs
// from (at its HEAD), instead of their pinned mirror repos. The receipt remembers it; --from-pins drops it, and so
// does --release (a release installs at its pins, so a machine last installed from a checkout moves to it).
if (options.fromPins || options.release) options.fromCheckout = false;
else if (options.fromCheckout === undefined && savedReceipt.from_checkout) options.fromCheckout = true;
const monorepoRoot = resolve(distributionRoot, '..', '..', '..');
// A dry run of `install --release` runs the release's own installer from a temporary copy; this names the folder that
// copy will sit in once installed, so the plan shows the siso-stack shim as it will be written.
const plannedDistributionRoot = (options.dryRun && process.env.SISO_STACK_DISTRIBUTION_AS) || distributionRoot;
// Seats. ~/.claude is always written. `--seat DIR` writes only the named seats; every other seat the receipt
// knows is held exactly as it was (never written) and doctor checks it against its own record, so one
// house's seat can refresh itself without naming, or touching, another house's seat. `--claude-dir` keeps
// its old meaning: the named seats replace the seat list. A plain re-run writes the seats the last run wrote.
const savedSeats = savedReceipt.seats && typeof savedReceipt.seats === 'object' ? savedReceipt.seats : {};
const uniqueSeats = (paths) => [...new Set(paths.map((path) => resolve(path)))].filter((path) => path !== defaultClaudeDir);
const knownSeats = uniqueSeats([...savedClaudeDirs, ...Object.keys(savedSeats)]);
const writtenSeats = uniqueSeats(options.claudeDirs?.length ? options.claudeDirs
  : options.seats?.length ? options.seats
    : Array.isArray(savedReceipt.run_seats) ? savedReceipt.run_seats : knownSeats);
const heldSeats = options.claudeDirs?.length ? [] : knownSeats.filter((path) => !writtenSeats.includes(path));
const writeDirs = [defaultClaudeDir, ...writtenSeats];
const claudeDirs = [...writeDirs, ...heldSeats];
const extraClaudeDirs = claudeDirs.filter((path) => path !== defaultClaudeDir);
const failures = [];

function parseOptions(args) {
  const parsed = {};
  const valueAfter = (index, option) => {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--claude-dir' && args.includes('--seat')) throw new Error('--claude-dir replaces the seat list and --seat holds the others: pass one of them');
    if (arg === '--release' && args.includes('--from-checkout')) throw new Error('--release installs a published release at its pins and --from-checkout reads this checkout: pass one of them');
    if (arg === '--home') parsed.home = valueAfter(index++, '--home');
    else if (arg === '--root') parsed.root = valueAfter(index++, '--root');
    else if (arg === '--source-root') parsed.sourceRoot = resolve(valueAfter(index++, '--source-root'));
    else if (arg === '--hooks') parsed.hooks = valueAfter(index++, '--hooks').split(',').map((id) => id.trim()).filter(Boolean);
    else if (arg === '--skills') parsed.skills = valueAfter(index++, '--skills').split(',').map((id) => id.trim()).filter(Boolean);
    else if (arg === '--claude-dir') (parsed.claudeDirs ||= []).push(valueAfter(index++, '--claude-dir'));
    else if (arg === '--seat') (parsed.seats ||= []).push(valueAfter(index++, '--seat'));
    else if (arg === '--seat-hooks') parsed.seatHooks = valueAfter(index++, '--seat-hooks').split(',').map((id) => id.trim()).filter(Boolean);
    else if (arg === '--release') parsed.release = valueAfter(index++, '--release');
    else if (arg === '--from-checkout') parsed.fromCheckout = true;
    else if (arg === '--from-pins') parsed.fromPins = true;
    else if (arg === '--required-only') parsed.requiredOnly = true;
    else if (arg === '--no-external') parsed.noExternal = true;
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--full') parsed.full = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function printUsage() {
  console.log('Usage: siso-stack <install|doctor|plan> [--home PATH] [--root PATH] [--claude-dir PATH]... | [--seat PATH]... [--seat-hooks ID,ID|all] [--hooks ID,ID|all] [--skills ID,ID|curated] [--release TAG|latest | --from-checkout | --from-pins] [--source-root PATH] [--required-only] [--no-external] [--full] [--dry-run]');
  console.log('       siso-stack release [--checkout PATH] [--gate CMD] [--dry-run]   (run from a sisodias/siso lane: bump monorepo pins, PR, publish)');
}

function run(command, args, configuration = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...configuration });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout.trim();
}

function componentsForSelection(selection) {
  return manifest.components.filter((component) => {
    if (selection.requiredOnly && !component.required) return false;
    if (selection.noExternal && component.install === 'external-source') return false;
    return true;
  });
}

function includedComponents() {
  return componentsForSelection(options);
}

// Commands that only work on some platforms (e.g. launchd/osascript tools) carry
// `command_platforms: { name: ["darwin"] }` and are skipped elsewhere.
function commandsFor(component) {
  const platforms = component.command_platforms || {};
  return Object.entries(component.commands || {})
    .filter(([name]) => !platforms[name] || platforms[name].includes(process.platform));
}

function fromCheckout(component) {
  return Boolean(options.fromCheckout && component.monorepo_path);
}

// A component whose `repository` is the monorepo itself is pinned to a sisodias/siso commit (`siso-stack release`
// moves it). It is fetched as that one commit with only its monorepo_path checked out, into repos/monorepo/<id>.
function monorepoPinned(component) {
  return Boolean(component.monorepo_path) && component.repository === manifest.monorepo.repository;
}

// The git checkout holding a component, and the component's own root inside it.
function checkoutRoot(component) {
  if (fromCheckout(component)) return monorepoRoot;
  return monorepoPinned(component) ? join(repositoriesRoot, 'monorepo', component.id) : join(repositoriesRoot, component.id);
}

function repositoryPath(component) {
  return fromCheckout(component) || monorepoPinned(component)
    ? join(checkoutRoot(component), component.monorepo_path) : checkoutRoot(component);
}

// One commit of a large repository: no blobs beyond `paths`, the only paths checked out. `ref` is a full commit SHA
// (skipped when already present) or `refs/tags/<tag>`. `paths` is a list, or a function that reads files at the
// fetched commit and returns one. Returns the checked-out commit.
function sparseFetch(destination, source, ref, paths) {
  const local = !/^(https?|ssh|git):\/\/|^git@/.test(source);
  if (!existsSync(join(destination, '.git'))) {
    mkdirSync(destination, { recursive: true });
    run('git', ['init', '-q', destination]);
    run('git', ['-C', destination, 'remote', 'add', 'origin', source]);
  } else {
    if (run('git', ['-C', destination, 'status', '--porcelain'])) throw new Error(`managed checkout is dirty: ${destination}`);
    const origin = run('git', ['-C', destination, 'remote', 'get-url', 'origin']);
    if (!local && origin !== source) throw new Error(`${destination}: origin ${origin} does not match ${source}`);
  }
  const present = /^[0-9a-f]{40}$/.test(ref) && spawnSync('git', ['-C', destination, 'cat-file', '-e', `${ref}^{commit}`]).status === 0;
  if (!present) run('git', ['-C', destination, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', ref.startsWith('refs/') ? `+${ref}:${ref}` : ref]);
  const commit = run('git', ['-C', destination, 'rev-parse', `${ref}^{commit}`]);
  const read = (path) => {
    const shown = spawnSync('git', ['-C', destination, 'show', `${commit}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return shown.status === 0 ? shown.stdout : null;
  };
  run('git', ['-C', destination, 'sparse-checkout', 'set', ...(typeof paths === 'function' ? paths(read) : paths)]);
  run('git', ['-C', destination, 'checkout', '-q', '--detach', commit]);
  return commit;
}

let checkoutHead = null;
function monorepoHead() {
  if (checkoutHead) return checkoutHead;
  const top = spawnSync('git', ['-C', monorepoRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0 || resolve(top.stdout.trim()) !== monorepoRoot) {
    throw new Error(`--from-checkout needs this stack to run from a sisodias/siso checkout (agents/harness/stack); ${monorepoRoot} is not one`);
  }
  checkoutHead = run('git', ['-C', monorepoRoot, 'rev-parse', 'HEAD']);
  return checkoutHead;
}

function checkoutDirt(component) {
  return run('git', ['-C', monorepoRoot, 'status', '--porcelain', '--', component.monorepo_path]);
}

function componentRecord(component) {
  if (monorepoPinned(component) && !fromCheckout(component)) return { id: component.id, revision: component.revision, repository: component.repository, path: component.monorepo_path };
  if (!fromCheckout(component)) return { id: component.id, revision: component.revision, repository: component.repository };
  return { id: component.id, revision: monorepoHead(), repository: manifest.monorepo.repository, path: component.monorepo_path };
}

function localSource(component) {
  if (!options.sourceRoot) return null;
  const candidates = [component.id, `siso-${component.id}`, component.repository.split('/').at(-1).replace(/\.git$/, '')];
  return candidates.map((candidate) => join(options.sourceRoot, candidate)).find((candidate) => existsSync(join(candidate, '.git'))) || null;
}

function materialize(component) {
  const destination = repositoryPath(component);
  if (fromCheckout(component)) {
    const head = monorepoHead();
    if (!existsSync(destination)) throw new Error(`${component.id}: ${component.monorepo_path} is missing from checkout ${monorepoRoot}`);
    if (checkoutDirt(component)) throw new Error(`${component.id}: checkout path is dirty: ${destination}`);
    console.log(`PIN   ${component.id} ${head.slice(0, 12)} (checkout ${component.monorepo_path})`);
    return;
  }
  if (monorepoPinned(component)) {
    const actual = sparseFetch(checkoutRoot(component), localSource(component) || component.repository, component.revision, (read) => monorepoPaths(component, read));
    if (actual !== component.revision) throw new Error(`${component.id}: expected ${component.revision}, got ${actual}`);
    console.log(`PIN   ${component.id} ${actual.slice(0, 12)} (${component.monorepo_path})`);
    return;
  }
  mkdirSync(repositoriesRoot, { recursive: true });
  const existingCheckout = existsSync(join(destination, '.git'));
  if (!existingCheckout) {
    const source = localSource(component) || component.repository;
    run('git', ['clone', '--no-checkout', source, destination]);
  }
  if (existingCheckout) {
    const dirty = run('git', ['-C', destination, 'status', '--porcelain']);
    if (dirty) throw new Error(`managed component is dirty: ${destination}`);
  }
  const origin = run('git', ['-C', destination, 'remote', 'get-url', 'origin']);
  if (!localSource(component) && origin !== component.repository) {
    throw new Error(`${component.id}: origin ${origin} does not match ${component.repository}`);
  }
  let hasCommit = spawnSync('git', ['-C', destination, 'cat-file', '-e', `${component.revision}^{commit}`]).status === 0;
  if (!hasCommit) {
    run('git', ['-C', destination, 'fetch', '--depth', '1', 'origin', component.revision]);
    hasCommit = true;
  }
  if (hasCommit) run('git', ['-C', destination, 'checkout', '--detach', component.revision]);
  const actual = run('git', ['-C', destination, 'rev-parse', 'HEAD']);
  if (actual !== component.revision) throw new Error(`${component.id}: expected ${component.revision}, got ${actual}`);
  console.log(`PIN   ${component.id} ${actual.slice(0, 12)}`);
}

// Where the write plan reads a component's files from: this checkout (--from-checkout), its own checkout when that
// already sits at the pin, a dry run's temporary copy, or null when it is not fetched yet.
const stagedCopies = new Map();
function readableRoot(component) {
  if (stagedCopies.has(component.id)) return stagedCopies.get(component.id);
  const root = { checkout: checkoutRoot(component), path: repositoryPath(component) };
  if (fromCheckout(component)) return existsSync(root.path) ? root : null;
  if (!existsSync(join(root.checkout, '.git'))) return null;
  const head = spawnSync('git', ['-C', root.checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return head.status === 0 && head.stdout.trim() === component.revision && existsSync(root.path) ? root : null;
}

// A dry run's row for one component checkout. A monorepo-pinned component that is not fetched yet (the Skills Hub,
// the hooks) is fetched into `stage`, a temporary folder outside the home, so the plan can list the skills and
// hooks it brings.
function componentRow(component, stage) {
  if (fromCheckout(component)) return null;
  const checkout = checkoutRoot(component);
  const pin = `${component.repository}@${component.revision.slice(0, 12)}${monorepoPinned(component) ? `, ${component.monorepo_path} only` : ''}`;
  if (readableRoot(component)) return { action: 'SAME', path: checkout, detail: `${component.id} checkout at ${pin}` };
  const row = existsSync(join(checkout, '.git'))
    ? { action: 'REPLACE', path: checkout, detail: `${component.id} checkout moves to ${pin}; stack-owned` }
    : { action: 'NEW', path: checkout, detail: `${component.id}: clone of ${pin}` };
  if (monorepoPinned(component) && !process.env.SISO_STACK_PLAN_NO_FETCH) {
    const copy = join(stage, component.id);
    try {
      sparseFetch(copy, localSource(component) || component.repository, component.revision, (read) => monorepoPaths(component, read));
      stagedCopies.set(component.id, { checkout: copy, path: join(copy, component.monorepo_path) });
    } catch (error) {
      console.error(`WARN    could not fetch ${component.id} to plan with (${error.message.split('\n')[0]}): the paths only its files name are not listed`);
    }
  }
  return row;
}

function walkFor(root, targetName, found = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkFor(path, targetName, found);
    else if (entry.name === targetName) found.push(path);
  }
  return found;
}

function lstatExists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

// What is at `path`, for a row or an error: a file, a folder, or a link and where it ends up.
function describe(path) {
  const stat = lstatSync(path);
  if (!stat.isSymbolicLink()) return stat.isDirectory() ? 'a folder' : 'a file';
  // Each hop is named, so a refusal shows every file a write through the link would have reached.
  const hops = [];
  let at = path;
  while (hops.length < 16) {
    let hop;
    try { hop = lstatSync(at); } catch { return `a link to ${hops.join(', which is a link to ')} (dangling)`; }
    if (!hop.isSymbolicLink()) break;
    at = resolve(dirname(at), readlinkSync(at));
    hops.push(at);
  }
  return `a link to ${hops.join(', which is a link to ')}`;
}

// Writes `text` to `path` as a file of its own. O_NOFOLLOW makes the open fail on a link instead of writing through it.
function writeOwnFile(path, text) {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(descriptor, text); } finally { closeSync(descriptor); }
}

// What managedLink does at `destination`: a link the stack made is replaced, anything else is someone else's.
function linkAction(source, destination) {
  if (!lstatExists(destination)) return { action: 'NEW', detail: `link to ${source}` };
  const previous = lstatSync(destination).isSymbolicLink() ? readlinkSync(destination) : null;
  if (previous === source) return { action: 'SAME', detail: `link to ${source}` };
  if (previous !== null && (previous === stackRoot || previous.startsWith(`${stackRoot}/`))) {
    return { action: 'REPLACE', detail: `the stack's link to ${previous}, now to ${source}` };
  }
  return { action: 'COLLIDE', detail: `${describe(destination)} the stack did not make; move it aside so the stack can link ${source} here` };
}

function managedLink(source, destination) {
  const { action } = linkAction(source, destination);
  if (action === 'SAME') return;
  if (action === 'COLLIDE') throw new Error(`install collision (preserved): ${destination}`);
  mkdirSync(dirname(destination), { recursive: true });
  if (action === 'REPLACE') unlinkSync(destination);
  symlinkSync(source, destination);
}

const skillsComponent = () => manifest.components.find((component) => component.id === 'skills');
let curationWarned = false;
// The skills this install selects, read from the hub at `root` (the installed checkout unless a plan names another).
function registeredSkills(root = { checkout: checkoutRoot(skillsComponent()), path: repositoryPath(skillsComponent()) }) {
  const skills = skillsComponent();
  const hub = root.path;
  // A source_path names a monorepo path, so it resolves only when the hub is a monorepo checkout.
  const monorepoCheckout = fromCheckout(skills) || monorepoPinned(skills) ? root.checkout : null;
  const registry = JSON.parse(readFileSync(join(hub, 'registry/skills_registry.json'), 'utf8'));
  // `--skills a,b` picks this machine's set from the registry; otherwise the hub's curation decides.
  // A pin older than the curation file keeps the old behaviour (whole catalog), said out loud.
  const curationFile = join(hub, 'registry/curation-20261021.json');
  const curated = existsSync(curationFile);
  if (!options.skills && !curated && !curationWarned) {
    curationWarned = true;
    console.error(`WARN  no curation file in pinned hub (${curationFile}): installing the whole catalog; pass --skills to pick`);
  }
  const keepers = options.skills ? new Set(options.skills)
    : curated ? new Set(JSON.parse(readFileSync(curationFile, 'utf8')).install_ids) : null;
  const unknown = [...(options.skills || [])].filter((id) => !registry.skills.some((entry) => entry.skill_id === id));
  if (unknown.length) throw new Error(`unknown skill id(s) not in the hub registry: ${unknown.join(', ')}`);
  const sources = new Map();
  const bundled = new Map(walkFor(join(hub, 'registry/skills'), 'SKILL.md').map(file => [basename(dirname(file)), dirname(file)]));
  for (const entry of registry.skills) {
    if (keepers && !keepers.has(entry.skill_id)) continue;
    // The hub's own bundled copy wins; then the skill's monorepo source_path (Agent Zero's skills live only there).
    const local = join(hub, 'registry/skills', entry.category, entry.skill_id);
    const viaPath = entry.source_path && monorepoCheckout ? join(monorepoCheckout, entry.source_path) : null;
    const source = existsSync(join(local, 'SKILL.md')) ? local
      : (viaPath && existsSync(join(viaPath, 'SKILL.md'))) ? viaPath : bundled.get(entry.skill_id);
    if (!source || !existsSync(join(source, 'SKILL.md'))) throw new Error(`registered skill source unavailable: ${entry.skill_id}`);
    for (const name of [entry.skill_id, ...(keepers ? [] : entry.aliases || [])]) sources.set(name, { source, files: source === viaPath ? entry.files.required : null });
  }
  return sources;
}

function installSkills() {
  const sources = registeredSkills();
  for (const [name, { source, files }] of sources) {
    installSkill(source, name, targetHome, files);
    for (const claudeDir of writtenSeats) linkSkill(name, targetHome, claudeDir);
  }
  return [...sources.keys()];
}

// What the stack had put in place before this run: the record a held seat gets when the receipt predates
// per-seat records. The old doctor held every seat to these, so they are what each seat carries.
function previousState() {
  const canonical = join(targetHome, '.agents', 'skills');
  const agents = join(profileRoot, 'agents', 'claude');
  return {
    // A link in the canonical store is someone else's (the OS, a package): doctor neither requires nor rejects it.
    skills: existsSync(canonical) ? readdirSync(canonical).filter((name) => !name.startsWith('.')
      && !name.endsWith('.install-lock') && !lstatSync(join(canonical, name)).isSymbolicLink()
      && existsSync(join(canonical, name, 'SKILL.md'))).sort() : [],
    agents: existsSync(agents) ? readdirSync(agents).filter((name) => name.endsWith('.md')).sort() : [],
    managed_hooks: savedReceipt.managed_hooks?.claude || managedHooks(readSettings(join(defaultClaudeDir, 'settings.json')))
  };
}

// The agent definitions the stack copies under profile/agents, and where it links each one: every written seat for
// Claude, ~/.codex for Codex.
function agentTargets() {
  const targets = [];
  for (const [kind, folder, extension, links] of [
    ['claude', 'agents', '.md', (entry) => writeDirs.map((dir) => join(dir, 'agents', entry))],
    ['codex', 'codex-agents', '.toml', (entry) => [join(targetHome, '.codex', 'agents', entry)]]
  ]) {
    for (const entry of readdirSync(join(distributionRoot, 'profiles', folder)).filter((name) => name.endsWith(extension)).sort()) {
      targets.push({ kind, entry, from: join(distributionRoot, 'profiles', folder, entry), copy: join(profileRoot, 'agents', kind, entry), links: links(entry) });
    }
  }
  return targets;
}

function installAgents() {
  const targets = agentTargets();
  for (const agent of targets) {
    mkdirSync(dirname(agent.copy), { recursive: true });
    copyFileSync(agent.from, agent.copy);
    for (const link of agent.links) managedLink(agent.copy, link);
  }
  return targets.filter((agent) => agent.kind === 'claude').map((agent) => agent.entry);
}

const shimMarker = '# managed by siso-agent-stack';
const isStackShim = (path) => lstatExists(path) && lstatSync(path).isFile() && readFileSync(path, 'utf8').includes(shimMarker);

// What installShim does at `destination`. Only a plain file carrying the stack's marker is the stack's to rewrite.
function shimAction(destination, content) {
  if (!lstatExists(destination)) return { action: 'NEW', detail: 'command shim' };
  if (lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isFile()) {
    return { action: 'COLLIDE', detail: `${describe(destination)}: the stack never writes through a link or over a folder` };
  }
  if (!isStackShim(destination)) return { action: 'COLLIDE', detail: `a file the stack did not write (no "${shimMarker}" line)` };
  const same = readFileSync(destination, 'utf8') === content && (lstatSync(destination).mode & 0o777) === 0o755;
  return same ? { action: 'SAME', detail: 'command shim' } : { action: 'REPLACE', detail: 'the stack\'s command shim' };
}

function installShim(name, executable) {
  const destination = join(binRoot, name);
  const content = shimContent(executable);
  const { action } = shimAction(destination, content);
  if (action === 'COLLIDE') throw new Error(`command collision (preserved): ${destination}`);
  if (action === 'SAME') return;
  mkdirSync(binRoot, { recursive: true });
  writeOwnFile(destination, content);
  chmodSync(destination, 0o755);
}

function shimContent(executable) {
  return `#!/bin/sh\n${shimMarker}\nexec '${executable.replaceAll("'", "'\\''")}' "$@"\n`;
}

function exactManagedLink(source, destination) {
  return lstatExists(destination)
    && lstatSync(destination).isSymbolicLink()
    && readlinkSync(destination) === source;
}

// The component shims this run writes, and the stack's shims it removes for commands this platform skips.
function commandTargets(components) {
  const write = [];
  const remove = [];
  for (const component of components) {
    const kept = new Set(commandsFor(component).map(([name]) => name));
    for (const name of Object.keys(component.commands || {})) {
      if (!kept.has(name) && isStackShim(join(binRoot, name))) remove.push(join(binRoot, name));
    }
    for (const [name, relative] of commandsFor(component)) {
      write.push({ name, component, relative, executable: join(repositoryPath(component), relative) });
    }
  }
  return { write, remove };
}

function installCommands(components) {
  const { write, remove } = commandTargets(components);
  for (const shim of remove) unlinkSync(shim);
  for (const { name, component, relative, executable } of write) {
    if (!existsSync(executable)) throw new Error(`${component.id}: missing command ${relative}`);
    installShim(name, executable);
  }
  return write.length;
}

function installDistributionCommand() {
  installShim('siso-stack', join(distributionRoot, 'bin', 'siso-stack.mjs'));
  return 1;
}

// The instruction files that get the stack's block: each written seat's CLAUDE.md and ~/.codex/AGENTS.md.
function profileTargets() {
  return [
    ...writeDirs.map((dir) => ({ path: join(dir, 'CLAUDE.md'), block: `@${join(profileRoot, 'claude.md')}` })),
    { path: join(targetHome, '.codex', 'AGENTS.md'), block: `Read and follow the portable profile at ${join(profileRoot, 'codex.md')}.` }
  ];
}

// What replaceManagedBlock does to `path`, and the text it would write. A link is refused, never written through:
// when ~/.codex/AGENTS.md links to a shared brain file, the Codex block would land in every seat that imports it.
function blockAction(path, block) {
  if (!lstatExists(path)) return { action: 'NEW', detail: 'profile block', next: withManagedBlock('', block) };
  if (lstatSync(path).isSymbolicLink()) {
    return { action: 'COLLIDE', detail: `${describe(path)}: the stack never writes through a link; make it this tool's own file` };
  }
  if (!lstatSync(path).isFile()) return { action: 'COLLIDE', detail: `${describe(path)}, not a file` };
  const existing = readFileSync(path, 'utf8');
  const next = withManagedBlock(existing, block);
  return existing === next ? { action: 'SAME', detail: 'profile block', next }
    : { action: 'REPLACE', detail: `profile block; the old file is kept as ${basename(path)}.siso-backup-<ms>`, next };
}

function replaceManagedBlock(path, block) {
  const { action, detail, next } = blockAction(path, block);
  if (action === 'COLLIDE') throw new Error(`refusing to write ${path}: it is ${detail}`);
  if (action === 'SAME') return;
  mkdirSync(dirname(path), { recursive: true });
  if (action === 'REPLACE') copyFileSync(path, `${path}.siso-backup-${Date.now()}`);
  writeOwnFile(path, next);
}

function installProfiles() {
  mkdirSync(profileRoot, { recursive: true });
  for (const name of ['claude.md', 'codex.md']) copyFileSync(join(distributionRoot, 'profiles', name), join(profileRoot, name));
  for (const { path, block } of profileTargets()) replaceManagedBlock(path, block);
}

// What the hook steps do to a settings file (siso-hooks install, the --hooks selection, a seat's mirror).
function configAction(path) {
  if (!lstatExists(path)) return { action: 'NEW', detail: 'managed hook groups' };
  if (lstatSync(path).isSymbolicLink()) return { action: 'COLLIDE', detail: `${describe(path)}: the stack never writes through a link` };
  return { action: 'MERGE', detail: 'managed hook groups rewritten, every other key kept; a .siso-backup-<ms> copy is kept when it changes' };
}

// Every path an install writes under the home, in the order it writes them, as rows of { action, path, detail }:
//   NEW      absent: created
//   SAME     already what the stack would write: left alone
//   REPLACE  rewritten; the detail says where the old one goes, or that it is the stack's own
//   ARCHIVE  moved aside whole, never deleted; the detail says where
//   REMOVE   the stack's shim for a command this platform skips
//   MERGE    an existing file the stack adds its part to, keeping the rest
//   COLLIDE  refused: someone else's file, or a link the stack would write through
// A real install exits before its first write when any row is COLLIDE; the dry run prints every row. A component not
// fetched yet adds only the rows known without its files; no collision depends on them. Also stops, before any
// write, on what would stop the install later: an unknown skill or hook id, a missing skill source or command.
function planHomeWrites(components) {
  const rows = [];
  const add = (path, { action, detail = '' }) => rows.push({ action, path, detail });
  const stackCopy = (from, to) => !lstatExists(to) ? { action: 'NEW', detail: 'stack-owned copy' }
    : readFileSync(from).equals(readFileSync(to)) ? { action: 'SAME', detail: 'stack-owned copy' } : { action: 'REPLACE', detail: 'stack-owned copy' };
  for (const name of ['claude.md', 'codex.md']) add(join(profileRoot, name), stackCopy(join(distributionRoot, 'profiles', name), join(profileRoot, name)));
  for (const { path, block } of profileTargets()) add(path, blockAction(path, block));
  for (const agent of agentTargets()) {
    add(agent.copy, stackCopy(agent.from, agent.copy));
    for (const link of agent.links) add(link, linkAction(agent.copy, link));
  }
  rows.push(...skillStoreCollisions(targetHome, writtenSeats));
  const hub = readableRoot(skillsComponent());
  if (hub) {
    for (const [name, { source, files }] of registeredSkills(hub)) rows.push(...planSkill(source, name, targetHome, files, writtenSeats));
    const manifestFile = join(targetHome, '.claude', 'backups', 'dot-agents-20261021', 'MANIFEST.txt');
    if (rows.some((row) => row.detail.includes(archiveRoot(targetHome)))) {
      add(manifestFile, { action: lstatExists(manifestFile) ? 'MERGE' : 'NEW', detail: 'one line per archived path' });
    }
  } else add(join(targetHome, '.agents', 'skills'), { action: 'NEW', detail: 'the selected skills; listed once the Skills Hub pin is fetched' });
  const { write, remove } = commandTargets(components);
  for (const shim of remove) add(shim, { action: 'REMOVE', detail: 'the stack\'s shim for a command this platform skips' });
  for (const { name, component, relative, executable } of [...write, { name: 'siso-stack', executable: join(plannedDistributionRoot, 'bin', 'siso-stack.mjs') }]) {
    const root = component && readableRoot(component);
    if (root && !existsSync(join(root.path, relative))) throw new Error(`${component.id}: missing command ${relative}`);
    add(join(binRoot, name), shimAction(join(binRoot, name), shimContent(executable)));
  }
  const hooks = manifest.components.find((component) => component.id === 'hooks');
  const hooksRoot = readableRoot(hooks);
  const payload = hooksRoot ? join(targetHome, '.siso', 'agent-hooks', JSON.parse(readFileSync(join(hooksRoot.path, 'hooks.manifest.json'), 'utf8')).version)
    : join(targetHome, '.siso', 'agent-hooks');
  if (hooksRoot && options.hooks) hookCommandPrefixes(hooks, options.hooks, hooksRoot.path);
  for (const seat of writtenSeats) {
    for (const id of (options.hooks && seatHookIds(seat)) || []) {
      if (!options.hooks.includes(id)) throw new Error(`seat hook ${id} is not in --hooks (${options.hooks.join(',')}): a seat mirrors ~/.claude's hooks`);
    }
  }
  add(payload, { action: lstatExists(payload) ? 'REPLACE' : 'NEW', detail: 'hook payload, stack-owned' });
  for (const path of [join(defaultClaudeDir, 'settings.json'), join(targetHome, '.codex', 'hooks.json'), ...writtenSeats.map((seat) => join(seat, 'settings.json'))]) {
    add(path, configAction(path));
  }
  add(receiptPath, { action: lstatExists(receiptPath) ? 'REPLACE' : 'NEW', detail: 'install receipt, stack-owned' });
  return rows;
}

// Stops the install, naming every collision, when the plan has any. `before` says what has not happened yet.
function refuseCollisions(rows, before) {
  const collisions = rows.filter((row) => row.action === 'COLLIDE');
  if (!collisions.length) return;
  for (const row of collisions) console.error(`COLLIDE ${row.path}: ${row.detail}`);
  console.error(`REFUSED: ${collisions.length} path(s) above are not the stack's to write, so the install stopped before ${before}. Move each aside (or make it its tool's own file) and run it again; siso-stack install --dry-run lists every write.`);
  process.exit(1);
}

function printRows(rows) {
  for (const row of rows) console.log(`${row.action.padEnd(7)} ${row.path}${row.detail ? `  (${row.detail})` : ''}`);
}

// `install --dry-run`: every path the install would write under the home, and nothing written there.
function dryRun(components) {
  const stage = mkdtempSync(join(tmpdir(), 'siso-stack-plan-'));
  let rows;
  try {
    rows = components.map((component) => componentRow(component, stage)).filter(Boolean);
    rows.push(...planHomeWrites(components));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  printRows(rows);
  for (const component of components.filter(fromCheckout)) console.log(`USE     ${repositoryPath(component)}  (${component.id} from this checkout, not written)`);
  for (const seat of heldSeats) console.log(`HOLD    ${seat}  (not written on this run)`);
  const counts = {};
  for (const row of rows) counts[row.action] = (counts[row.action] || 0) + 1;
  const collisions = counts.COLLIDE || 0;
  console.log(`PLAN ${rows.length} paths: ${Object.entries(counts).map(([action, count]) => `${count} ${action}`).join(', ')}. ${collisions
    ? `${collisions} COLLIDE: the install would refuse before its first write.` : 'No collisions.'}`);
}

function installHooks() {
  const hooks = manifest.components.find((component) => component.id === 'hooks');
  const cli = join(repositoryPath(hooks), 'bin', 'siso-hooks.mjs');
  run(process.execPath, [cli, 'install', '--home', targetHome]);
  if (options.hooks) selectHooks(hooks, options.hooks);
  const written = {};
  for (const claudeDir of writtenSeats) {
    const ids = seatHookIds(claudeDir);
    for (const id of (options.hooks && ids) || []) {
      if (!options.hooks.includes(id)) throw new Error(`seat hook ${id} is not in --hooks (${options.hooks.join(',')}): a seat mirrors ~/.claude's hooks`);
    }
    written[claudeDir] = mirrorManagedHooks(join(defaultClaudeDir, 'settings.json'), join(claudeDir, 'settings.json'),
      ids ? hookCommandPrefixes(hooks, ids) : null);
  }
  return written;
}

// `--seat-hooks a,b` gives the seats named on this run a subset of ~/.claude's hooks (`all` clears it). A seat
// keeps the subset it was given until a later run names another, so a plain re-run never widens it.
function seatHookIds(seat) {
  if (options.seatHooks) return options.seatHooks.length === 1 && options.seatHooks[0] === 'all' ? null : options.seatHooks;
  return Array.isArray(savedSeats[seat]?.seat_hooks) ? savedSeats[seat].seat_hooks : null;
}

// The command prefix each selected hook id installs as (`node '<payload>/<file>'`), by hooks.manifest.json id, read
// from the hooks checkout at `source`.
function hookCommandPrefixes(hooksComponent, ids, source = repositoryPath(hooksComponent)) {
  const hooksManifest = JSON.parse(readFileSync(join(source, 'hooks.manifest.json'), 'utf8'));
  const files = new Map(hooksManifest.hooks.map((hook) => [hook.id, hook.file]));
  for (const id of ids) if (!files.has(id)) throw new Error(`unknown hook id: ${id}`);
  const root = join(targetHome, '.siso', 'agent-hooks', hooksManifest.version);
  return ids.map((id) => `node '${join(root, files.get(id)).replaceAll("'", "'\\''")}'`);
}

const groupKept = (group, keep) => !isManagedHookGroup(group)
  || group.hooks.every((hook) => keep.some((prefix) => hook.command === prefix || hook.command.startsWith(`${prefix} `)));

// `--hooks safety-guard,...` keeps only those SISO hooks (by hooks.manifest.json id) in the Claude and Codex
// configs. The payload stays complete; the receipt records the resulting managed groups for doctor.
function selectHooks(hooksComponent, ids) {
  const keep = hookCommandPrefixes(hooksComponent, ids);
  for (const path of [join(defaultClaudeDir, 'settings.json'), join(targetHome, '.codex', 'hooks.json')]) {
    if (!existsSync(path)) continue;
    const settings = readSettings(path);
    for (const event of Object.keys(settings.hooks || {})) {
      settings.hooks[event] = settings.hooks[event].filter((group) => groupKept(group, keep));
      if (!settings.hooks[event].length) delete settings.hooks[event];
    }
    writeOwnFile(path, `${JSON.stringify(settings, null, 2)}\n`);
  }
}

const isManagedHookGroup = (group) => (group.hooks || []).some((hook) =>
  typeof hook.command === 'string' && hook.command.includes('/.siso/agent-hooks/'));

function managedHooks(settings) {
  const out = {};
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    const managed = groups.filter(isManagedHookGroup);
    if (managed.length) out[event] = managed;
  }
  return out;
}

function readSettings(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

// Copy SISO-managed hook groups from ~/.claude/settings.json into a seat's settings.json (only the groups of
// `keep`'s hooks when given), keeping every unmanaged key and hook in the seat untouched. Backs the seat file
// up first when it changes. Returns the managed groups the seat now carries.
function mirrorManagedHooks(fromPath, toPath, keep = null) {
  const wanted = managedHooks(readSettings(fromPath));
  if (keep) {
    for (const event of Object.keys(wanted)) {
      wanted[event] = wanted[event].filter((group) => groupKept(group, keep));
      if (!wanted[event].length) delete wanted[event];
    }
  }
  const prior = existsSync(toPath) ? readFileSync(toPath, 'utf8') : null;
  const settings = prior ? JSON.parse(prior) : {};
  const hooks = settings.hooks || {};
  for (const event of Object.keys(hooks)) {
    hooks[event] = hooks[event].filter((group) => !isManagedHookGroup(group));
    if (!hooks[event].length) delete hooks[event];
  }
  for (const [event, groups] of Object.entries(wanted)) hooks[event] = [...(hooks[event] || []), ...groups];
  if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
  const next = `${JSON.stringify(settings, null, 2)}\n`;
  if (prior === next) return wanted;
  mkdirSync(dirname(toPath), { recursive: true });
  if (prior !== null) writeFileSync(`${toPath}.siso-backup-${Date.now()}`, prior, { mode: 0o600 });
  writeOwnFile(toPath, next);
  return wanted;
}

// Managed hook groups compared by event, whatever order the events sit in a settings file.
// Keys sorted at every level: Codex saves hooks.json again with its keys reordered, which changes no hook.
const sortedKeys = (value) => (Array.isArray(value) ? value.map(sortedKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys(value[key])])) : value);
const hooksKey = (hooks) => JSON.stringify(sortedKeys(hooks || {}));

// The published stack releases: tags `stack-<YYYYMMDD>-<HHMM>-<sha8>` on the monorepo, so name order is time order.
function releaseTags() {
  return run('git', ['ls-remote', '--tags', '--refs', manifest.monorepo.repository, 'refs/tags/stack-*'])
    .split('\n').filter(Boolean).map((line) => line.split('\t')[1].replace('refs/tags/', '')).sort();
}

// `install --release TAG|latest`: fetch that release's distribution (agents/harness/stack only) into
// <root>/release and run its own installer from there, at its pins. The command shim then points into it.
function installRelease() {
  const tag = options.release === 'latest' ? releaseTags().at(-1) : options.release;
  if (!tag) throw new Error(`no stack-* release tag on ${manifest.monorepo.repository}: publish one with siso-stack release`);
  if (!/^stack-[0-9A-Za-z._-]+$/.test(tag)) throw new Error(`not a stack release tag: ${tag}`);
  const root = join(stackRoot, 'release');
  const stackPath = relative(monorepoRoot, distributionRoot) || 'agents/harness/stack';
  const args = process.argv.slice(3);
  args.splice(args.indexOf('--release'), 2);
  if (options.dryRun) process.exit(planRelease(tag, root, stackPath, args).status);
  // The release's own plan, run from a temporary copy, finds every collision before anything is written here, the
  // release copy included. A release older than the plan lists none, and its install stops at the first one it meets.
  const preflight = planRelease(tag, root, stackPath, args, { preflight: true });
  if (preflight.status !== 0) process.exit(preflight.status);
  refuseCollisions(preflight.collisions, 'writing anything');
  console.log(`RELEASE ${tag} ${sparseFetch(root, manifest.monorepo.repository, `refs/tags/${tag}`, [stackPath]).slice(0, 12)} -> ${root}`);
  const cli = join(root, stackPath, 'bin', 'siso-stack.mjs');
  const result = spawnSync(process.execPath, [cli, 'install', '--from-pins', ...args], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

// `install --release TAG --dry-run`: fetch the release into a temporary folder, not the home, and run its own dry
// run from there, told where it will sit once installed. With `preflight` (a real install's first step) that run's
// rows are read instead of printed, and its pinned components are not fetched: no collision depends on them.
// Returns the run's exit status and the rows it refused.
function planRelease(tag, root, stackPath, args, { preflight = false } = {}) {
  const stage = mkdtempSync(join(tmpdir(), 'siso-stack-release-'));
  try {
    const commit = sparseFetch(join(stage, 'release'), manifest.monorepo.repository, `refs/tags/${tag}`, [stackPath]);
    const head = existsSync(join(root, '.git')) ? spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() : null;
    const action = head === commit ? 'SAME' : head ? 'REPLACE' : 'NEW';
    if (!preflight) console.log(`${action.padEnd(7)} ${root}  (release ${tag} at ${commit.slice(0, 12)}, ${stackPath} only; stack-owned)`);
    const env = { ...process.env, SISO_STACK_DISTRIBUTION_AS: join(root, stackPath), ...(preflight ? { SISO_STACK_PLAN_NO_FETCH: '1' } : {}) };
    const result = spawnSync(process.execPath, [join(stage, 'release', stackPath, 'bin', 'siso-stack.mjs'), 'install', '--from-pins', ...args,
      ...(preflight ? ['--dry-run'] : [])], { encoding: 'utf8', env, stdio: ['ignore', preflight ? 'pipe' : 'inherit', 'inherit'] });
    if (preflight && result.status !== 0) process.stdout.write(result.stdout || '');
    const collisions = (preflight ? result.stdout || '' : '').split('\n').filter((line) => line.startsWith('COLLIDE ')).map((line) => {
      const [path, ...detail] = line.slice('COLLIDE '.length).split('  (');
      return { action: 'COLLIDE', path, detail: detail.join('  (').replace(/\)$/, '') };
    });
    return { status: result.status ?? 1, collisions };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// The stack release this distribution is, when it runs from a release checkout (install --release).
function installedRelease() {
  if (options.fromCheckout) return null;
  const tags = spawnSync('git', ['-C', monorepoRoot, 'tag', '--points-at', 'HEAD', '--list', 'stack-*'], { encoding: 'utf8' });
  return tags.status === 0 ? tags.stdout.trim().split('\n').filter(Boolean).at(-1) || null : null;
}

function install() {
  if (options.release) return installRelease();
  const components = includedComponents();
  if (options.dryRun) return dryRun(components);
  // Every collision is known before the first write, so an install never stops part way through the home.
  refuseCollisions(planHomeWrites(components), 'writing anything');
  for (const component of components) materialize(component);
  // With every component fetched, the plan is complete; it also proves each skill source and command is there.
  refuseCollisions(planHomeWrites(components), `writing anything outside ${repositoriesRoot}`);
  const previous = previousState();
  installProfiles();
  const agentNames = installAgents();
  const skillNames = installSkills();
  const commandCount = installCommands(components) + installDistributionCommand();
  const seatHooks = installHooks();
  const installedAt = new Date().toISOString();
  const seats = {};
  for (const seat of writtenSeats) {
    seats[seat] = { hooks: seatHookIds(seat) || options.hooks || null, seat_hooks: seatHookIds(seat),
      skills: skillNames, agents: agentNames, managed_hooks: seatHooks[seat], installed_at: installedAt };
  }
  for (const seat of heldSeats) {
    seats[seat] = savedSeats[seat] || { hooks: savedReceipt.hooks ?? null, skills: previous.skills, agents: previous.agents,
      managed_hooks: previous.managed_hooks, installed_at: savedReceipt.installed_at ?? null };
    console.log(`HOLD  ${seat}: not written on this run; kept as installed ${seats[seat].installed_at || 'before'}`);
  }
  const receipt = {
    schema_version: 1,
    stack_version: manifest.version,
    installed_at: installedAt,
    home: targetHome,
    root: stackRoot,
    from_checkout: options.fromCheckout ? monorepoRoot : null,
    release: installedRelease(),
    claude_dirs: extraClaudeDirs,
    run_seats: writtenSeats,
    seats,
    hooks: options.hooks || null,
    skills: options.skills || null,
    managed_hooks: options.hooks ? {
      claude: managedHooks(readSettings(join(defaultClaudeDir, 'settings.json'))),
      codex: managedHooks(readSettings(join(targetHome, '.codex', 'hooks.json')))
    } : null,
    selection: {
      required_only: Boolean(options.requiredOnly),
      no_external: Boolean(options.noExternal),
      component_ids: components.map((component) => component.id)
    },
    components: components.map(componentRecord),
    skill_count: skillNames.length,
    agent_count: agentNames.length,
    command_count: commandCount
  };
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(`PASS installed SISO Agent Stack ${manifest.version}: ${components.length} components, ${skillNames.length} skills, ${commandCount} commands, ${writeDirs.length} seats written, ${heldSeats.length} held`);
}

function doctor() {
  let receipt = null;
  if (!existsSync(receiptPath)) failures.push(`missing install receipt: ${receiptPath}`);
  else {
    try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); }
    catch { failures.push(`invalid install receipt: ${receiptPath}`); }
  }
  if (receipt) {
    if (receipt.stack_version !== manifest.version) failures.push(`receipt stack version ${receipt.stack_version} does not match ${manifest.version}`);
    if (receipt.home !== targetHome) failures.push(`receipt home ${receipt.home} does not match ${targetHome}`);
    if (receipt.root !== stackRoot) failures.push(`receipt root ${receipt.root} does not match ${stackRoot}`);
    if (receipt.from_checkout && receipt.from_checkout !== monorepoRoot) failures.push(`installed from checkout ${receipt.from_checkout}, but this stack runs from ${monorepoRoot}`);
    if (receipt.release) {
      if (receipt.release !== installedRelease()) failures.push(`receipt records release ${receipt.release}, but this stack runs from ${installedRelease() || 'no release'} (${distributionRoot})`);
      else if (run('git', ['-C', monorepoRoot, 'status', '--porcelain'])) failures.push(`release checkout is dirty: ${monorepoRoot}`);
    }
  }
  const componentById = new Map(manifest.components.map((component) => [component.id, component]));
  let components = includedComponents();
  if (receipt) {
    const selection = receipt.selection;
    if (!selection || typeof selection.required_only !== 'boolean' || typeof selection.no_external !== 'boolean' || !Array.isArray(selection.component_ids)) {
      failures.push('receipt selection is missing or invalid');
    } else {
      components = componentsForSelection({ requiredOnly: selection.required_only, noExternal: selection.no_external });
      const expectedIds = components.map((component) => component.id);
      if (JSON.stringify(selection.component_ids) !== JSON.stringify(expectedIds)) failures.push('receipt selection component_ids differ from manifest selection');
    }
    const records = Array.isArray(receipt.components) ? receipt.components : [];
    if (!Array.isArray(receipt.components)) failures.push('receipt components must be an array');
    const recordIds = records.map((record) => record.id);
    const expectedIds = components.map((component) => component.id);
    if (new Set(recordIds).size !== recordIds.length) failures.push('receipt component IDs are not unique');
    if (JSON.stringify(recordIds) !== JSON.stringify(expectedIds)) failures.push('receipt component set differs from manifest selection');
    for (const record of records) {
      const expected = componentById.get(record.id);
      if (!expected) failures.push(`receipt contains unknown component: ${record.id}`);
      else if (fromCheckout(expected)) {
        const head = monorepoHead();
        if (record.path !== expected.monorepo_path || record.repository !== manifest.monorepo.repository) failures.push(`receipt metadata differs from manifest: ${record.id}`);
        else if (record.revision !== head) failures.push(`${record.id}: installed from checkout ${String(record.revision).slice(0, 12)}, the checkout is now at ${head.slice(0, 12)}: re-run siso-stack install`);
      } else if (record.revision !== expected.revision || record.repository !== expected.repository) {
        failures.push(`receipt metadata differs from manifest: ${record.id}`);
      }
    }
  }
  for (const component of components) {
    const path = repositoryPath(component);
    if (fromCheckout(component)) {
      if (!existsSync(path)) { failures.push(`missing component: ${component.id} (${path})`); continue; }
      if (checkoutDirt(component)) failures.push(`${component.id}: checkout path is dirty: ${path}`);
      for (const relative of Object.values(component.commands || {})) {
        if (!existsSync(join(path, relative))) failures.push(`${component.id}: missing command ${relative}`);
      }
      continue;
    }
    const root = checkoutRoot(component);
    if (!existsSync(join(root, '.git')) || !existsSync(path)) {
      failures.push(`missing component: ${component.id}`);
      continue;
    }
    const actual = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    if (actual !== component.revision) failures.push(`${component.id}: expected ${component.revision}, got ${actual || 'missing'}`);
    const dirty = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim();
    if (dirty) failures.push(`${component.id}: managed checkout is dirty`);
    for (const relative of Object.values(component.commands || {})) {
      if (!existsSync(join(path, relative))) failures.push(`${component.id}: missing command ${relative}`);
    }
  }
  for (const profile of [...claudeDirs.map((dir) => join(dir, 'CLAUDE.md')), join(targetHome, '.codex', 'AGENTS.md')]) {
    if (!existsSync(profile) || !readFileSync(profile, 'utf8').includes('BEGIN SISO AGENT STACK')) failures.push(`missing managed profile block: ${profile}`);
  }
  for (const [host, name] of [['claude', 'claude.md'], ['codex', 'codex.md']]) {
    const installed = join(profileRoot, name);
    const source = join(distributionRoot, 'profiles', name);
    if (!existsSync(installed) || !readFileSync(installed).equals(readFileSync(source))) {
      failures.push(`${host} portable profile differs from release source: ${installed}`);
    }
  }
  // A seat with a record (written by a per-seat install) is held to that record; without one (an older
  // receipt) it is held to everything ~/.claude carries, as before.
  const seatRecord = (dir) => (dir !== defaultClaudeDir && receipt?.seats && typeof receipt.seats[dir] === 'object') ? receipt.seats[dir] : null;
  const agentNames = readdirSync(join(distributionRoot, 'profiles', 'agents')).filter((name) => name.endsWith('.md'));
  for (const [host, sourceDirectory, installedDirectory, extension] of [
    ['.claude', join(distributionRoot, 'profiles', 'agents'), join(profileRoot, 'agents', 'claude'), '.md'],
    ['.codex', join(distributionRoot, 'profiles', 'codex-agents'), join(profileRoot, 'agents', 'codex'), '.toml']
  ]) {
    const names = readdirSync(sourceDirectory).filter((entry) => entry.endsWith(extension));
    for (const name of names) {
      const source = join(sourceDirectory, name);
      const installed = join(installedDirectory, name);
      if (!existsSync(installed) || !readFileSync(installed).equals(readFileSync(source))) {
        failures.push(`${host} agent definition differs from release source: ${name}`);
      }
    }
    for (const hostDir of host === '.claude' ? claudeDirs : [join(targetHome, host)]) {
      const wanted = (host === '.claude' && Array.isArray(seatRecord(hostDir)?.agents)) ? seatRecord(hostDir).agents : names;
      for (const name of wanted) {
        const destination = join(hostDir, 'agents', name);
        if (!exactManagedLink(join(installedDirectory, name), destination)) failures.push(`missing exact ${host} agent link: ${destination}`);
      }
    }
  }
  const installedIds = new Set(components.map((component) => component.id));
  if (installedIds.has('skills') && installedIds.has('playbook')) {
    const skillSources = registeredSkills();
    for (const claudeDir of claudeDirs) {
      const record = seatRecord(claudeDir);
      const report = skillDoctor(targetHome, claudeDir, Array.isArray(record?.skills) ? record.skills : null);
      failures.push(...report.issues.map((issue) => claudeDir === defaultClaudeDir ? issue : `${claudeDir}: ${issue}`));
      const held = heldSeats.includes(claudeDir) ? `, held at ${record?.skills?.length ?? 'all'} recorded skills` : '';
      console.log(`SKILLS ${claudeDir}: ${report.skills} canonical, ${report.claude_links} Claude links, ${report.codex_duplicates} Codex duplicates${held}`);
    }
    if (receipt && receipt.skill_count !== skillSources.size) failures.push(`receipt skill count ${receipt.skill_count} does not match ${skillSources.size}`);
  }
  let commandCount = 0;
  for (const component of components) {
    for (const [name, relative] of commandsFor(component)) {
      const executable = join(repositoryPath(component), relative);
      const shim = join(binRoot, name);
      if (!existsSync(shim) || readFileSync(shim, 'utf8') !== shimContent(executable)) failures.push(`missing or altered command shim: ${shim}`);
      commandCount += 1;
    }
  }
  const distributionExecutable = join(distributionRoot, 'bin', 'siso-stack.mjs');
  const distributionShim = join(binRoot, 'siso-stack');
  if (!existsSync(distributionShim) || readFileSync(distributionShim, 'utf8') !== shimContent(distributionExecutable)) {
    failures.push(`missing or altered distribution command shim: ${distributionShim}`);
  }
  commandCount += 1;
  if (receipt && receipt.command_count !== commandCount) failures.push(`receipt command count ${receipt.command_count} does not match ${commandCount}`);
  if (receipt && receipt.agent_count !== agentNames.length) failures.push(`receipt agent count ${receipt.agent_count} does not match ${agentNames.length}`);
  const hooks = manifest.components.find((component) => component.id === 'hooks');
  if (existsSync(repositoryPath(hooks))) {
    // With a hook selection, siso-hooks checks the payload only; the selected groups are checked against the receipt.
    const selected = receipt && receipt.hooks ? ['--no-claude', '--no-codex'] : [];
    const result = spawnSync(process.execPath, [join(repositoryPath(hooks), 'bin', 'siso-hooks.mjs'), 'doctor', '--home', targetHome, ...selected], { encoding: 'utf8' });
    if (result.status !== 0) failures.push(`hooks doctor failed: ${(result.stderr || result.stdout).trim()}`);
  }
  if (receipt && receipt.hooks) {
    for (const [host, path] of [['claude', join(defaultClaudeDir, 'settings.json')], ['codex', join(targetHome, '.codex', 'hooks.json')]]) {
      if (hooksKey(managedHooks(readSettings(path))) !== hooksKey(receipt.managed_hooks?.[host])) {
        failures.push(`managed ${host} hooks in ${path} differ from the receipt's selection (${receipt.hooks.join(',')})`);
      }
    }
  }
  const expectedHooks = hooksKey(managedHooks(readSettings(join(defaultClaudeDir, 'settings.json'))));
  for (const claudeDir of extraClaudeDirs) {
    const record = seatRecord(claudeDir);
    const actual = hooksKey(managedHooks(readSettings(join(claudeDir, 'settings.json'))));
    if (record && record.managed_hooks) {
      if (actual !== hooksKey(record.managed_hooks)) failures.push(`managed hooks in ${join(claudeDir, 'settings.json')} differ from the receipt's record for that seat (${(record.hooks || ['all']).join(',')})`);
    } else if (actual !== expectedHooks) {
      failures.push(`managed hooks in ${join(claudeDir, 'settings.json')} differ from ${join(defaultClaudeDir, 'settings.json')}`);
    }
  }
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`PASS SISO Agent Stack ${manifest.version}${receipt?.release ? ` (release ${receipt.release})` : ''}: pins, profiles, hooks, and receipt verified`);
}

function plan() {
  console.log(`SISO Agent Stack ${manifest.version}`);
  for (const component of includedComponents()) {
    console.log(`${component.required ? 'required' : 'optional'}\t${component.id}\t${component.revision}\t${component.repository}`);
  }
  console.log(`Portable surfaces: ${manifest.portable_surfaces.length}; explicit excluded-state classes: ${manifest.excluded_state.length}`);
}

if (operation === 'install') install();
else if (operation === 'doctor') doctor();
else if (operation === 'plan') plan();
else if (operation === 'help' || operation === '--help' || operation === '-h') printUsage();
else {
  console.error(operation ? `ERROR unknown operation: ${operation}` : 'ERROR missing operation');
  printUsage();
  process.exit(2);
}
