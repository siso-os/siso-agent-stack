// Canonical skill storage. Tool configuration and runtime state never enter this module.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const present = p => { try { lstatSync(p); return true; } catch { return false; } };
function assertRealParents(p) {
  for (let q = resolve(p); dirname(q) !== q; q = dirname(q)) {
    if (present(q) && lstatSync(q).isSymbolicLink()) throw new Error(`symlinked parent refused: ${q}`);
  }
}
function digest(p) {
  const s = lstatSync(p);
  if (s.isSymbolicLink()) return `link:${readlinkSync(p)}`;
  if (s.isFile()) return createHash('sha256').update(readFileSync(p)).digest('hex') + ':' + (s.mode & 0o111);
  if (!s.isDirectory()) throw new Error(`unsupported skill entry: ${p}`);
  return createHash('sha256').update(JSON.stringify(readdirSync(p).sort().map(n => [n, digest(join(p, n))]))).digest('hex');
}
export function archive(p, home) {
  if (!present(p)) return null;
  const rel = relative(home, p);
  if (rel.startsWith('..')) throw new Error('archive path escapes home');
  const root = join(archiveRoot(home), randomUUID());
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  const before = digest(p);
  // Save a link's payload too: a relative link moved to the archive may no longer resolve.
  if (lstatSync(p).isSymbolicLink() && existsSync(p)) cpSync(realpathSync(p), target + '.payload', { recursive: true, dereference: true });
  try { renameSync(p, target); } catch (error) {
    // The archive can sit on another filesystem or btrfs subvolume (Omarchy: ~/SISO_Workspace). Copy, verify, then remove.
    if (error.code !== 'EXDEV') throw error;
    cpSync(p, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    if (digest(target) !== before) throw new Error(`archive verification failed: ${p}`);
    rmSync(p, { recursive: true });
  }
  if (digest(target) !== before) throw new Error(`archive verification failed: ${p}`);
  const receipt = JSON.stringify({ original: p, archived: target, fingerprint: before,
    restore: 'archive the replacement, then rename archived to original; link payload is beside archived' }) + '\n';
  writeFileSync(join(root, 'MANIFEST.txt'), receipt);
  const backups = join(home, '.claude', 'backups', 'dot-agents-20261021');
  mkdirSync(backups, { recursive: true });
  // The exact archived original is the backup, with a second manifest in the harness backup namespace.
  writeFileSync(join(backups, 'MANIFEST.txt'), receipt, { flag: 'a' });
  return target;
}
// The digest a skill's canonical copy must have: its whole source folder, or only the registered `files` in it.
function projectionDigest(source, files) {
  if (!files) return digest(source);
  const tree = {};
  for (const file of files) {
    if (file.split('/').some(p => p === '..' || p === '.') || file.startsWith('/')) throw new Error('invalid registered support path');
    const from = join(source, file);
    if (lstatSync(from).isSymbolicLink() || !realpathSync(from).startsWith(realpathSync(source) + '/')) throw new Error('unsafe registered support file');
    const parts = file.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) node = node[part] ||= {};
    node[parts.at(-1)] = digest(from);
  }
  const hashTree = node => createHash('sha256').update(JSON.stringify(Object.keys(node).sort().map(n => [n, typeof node[n] === 'string' ? node[n] : hashTree(node[n])]))).digest('hex');
  return hashTree(tree);
}
const realHome = home => existsSync(home) ? realpathSync(home) : resolve(home); // macOS exposes the system temporary directory through /var.
const isLinkTo = (p, target) => present(p) && lstatSync(p).isSymbolicLink() && readlinkSync(p) === target;
export function installSkill(source, name, home, files = null) {
  home = realHome(home);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error('invalid skill name');
  if (!existsSync(join(source, 'SKILL.md'))) throw new Error(`missing skill source: ${name}`);
  const canonical = join(home, '.agents', 'skills', name);
  const claude = join(home, '.claude', 'skills', name);
  const codex = join(home, '.codex', 'skills', name);
  for (const p of [canonical, claude, codex]) assertRealParents(dirname(p));
  mkdirSync(dirname(canonical), { recursive: true });
  const lock = canonical + '.install-lock';
  mkdirSync(lock); // Exclusive; never replace another writer's projection.
  let changed = 0, archived = 0;
  try {
    const expected = projectionDigest(source, files);
    if (!present(canonical) || lstatSync(canonical).isSymbolicLink() || digest(canonical) !== expected) {
      // Stage before archiving: source may itself point into the old canonical tree.
      const staged = join(lock, name);
      if (files) {
        mkdirSync(staged);
        for (const file of files) {
          mkdirSync(dirname(join(staged, file)), { recursive: true });
          cpSync(join(source, file), join(staged, file));
        }
      } else cpSync(source, staged, { recursive: true, dereference: true });
      if (digest(staged) !== expected) throw new Error(`staging verification failed: ${name}`);
      archive(canonical, home);
      renameSync(staged, canonical);
      changed++;
    }
    const link = relative(dirname(claude), canonical);
    if (!isLinkTo(claude, link)) {
      archive(claude, home);
      mkdirSync(dirname(claude), { recursive: true });
      symlinkSync(link, claude);
      changed++;
    }
    if (present(codex)) { archive(codex, home); archived++; }
    if (digest(canonical) !== expected || realpathSync(claude) !== realpathSync(canonical)) throw new Error(`readback failed: ${name}`);
  } finally {
    // Empty lock only. An incomplete stage is deliberately retained after failure.
    if (readdirSync(lock).length === 0) rmdirSync(lock);
  }
  return { name, changed, codex_archived: archived };
}
// Where archive() moves things, for a plan to name.
export const archiveRoot = home => join(realHome(home), 'SISO_Workspace', '_archive', '2026-10-21-dot-agents', hostname());
// What installSkill, then linkSkill for each seat, would write for one skill, without writing: rows of
// { action, path, detail } (the actions are siso-stack's: NEW, SAME, REPLACE, ARCHIVE).
export function planSkill(source, name, home, files = null, seats = []) {
  home = realHome(home);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error('invalid skill name');
  if (!existsSync(join(source, 'SKILL.md'))) throw new Error(`missing skill source: ${name}`);
  const canonical = join(home, '.agents', 'skills', name);
  const archived = `the old one is archived under ${archiveRoot(home)}/<id>/`;
  const kind = p => lstatSync(p).isSymbolicLink() ? `a link to ${readlinkSync(p)}` : lstatSync(p).isDirectory() ? 'a folder' : 'a file';
  const rows = [];
  if (!present(canonical)) rows.push({ action: 'NEW', path: canonical, detail: `skill copy from ${source}` });
  else if (lstatSync(canonical).isSymbolicLink() || digest(canonical) !== projectionDigest(source, files)) {
    rows.push({ action: 'REPLACE', path: canonical, detail: `${kind(canonical)} that differs; ${archived}` });
  } else rows.push({ action: 'SAME', path: canonical, detail: 'skill copy' });
  for (const p of [join(home, '.claude', 'skills', name), ...seats.map(seat => join(resolve(seat), 'skills', name))]) {
    const link = relative(dirname(p), canonical);
    if (!present(p)) rows.push({ action: 'NEW', path: p, detail: `link to ${link}` });
    else if (isLinkTo(p, link)) rows.push({ action: 'SAME', path: p, detail: `link to ${link}` });
    else rows.push({ action: 'REPLACE', path: p, detail: `${kind(p)}, made a link to ${link}; ${archived}` });
  }
  const codex = join(home, '.codex', 'skills', name);
  if (present(codex)) rows.push({ action: 'ARCHIVE', path: codex, detail: `Codex duplicate (Codex reads ~/.agents/skills); moved under ${archiveRoot(home)}/<id>/` });
  return rows;
}
// What would stop installSkill or linkSkill for any skill name: a skill folder that is a link or sits under one, or
// another install's lock. Known before the Skills Hub is fetched, so the install can refuse before its first write.
export function skillStoreCollisions(home, seats = []) {
  home = realHome(home);
  const rows = [];
  const folders = [join(home, '.agents', 'skills'), join(home, '.claude', 'skills'), join(home, '.codex', 'skills'),
    ...seats.map(seat => join(resolve(seat), 'skills'))];
  for (const folder of folders) {
    try { assertRealParents(folder); } catch (error) { rows.push({ action: 'COLLIDE', path: folder, detail: `${error.message}: the stack writes skills only into real folders` }); }
  }
  const canonical = folders[0];
  if (present(canonical) && lstatSync(canonical).isDirectory()) {
    for (const entry of readdirSync(canonical).filter(n => n.endsWith('.install-lock'))) {
      rows.push({ action: 'COLLIDE', path: join(canonical, entry), detail: 'another install holds this lock, or one stopped part way: check no install is running, then move it aside' });
    }
  }
  return rows;
}
// Project one canonical skill into an extra Claude config dir (CLAUDE_CONFIG_DIR seat) as a relative link.
export function linkSkill(name, home, claudeDir) {
  home = realHome(home);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error('invalid skill name');
  const canonical = join(home, '.agents', 'skills', name);
  if (!existsSync(join(canonical, 'SKILL.md'))) throw new Error(`missing canonical skill: ${name}`);
  const claude = join(resolve(claudeDir), 'skills', name);
  assertRealParents(dirname(claude));
  const link = relative(dirname(claude), canonical);
  if (isLinkTo(claude, link)) return 0;
  archive(claude, home);
  mkdirSync(dirname(claude), { recursive: true });
  symlinkSync(link, claude);
  if (realpathSync(claude) !== realpathSync(canonical)) throw new Error(`readback failed: ${claude}`);
  return 1;
}
// The stack only ever writes relative links. An absolute link belongs to someone else: the OS
// (Omarchy's /usr/share/omarchy/default/agents/skills), a package (/opt/<app>/agent-skill) or a
// project that ships its own skill (~/Projects/<repo>/skills/<name>). Doctor neither requires nor
// rejects it, unless it points back into the canonical store, which would be a stack link gone wrong.
function externallyManaged(p, home) {
  if (!present(p) || !lstatSync(p).isSymbolicLink()) return false;
  const target = readlinkSync(p);
  return target.startsWith('/') && !resolve(target).startsWith(join(resolve(home), '.agents', 'skills') + '/');
}
// `expected`: the skill names this seat must carry (a held seat's record); default every canonical skill.
export function skillDoctor(home, claudeDir = join(home, '.claude'), expected = null) {
  const roots = [join(home, '.agents', 'skills'), join(claudeDir, 'skills'), join(home, '.codex', 'skills')];
  const names = p => new Set(existsSync(p) ? readdirSync(p).filter(n => !n.startsWith('.') && !n.endsWith('.install-lock') && !(p === roots[1] && n === 'synced') && !externallyManaged(join(p, n), home) && (p === roots[0] || lstatSync(join(p, n)).isSymbolicLink() || existsSync(join(p, n, 'SKILL.md')))) : []);
  const [a, c, x] = roots.map(names);
  const issues = [];
  for (let i = 0; i < roots.length; i++) for (const n of names(roots[i])) {
    const p = join(roots[i], n);
    if (lstatSync(p).isSymbolicLink() && !existsSync(p)) issues.push(`broken link: ${p}`);
    if (i === 0 && lstatSync(p).isSymbolicLink()) issues.push(`canonical skill is a link: ${n}`);
    if (!existsSync(join(p, 'SKILL.md'))) issues.push(`missing SKILL.md: ${p}`);
  }
  for (const n of expected || a) {
    if (!a.has(n)) { if (!externallyManaged(join(roots[0], n), home)) issues.push(`missing canonical skill: ${n}`); continue; }
    if (!c.has(n)) issues.push(`missing Claude skill: ${n}`);
    else if (!lstatSync(join(roots[1], n)).isSymbolicLink() || !existsSync(join(roots[1], n)) || !existsSync(join(roots[0], n)) || realpathSync(join(roots[1], n)) !== realpathSync(join(roots[0], n))) issues.push(`wrong Claude link: ${n}`);
    if (x.has(n)) issues.push(`Codex duplicate: ${n}`);
  }
  for (const n of c) if (!a.has(n)) issues.push(`Claude-only skill: ${n}`);
  for (const n of x) if (!a.has(n)) issues.push(`Codex-only skill: ${n}`);
  return { skills: a.size, claude_links: [...c].filter(n => lstatSync(join(roots[1], n)).isSymbolicLink()).length, codex_duplicates: [...x].filter(n => a.has(n)).length, issues };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [op, ...args] = process.argv.slice(2);
    const result = op === 'install' ? installSkill(...args) : op === 'doctor' ? skillDoctor(args[0]) : op === 'archive' ? { archived: archive(...args) } : null;
    if (!result) throw new Error('expected install SOURCE NAME HOME or doctor HOME');
    console.log(JSON.stringify(result));
    if (result.issues?.length) process.exitCode = 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
