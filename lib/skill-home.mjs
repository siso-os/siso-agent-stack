// Canonical skill storage. Tool configuration and runtime state never enter this module.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const root = join(home, 'SISO_Workspace', '_archive', '2026-10-21-dot-agents', hostname(), randomUUID());
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  const before = digest(p);
  // Save a link's payload too: a relative link moved to the archive may no longer resolve.
  if (lstatSync(p).isSymbolicLink() && existsSync(p)) cpSync(realpathSync(p), target + '.payload', { recursive: true, dereference: true });
  renameSync(p, target);
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
export function installSkill(source, name, home, files = null) {
  home = realpathSync(home); // macOS exposes the system temporary directory through /var.
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
    const projectionDigest = () => {
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
    };
    const expected = projectionDigest();
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
    if (!present(claude) || !lstatSync(claude).isSymbolicLink() || readlinkSync(claude) !== link) {
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
export function skillDoctor(home) {
  const roots = ['.agents', '.claude', '.codex'].map(n => join(home, n, 'skills'));
  const names = p => new Set(existsSync(p) ? readdirSync(p).filter(n => !n.startsWith('.') && !n.endsWith('.install-lock') && !(p === roots[1] && n === 'synced') && (p === roots[0] || lstatSync(join(p, n)).isSymbolicLink() || existsSync(join(p, n, 'SKILL.md')))) : []);
  const [a, c, x] = roots.map(names);
  const issues = [];
  for (let i = 0; i < roots.length; i++) for (const n of names(roots[i])) {
    const p = join(roots[i], n);
    if (lstatSync(p).isSymbolicLink() && !existsSync(p)) issues.push(`broken link: ${p}`);
    if (i === 0 && lstatSync(p).isSymbolicLink()) issues.push(`canonical skill is a link: ${n}`);
    if (!existsSync(join(p, 'SKILL.md'))) issues.push(`missing SKILL.md: ${p}`);
  }
  for (const n of a) {
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
