#!/usr/bin/env node
// seat-limits: a SISO seat's own plan limits (the 5-hour window, the weekly limit and the weekly Fable limit, each as
// % used with its reset), so no seat dies mid-work at its cap again (Shaan, 16 Nov: "this is like the third time").
//
// Source: the endpoint Claude Code's own /usage dialog reads, GET https://api.anthropic.com/api/oauth/usage, with the
// seat's own OAuth login (claude 2.1.325: `fetchUtilization` → "/api/oauth/usage"; the answer's `five_hour` and
// `seven_day` are {utilization, resets_at}, and Fable is the `limits[]` row whose kind is "weekly_scoped" and whose
// scope.model.display_name is "Fable"). The statusline's own JSON carries only rate_limits.five_hour and .seven_day
// (used_percentage, resets_at in epoch seconds), never Fable, and it renders only in the terminal UI: a T3 (Agent SDK)
// session never runs it. So the hooks below are the events there: a turn starts (UserPromptSubmit) or a tool call ends
// (PostToolUse).
//
// No timer: a read happens only on one of those events, and only when the seat's last read is older than REFRESH_MS.
// Never prints, sends elsewhere or refreshes a token: an expired one is left for Claude Code to refresh itself.
//
//   seat-limits.mjs statusline --seat <name> [--claude-dir <dir>] [--dir <limits dir>]   stdin: the statusline JSON
//   seat-limits.mjs hook --seat <name> [--claude-dir <dir>] [--dir <limits dir>]         stdin: the hook's JSON
//   seat-limits.mjs refresh --seat <name> [--claude-dir <dir>] [--dir <limits dir>]      read now, print the record
//   seat-limits.mjs show [--dir <limits dir>]                                            print limits.json
//   seat-limits.mjs install --seat <name> --claude-dir <dir> [--home <dir>] [--dir <limits dir>] [--force]
//
// Files (the limits dir, default ~/SISO_Workspace/_data/seat-limits): <seat>.json is one seat's record, written by
// that seat only; limits.json is every seat's record merged, rewritten after each read (the spend feed sends it on).
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCHEMA = 1;
export const API = 'https://api.anthropic.com/api/oauth/usage';
const API_SOURCE = 'api/oauth/usage';
/** A seat's record older than this is read again on the next event. */
export const REFRESH_MS = 5 * 60_000;
/** After a failed read, wait this long (a 429's retry-after when longer). */
export const RETRY_MS = 5 * 60_000;
export const RATE_LIMITED_MS = 10 * 60_000;
/** A lock older than this belongs to a reader that died. */
export const LOCK_MS = 30_000;
/** The warning bands: an agent is told once per band it crosses, and at every turn start while one is held. */
export const BANDS = [80, 90, 95, 100];
export const WINDOWS = ['five_hour', 'seven_day', 'fable'];
export const WINDOW_LABEL = { five_hour: '5-hour', seven_day: 'weekly', fable: 'weekly Fable' };
const SHORT = { five_hour: '5h', seven_day: 'week', fable: 'Fable' };

export const defaultDir = (home = homedir()) => join(home, 'SISO_Workspace', '_data', 'seat-limits');

// ---------- parsing ----------

const iso = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const pctOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.max(0, v) * 10) / 10 : null);

/**
 * The endpoint's answer as three windows, each {pct, resets_at, read_at}. A window the plan does not report (the API
 * answers null, or no Fable row) is {pct: null, resets_at: null, read_at}: read, and none there.
 */
export function parseUsage(body, readAt) {
  const b = body && typeof body === 'object' ? body : {};
  const win = (w) => (w && typeof w === 'object' && pctOf(w.utilization) !== null
    ? { pct: pctOf(w.utilization), resets_at: iso(w.resets_at), read_at: readAt }
    : { pct: null, resets_at: null, read_at: readAt });
  const limits = Array.isArray(b.limits) ? b.limits.filter((l) => l && typeof l === 'object') : [];
  const fableRow = limits.find((l) => l.kind === 'weekly_scoped'
    && typeof l.scope?.model?.display_name === 'string' && /^fable\b/i.test(l.scope.model.display_name));
  const weeklyRow = limits.find((l) => l.kind === 'weekly_all');
  const seven = win(b.seven_day);
  if (seven.pct === null && weeklyRow && pctOf(weeklyRow.percent) !== null) {
    seven.pct = pctOf(weeklyRow.percent);
    seven.resets_at = iso(weeklyRow.resets_at);
  }
  return {
    five_hour: win(b.five_hour),
    seven_day: seven,
    fable: fableRow && pctOf(fableRow.percent) !== null
      ? { pct: pctOf(fableRow.percent), resets_at: iso(fableRow.resets_at), read_at: readAt }
      : { pct: null, resets_at: null, read_at: readAt },
  };
}

/** The statusline's own rate_limits (live in that terminal session): five_hour and seven_day only. */
export function parseStatusline(input, readAt) {
  const r = input && typeof input === 'object' ? input.rate_limits : null;
  const out = {};
  for (const k of ['five_hour', 'seven_day']) {
    const w = r && typeof r === 'object' ? r[k] : null;
    if (w && pctOf(w.used_percentage) !== null) out[k] = { pct: pctOf(w.used_percentage), resets_at: iso(w.resets_at), read_at: readAt };
  }
  return out;
}

/** "Max 20x" from the credentials' rateLimitTier ("default_claude_max_20x"); null when it says nothing usable. */
export function planOf(oauth) {
  const tier = typeof oauth?.rateLimitTier === 'string' ? oauth.rateLimitTier : '';
  const m = /max_(\d+x)/i.exec(tier);
  if (m) return `Max ${m[1].toLowerCase()}`;
  const sub = typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType : '';
  return sub ? sub[0].toUpperCase() + sub.slice(1) : null;
}

// ---------- words ----------

export const bandOf = (pct) => (pct === null || pct === undefined ? 0 : BANDS.filter((b) => pct >= b).pop() ?? 0);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Tue 13:00Z" (UTC), with the date when the reset is more than six days off. */
export function resetLabel(at, now = new Date()) {
  if (!at) return 'reset unknown';
  const d = new Date(Math.round(Date.parse(at) / 60_000) * 60_000); // the API answers 12:59:59.7 for 13:00
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
  const days = (d.getTime() - now.getTime()) / 86_400_000;
  if (days < 0.5 && d.getUTCDate() === now.getUTCDate()) return `today ${hm}`;
  return days > 6 ? `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${hm}` : `${DAYS[d.getUTCDay()]} ${hm}`;
}
const pctText = (pct) => `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
const fresh = (w, now, maxMs) => !!w?.read_at && now.getTime() - Date.parse(w.read_at) <= maxMs;

/**
 * One line per window at 80% or more, worded as what to do: "seat-a weekly Fable 84%, resets Thu 10:00Z:
 * switch Fable work to Opus". `others` are the other seats' records: a weekly or 5-hour line names one with room.
 */
export function warnings(record, others = [], now = new Date()) {
  const out = [];
  const roomOn = (k) => others
    .filter((o) => o.seat !== record.seat && fresh(o[k], now, 2 * 3_600_000) && o[k].pct !== null && o[k].pct < 80)
    .sort((a, b) => a[k].pct - b[k].pct)[0];
  for (const k of WINDOWS) {
    const w = record[k];
    if (!w || w.pct === null || w.pct < BANDS[0]) continue;
    const head = `${record.seat} ${WINDOW_LABEL[k]} ${pctText(w.pct)}, resets ${resetLabel(w.resets_at, now)}`;
    let act;
    if (k === 'fable') act = w.pct >= 100 ? 'Fable is used up on this seat, so run Fable work on Opus until then' : 'switch Fable work to Opus';
    else {
      const other = roomOn(k);
      const move = other ? `start new long work on ${other.seat} (${WINDOW_LABEL[k]} ${pctText(other[k].pct)})` : 'land what is open and start nothing long';
      act = w.pct >= 100 ? `this seat is stopped until then: ${move}` : `${move} before it runs out`;
    }
    out.push(`${head}: ${act}`);
  }
  return out;
}

/** The terminal statusline: "seat-b · 5h – · week 73% · Fable 100% Tue 13:00Z", then any warning. */
export function statusText(record, now = new Date(), { color = true } = {}) {
  const paint = (pct, s) => {
    if (!color || pct === null || pct < 80) return s;
    return `${pct >= 95 ? '\x1b[31m' : '\x1b[33m'}${s}\x1b[0m`;
  };
  const parts = [record.seat];
  for (const k of WINDOWS) {
    const w = record[k];
    if (!w) { parts.push(`${SHORT[k]} ?`); continue; }
    if (w.pct === null) { parts.push(`${SHORT[k]} –`); continue; }
    const reset = w.pct >= 80 ? ` ${resetLabel(w.resets_at, now)}` : '';
    parts.push(paint(w.pct, `${SHORT[k]} ${pctText(w.pct)}${reset}`));
  }
  const read = record.read_at ? Math.round((now.getTime() - Date.parse(record.read_at)) / 60_000) : null;
  if (read !== null && read > 120) parts.push(`read ${Math.round(read / 60)}h ago`);
  if (record.error && (!record.read_at || Date.parse(record.error.at) > Date.parse(record.read_at))) parts.push(`(${record.error.reason})`);
  return parts.join(' · ');
}

// ---------- files ----------

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};
function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
}
const seatName = (s) => (typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(s) ? s : null);
export const recordPath = (dir, seat) => join(dir, `${seat}.json`);
export const loadRecord = (dir, seat) => readJson(recordPath(dir, seat));

/** Every seat's record in the dir, merged into limits.json (rewritten whole; a reader never sees half a file). */
export function mergeAll(dir, now = new Date()) {
  let names = [];
  try { names = readdirSync(dir); } catch { return null; }
  const seats = names
    .filter((n) => n.endsWith('.json') && n !== 'limits.json' && seatName(n.slice(0, -5)))
    .map((n) => readJson(join(dir, n)))
    .filter((r) => r && r.schema === SCHEMA && seatName(r.seat))
    .sort((a, b) => a.seat.localeCompare(b.seat));
  const merged = { schema: SCHEMA, machine: hostname(), written_at: now.toISOString(), seats };
  writeAtomic(join(dir, 'limits.json'), JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

/** The soonest reset among windows at 80% or more, else the soonest of all. */
export function soonestReset(record) {
  const ws = WINDOWS.map((k) => record[k]).filter((w) => w?.resets_at);
  const hot = ws.filter((w) => w.pct !== null && w.pct >= 80);
  const pick = (hot.length ? hot : ws).map((w) => w.resets_at).sort()[0];
  return pick ?? null;
}

// ---------- reading the endpoint ----------

function takeLock(path, now) {
  try {
    closeSync(openSync(path, 'wx'));
    return true;
  } catch {
    try {
      if (now.getTime() - statSync(path).mtimeMs > LOCK_MS) {
        unlinkSync(path);
        closeSync(openSync(path, 'wx'));
        return true;
      }
    } catch { /* another reader took it */ }
    return false;
  }
}

/** Is it time to read this seat again? (Stale, and not waiting out a failure.) */
export function due(record, now = new Date()) {
  if (!record) return true;
  if (record.next_try_at && Date.parse(record.next_try_at) > now.getTime()) return false;
  return !record.read_at || now.getTime() - Date.parse(record.read_at) >= REFRESH_MS;
}

/**
 * Read the endpoint with the seat's own login and write its record. Returns the record (the old one, with an error
 * noted, when the read fails). `fetchImpl` and `api` are for tests.
 */
export async function refresh({ seat, claudeDir, dir, now = new Date(), fetchImpl = globalThis.fetch, api = process.env.SISO_SEAT_LIMITS_API || API, force = false }) {
  const old = loadRecord(dir, seat);
  if (!force && !due(old, now)) return old;
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, `.${seat}.lock`);
  if (!takeLock(lock, now)) return old;
  const base = old && old.schema === SCHEMA ? old : { schema: SCHEMA, seat, plan: null, five_hour: null, seven_day: null, fable: null, resets_at: null, read_at: null };
  const fail = (reason, waitMs) => {
    const rec = { ...base, source: API_SOURCE, error: { at: now.toISOString(), reason }, next_try_at: new Date(now.getTime() + waitMs).toISOString() };
    writeAtomic(recordPath(dir, seat), JSON.stringify(rec, null, 2) + '\n');
    mergeAll(dir, now);
    return rec;
  };
  try {
    const creds = readJson(join(claudeDir, '.credentials.json'));
    const oauth = creds?.claudeAiOauth;
    const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken : '';
    if (!token) return fail('no login on this seat', RETRY_MS);
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < now.getTime() + 60_000) return fail('login expired; Claude Code renews it on its next call', RETRY_MS);
    let res;
    try {
      res = await fetchImpl(api, {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json', 'User-Agent': 'siso-seat-limits/1' },
        signal: AbortSignal.timeout(4000),
      });
    } catch (error) {
      return fail(`usage endpoint unreachable (${error?.name === 'TimeoutError' ? 'timeout' : 'network'})`, RETRY_MS);
    }
    if (res.status === 429) {
      const after = Number(res.headers?.get?.('retry-after')) * 1000;
      return fail('usage endpoint said 429', Math.max(RATE_LIMITED_MS, Number.isFinite(after) ? after : 0));
    }
    if (!res.ok) return fail(`usage endpoint said ${res.status}`, RETRY_MS);
    let body;
    try { body = await res.json(); } catch { return fail('usage endpoint sent no JSON', RETRY_MS); }
    const readAt = now.toISOString();
    const rec = { schema: SCHEMA, seat, plan: planOf(oauth), ...parseUsage(body, readAt), resets_at: null, read_at: readAt, source: API_SOURCE, error: null, next_try_at: null };
    rec.resets_at = soonestReset(rec);
    writeAtomic(recordPath(dir, seat), JSON.stringify(rec, null, 2) + '\n');
    mergeAll(dir, now);
    return rec;
  } finally {
    try { unlinkSync(lock); } catch { /* gone */ }
  }
}
/** The other seats' records, for "start new work on <seat>". */
const othersIn = (dir, seat) => {
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'limits.json' && n !== `${seat}.json`)
      .map((n) => readJson(join(dir, n))).filter((r) => r && r.schema === SCHEMA);
  } catch { return []; }
};

// ---------- hooks ----------

const toldDir = () => join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'siso-seat-limits');
/** The bands this session was last told, per window. */
export function toldBands(session) {
  const r = session ? readJson(join(toldDir(), `${String(session).replace(/[^A-Za-z0-9_-]/g, '')}.json`)) : null;
  return r && typeof r === 'object' ? r : {};
}
function saveTold(session, bands) {
  if (!session) return;
  try { writeAtomic(join(toldDir(), `${String(session).replace(/[^A-Za-z0-9_-]/g, '')}.json`), JSON.stringify(bands)); } catch { /* best effort */ }
}

/**
 * What the hook prints: on a turn start, every window at 80% or more; after a tool call, only when a window has
 * crossed into a band this session was not told yet (once per band, so a run of tool calls is not flooded).
 */
export function hookReply(event, record, others, told, now = new Date()) {
  const bands = Object.fromEntries(WINDOWS.map((k) => [k, bandOf(record?.[k]?.pct ?? null)]));
  const lines = record ? warnings(record, others, now) : [];
  const rose = WINDOWS.some((k) => bands[k] > (told[k] ?? 0));
  const say = lines.length > 0 && (event === 'UserPromptSubmit' || event === 'SessionStart' || rose);
  const text = say ? `Seat limits (${record.seat}'s own plan, read ${resetAgo(record.read_at, now)} from Claude's usage endpoint): ${lines.join('; ')}.` : null;
  return { text, bands };
}
const resetAgo = (at, now) => {
  if (!at) return 'never';
  const m = Math.round((now.getTime() - Date.parse(at)) / 60_000);
  return m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

// ---------- install ----------

/** The command a seat runs; quoted for the shell the harness uses. */
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export function commandFor(mode, { script, seat, claudeDir, dir }) {
  return `node ${quote(script)} ${mode} --seat ${quote(seat)} --claude-dir ${quote(claudeDir)} --dir ${quote(dir)}`;
}
const ours = (cmd) => typeof cmd === 'string' && cmd.includes('/seat-limits/seat-limits.mjs');

/**
 * Copy this script to <home>/.siso/agent-stack/seat-limits/ and point one seat's settings.json at it: the statusLine
 * (unless the seat has its own, which needs --force) and one UserPromptSubmit and one PostToolUse hook group. Groups
 * whose command is this script are replaced; nothing else in the file changes. A backup is kept beside it.
 */
export function install({ seat, claudeDir, home = homedir(), dir = defaultDir(home), force = false, source = fileURLToPath(import.meta.url) }) {
  if (!seatName(seat)) throw new Error('--seat must be a seat name (letters, digits, . _ -)');
  if (!claudeDir) throw new Error('--claude-dir is required');
  const script = join(home, '.siso', 'agent-stack', 'seat-limits', 'seat-limits.mjs');
  mkdirSync(dirname(script), { recursive: true });
  if (resolve(source) !== resolve(script)) copyFileSync(source, script);
  const settingsPath = join(claudeDir, 'settings.json');
  const before = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '{}\n';
  const settings = JSON.parse(before);
  const notes = [];
  const args = { script, seat, claudeDir: resolve(claudeDir), dir };
  if (settings.statusLine && !ours(settings.statusLine.command) && !force) notes.push(`kept the seat's own statusLine (${String(settings.statusLine.command).slice(0, 60)}); --force replaces it`);
  else settings.statusLine = { type: 'command', command: commandFor('statusline', args), padding: 0 };
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const [event, timeout] of [['UserPromptSubmit', 10], ['PostToolUse', 10]]) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const kept = groups.filter((g) => !(Array.isArray(g?.hooks) && g.hooks.some((h) => ours(h?.command))));
    settings.hooks[event] = [...kept, { hooks: [{ type: 'command', command: commandFor('hook', args), timeout }] }];
  }
  const after = JSON.stringify(settings, null, 2) + '\n';
  if (after !== before) {
    if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.siso-backup-${Date.now()}`);
    writeAtomic(settingsPath, after);
  }
  return { script, settings: settingsPath, changed: after !== before, notes };
}

// ---------- main ----------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a.startsWith('--')) out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else out._.push(a);
  }
  return out;
}
const readStdin = async () => {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args._[0];
  const home = args.home ? resolve(args.home) : homedir();
  const dir = resolve(args.dir || defaultDir(home));
  const seat = seatName(args.seat);
  const claudeDir = resolve(args.claudeDir || process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'));
  const now = new Date();

  if (mode === 'install') {
    const r = install({ seat: args.seat, claudeDir: args.claudeDir, home, dir, force: !!args.force });
    console.log(`${r.changed ? 'INSTALLED' : 'UNCHANGED'} ${args.seat}: ${r.settings} → ${r.script}`);
    for (const n of r.notes) console.log(`note: ${n}`);
    return;
  }
  if (mode === 'show') {
    process.stdout.write(readFileSync(join(dir, 'limits.json'), 'utf8'));
    return;
  }
  if (!seat) throw new Error('--seat is required');

  if (mode === 'refresh') {
    const rec = await refresh({ seat, claudeDir, dir, now, force: true });
    console.log(JSON.stringify(rec, null, 2));
    return;
  }
  if (mode === 'statusline') {
    let input = {};
    try { input = JSON.parse((await readStdin()) || '{}'); } catch { /* render from the file */ }
    const rec = (await refresh({ seat, claudeDir, dir, now }).catch(() => null)) || loadRecord(dir, seat) || { seat };
    // The session's own live 5-hour and weekly numbers win for the line; the file keeps the endpoint's read.
    const live = { ...rec, ...parseStatusline(input, now.toISOString()) };
    const line = statusText(live, now);
    const warn = warnings(live, othersIn(dir, seat), now)[0];
    process.stdout.write(warn ? `${line}\n${warn}` : line);
    return;
  }
  if (mode === 'hook') {
    let input = {};
    try { input = JSON.parse((await readStdin()) || '{}'); } catch { /* still answer */ }
    const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : 'UserPromptSubmit';
    const rec = (await refresh({ seat, claudeDir, dir, now }).catch(() => null)) || loadRecord(dir, seat);
    const told = toldBands(input.session_id);
    const { text, bands } = hookReply(event, rec, othersIn(dir, seat), told, now);
    saveTold(input.session_id, bands);
    if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
    return;
  }
  throw new Error(`unknown mode ${mode ?? ''}: statusline, hook, refresh, show or install`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // A hook or statusline never fails the session: say why on stderr and exit 0 (install and refresh exit 1).
    console.error(`seat-limits: ${error?.message ?? error}`);
    const mode = process.argv[2];
    process.exit(mode === 'install' || mode === 'refresh' || mode === 'show' ? 1 : 0);
  });
}
