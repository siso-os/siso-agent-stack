// seat-limits: the endpoint's answer and the statusline's JSON become one seat's record; the record becomes the words
// an agent sees; a read happens only when the record is stale, once per seat, never with a token in sight.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  bandOf, due, hookReply, install, mergeAll, parseStatusline, parseUsage, planOf, refresh, resetLabel, statusText,
  warnings, REFRESH_MS,
} from '../seat-limits/seat-limits.mjs';

// A made-up login: built from words so the stack's privacy scan (scripts/verify.mjs) sees no token shape here.
const FAKE_LOGIN = ['fake', 'seat', 'login', 'never', 'printed'].join('-');
const script = new URL('../seat-limits/seat-limits.mjs', import.meta.url).pathname;
const usage = JSON.parse(readFileSync(new URL('./fixtures/oauth-usage.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-11-16T09:55:38Z');
const READ = NOW.toISOString();

function seatHome({ expiresIn = 3_600_000 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'seat-limits-'));
  const claudeDir = join(home, '.config', 'claude-test');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: FAKE_LOGIN, expiresAt: NOW.getTime() + expiresIn, rateLimitTier: 'default_claude_max_20x', subscriptionType: 'max' },
  }));
  return { home, claudeDir, dir: join(home, 'SISO_Workspace', '_data', 'seat-limits') };
}
const answer = (body, status = 200, headers = {}) => async () => ({
  ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body,
});

test('the endpoint answer: weekly from seven_day, Fable from the weekly_scoped row, no 5-hour window is "none"', () => {
  const r = parseUsage(usage, READ);
  assert.deepEqual(r.seven_day, { pct: 73, resets_at: '2026-11-17T13:00:00.077Z', read_at: READ });
  assert.deepEqual(r.fable, { pct: 100, resets_at: '2026-11-17T13:00:00.077Z', read_at: READ });
  assert.deepEqual(r.five_hour, { pct: null, resets_at: null, read_at: READ });
});

test('the endpoint answer: a 5-hour window, a weekly only in limits[], and no Fable row', () => {
  const r = parseUsage({
    five_hour: { utilization: 41.25, resets_at: '2026-11-16T13:00:00+00:00' },
    seven_day: null,
    limits: [{ kind: 'weekly_all', percent: 88, resets_at: '2026-11-20T00:00:00+00:00' }],
  }, READ);
  assert.equal(r.five_hour.pct, 41.3);
  assert.equal(r.five_hour.resets_at, '2026-11-16T13:00:00.000Z');
  assert.equal(r.seven_day.pct, 88);
  assert.deepEqual(r.fable, { pct: null, resets_at: null, read_at: READ });
  assert.deepEqual(parseUsage(null, READ).seven_day, { pct: null, resets_at: null, read_at: READ });
});

test('the statusline JSON: rate_limits.five_hour / seven_day, used_percentage and resets_at in epoch seconds', () => {
  const r = parseStatusline({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 1763298000 }, seven_day: { used_percentage: 84.44, resets_at: 1763380800 } } }, READ);
  assert.deepEqual(r.five_hour, { pct: 12, resets_at: new Date(1763298000 * 1000).toISOString(), read_at: READ });
  assert.equal(r.seven_day.pct, 84.4);
  assert.deepEqual(parseStatusline({ model: { id: 'x' } }, READ), {});
});

test('plan, bands and reset words', () => {
  assert.equal(planOf({ rateLimitTier: 'default_claude_max_20x' }), 'Max 20x');
  assert.equal(planOf({ subscriptionType: 'pro' }), 'Pro');
  assert.deepEqual([null, 79.9, 80, 92, 95, 100, 130].map(bandOf), [0, 0, 80, 90, 95, 100, 100]);
  assert.equal(resetLabel('2026-11-19T10:00:00Z', NOW), 'Thu 10:00Z');
  assert.equal(resetLabel('2026-11-16T13:00:00Z', NOW), 'today 13:00Z');
  assert.equal(resetLabel('2026-11-17T12:59:59.712Z', NOW), 'Tue 13:00Z');
  assert.equal(resetLabel('2026-11-23T10:00:00Z', NOW), 'Mon 23 Nov 10:00Z');
});

test('warnings: the brief\'s own line for Fable, and a weekly line that names a seat with room', () => {
  const seatA = { seat: 'seat-a', fable: { pct: 84, resets_at: '2026-11-19T10:00:00Z', read_at: READ }, seven_day: { pct: 85, resets_at: '2026-11-20T00:00:00Z', read_at: READ }, five_hour: { pct: null, resets_at: null, read_at: READ } };
  const seatB = { seat: 'seat-b', seven_day: { pct: 73, resets_at: '2026-11-17T13:00:00Z', read_at: READ }, fable: { pct: 100, resets_at: '2026-11-17T13:00:00Z', read_at: READ }, five_hour: null };
  assert.deepEqual(warnings(seatA, [seatB], NOW), [
    'seat-a weekly 85%, resets Fri 00:00Z: start new long work on seat-b (weekly 73%) before it runs out',
    'seat-a weekly Fable 84%, resets Thu 10:00Z: switch Fable work to Opus',
  ]);
  assert.deepEqual(warnings(seatB, [seatA], NOW), ['seat-b weekly Fable 100%, resets Tue 13:00Z: Fable is used up on this seat, so run Fable work on Opus until then']);
  // a seat whose read is older than 2 h is not offered as the place with room
  const old = { ...seatB, seven_day: { ...seatB.seven_day, read_at: '2026-11-16T07:00:00Z' } };
  assert.match(warnings(seatA, [old], NOW)[0], /land what is open and start nothing long before it runs out/);
  assert.deepEqual(warnings({ seat: 'x', seven_day: { pct: 79, resets_at: null, read_at: READ } }, [], NOW), []);
});

test('the statusline line, with the reset only where it matters', () => {
  const rec = { seat: 'seat-b', ...parseUsage(usage, READ), read_at: READ };
  assert.equal(statusText(rec, NOW, { color: false }), 'seat-b · 5h – · week 73% · Fable 100% Tue 13:00Z');
  assert.match(statusText(rec, NOW), /\x1b\[31mFable 100%/);
  const stale = { ...rec, read_at: '2026-11-16T06:00:00Z' };
  assert.match(statusText(stale, NOW, { color: false }), /read 4h ago$/);
});

test('refresh: reads with the seat\'s own login, writes its record and limits.json, never writes the token', async () => {
  const { claudeDir, dir } = seatHome();
  let seen;
  const rec = await refresh({ seat: 'seat-b', claudeDir, dir, now: NOW, fetchImpl: async (url, init) => { seen = { url, init }; return answer(usage)(); } });
  assert.equal(seen.url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(seen.init.headers.Authorization, `Bearer ${FAKE_LOGIN}`);
  assert.equal(seen.init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(rec.plan, 'Max 20x');
  assert.equal(rec.seven_day.pct, 73);
  assert.equal(rec.fable.pct, 100);
  assert.equal(rec.resets_at, '2026-11-17T13:00:00.077Z');
  assert.equal(rec.read_at, READ);
  const merged = JSON.parse(readFileSync(join(dir, 'limits.json'), 'utf8'));
  assert.deepEqual(merged.seats.map((s) => s.seat), ['seat-b']);
  for (const f of readdirSync(dir)) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), new RegExp(FAKE_LOGIN));
  assert.equal(existsSync(join(dir, '.seat-b.lock')), false);
});

test('refresh: a fresh record is not read again; a stale one is; both seats land in limits.json', async () => {
  const { claudeDir, dir } = seatHome();
  let calls = 0;
  const f = async () => { calls += 1; return answer(usage)(); };
  await refresh({ seat: 'seat-b', claudeDir, dir, now: NOW, fetchImpl: f });
  await refresh({ seat: 'seat-b', claudeDir, dir, now: new Date(NOW.getTime() + REFRESH_MS - 1000), fetchImpl: f });
  assert.equal(calls, 1);
  await refresh({ seat: 'seat-b', claudeDir, dir, now: new Date(NOW.getTime() + REFRESH_MS), fetchImpl: f });
  assert.equal(calls, 2);
  await refresh({ seat: 'seat-a', claudeDir, dir, now: NOW, fetchImpl: f });
  const merged = JSON.parse(readFileSync(join(dir, 'limits.json'), 'utf8'));
  assert.deepEqual(merged.seats.map((s) => s.seat), ['seat-a', 'seat-b']);
});

test('refresh: an expired login, a 429 and a down endpoint keep the last numbers and wait before asking again', async () => {
  const { claudeDir, dir } = seatHome();
  await refresh({ seat: 's', claudeDir, dir, now: NOW, fetchImpl: answer(usage) });
  const later = new Date(NOW.getTime() + REFRESH_MS);
  const r429 = await refresh({ seat: 's', claudeDir, dir, now: later, fetchImpl: answer({}, 429, { 'retry-after': '1200' }) });
  assert.equal(r429.seven_day.pct, 73);
  assert.equal(r429.error.reason, 'usage endpoint said 429');
  assert.equal(r429.next_try_at, new Date(later.getTime() + 1_200_000).toISOString());
  assert.equal(due(r429, new Date(later.getTime() + 600_000)), false);
  const down = await refresh({ seat: 's', claudeDir, dir, now: later, force: true, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(down.error.reason, 'usage endpoint unreachable (network)');
  const expired = seatHome({ expiresIn: -1 });
  let called = false;
  const r = await refresh({ seat: 's', claudeDir: expired.claudeDir, dir: expired.dir, now: NOW, fetchImpl: async () => { called = true; return answer(usage)(); } });
  assert.equal(called, false);
  assert.match(r.error.reason, /login expired/);
});

test('refresh: a second reader while one holds the lock does not ask the endpoint', async () => {
  const { claudeDir, dir } = seatHome();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.s.lock'), '');
  let called = false;
  await refresh({ seat: 's', claudeDir, dir, now: new Date(), fetchImpl: async () => { called = true; return answer(usage)(); } });
  assert.equal(called, false);
});

test('hook: every turn start says it; a tool call says it only when a band rises', () => {
  const rec = { seat: 'seat-b', ...parseUsage(usage, READ), read_at: READ };
  const start = hookReply('UserPromptSubmit', rec, [], {}, NOW);
  assert.match(start.text, /^Seat limits \(seat-b's own plan, read just now from Claude's usage endpoint\): seat-b weekly Fable 100%/);
  assert.deepEqual(start.bands, { five_hour: 0, seven_day: 0, fable: 100 });
  assert.equal(hookReply('PostToolUse', rec, [], start.bands, NOW).text, null);
  assert.match(hookReply('PostToolUse', rec, [], { fable: 95 }, NOW).text, /Fable 100%/);
  assert.match(hookReply('UserPromptSubmit', rec, [], start.bands, NOW).text, /Fable 100%/);
  const calm = { ...rec, fable: { pct: 10, resets_at: null, read_at: READ } };
  assert.equal(hookReply('UserPromptSubmit', calm, [], {}, NOW).text, null);
  assert.equal(hookReply('UserPromptSubmit', null, [], {}, NOW).text, null);
});

test('install: statusLine and one hook group per event, kept idempotent; a seat\'s own statusLine is kept', () => {
  const { home, claudeDir, dir } = seatHome();
  const safety = { matcher: 'Bash', hooks: [{ type: 'command', command: "node '/x/.siso/agent-hooks/0.1.0/hooks/safety-guard.mjs'", timeout: 10 }] };
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ env: { A: '1' }, hooks: { PreToolUse: [safety], PostToolUse: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } }));
  const first = install({ seat: 'seat-b', claudeDir, home, dir, source: script });
  assert.equal(first.changed, true);
  const s = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(s.env.A, '1');
  assert.deepEqual(s.hooks.PreToolUse, [safety]);
  assert.match(s.statusLine.command, /seat-limits\.mjs' statusline --seat 'seat-b' --claude-dir '.*claude-test' --dir '.*seat-limits'$/);
  assert.equal(s.hooks.UserPromptSubmit.length, 1);
  assert.equal(s.hooks.PostToolUse.length, 2);
  assert.equal(s.hooks.PostToolUse[0].hooks[0].command, 'echo other');
  assert.ok(existsSync(join(home, '.siso', 'agent-stack', 'seat-limits', 'seat-limits.mjs')));
  assert.equal(install({ seat: 'seat-b', claudeDir, home, dir, source: script }).changed, false);
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'my-line' } }));
  const kept = install({ seat: 'seat-b', claudeDir, home, dir, source: script });
  assert.equal(JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).statusLine.command, 'my-line');
  assert.match(kept.notes[0], /kept the seat's own statusLine/);
});

test('the command line: statusline and hook answer from the file, and a broken input never fails the session', () => {
  const { claudeDir, dir } = seatHome();
  mkdirSync(dir, { recursive: true });
  const rec = { schema: 1, seat: 'seat-b', ...parseUsage(usage, new Date().toISOString()), read_at: new Date().toISOString() };
  writeFileSync(join(dir, 'seat-b.json'), JSON.stringify(rec));
  mergeAll(dir);
  const env = { ...process.env, SISO_SEAT_LIMITS_API: 'http://127.0.0.1:9/never', XDG_RUNTIME_DIR: mkdtempSync(join(tmpdir(), 'told-')) };
  const args = ['--seat', 'seat-b', '--claude-dir', claudeDir, '--dir', dir];
  const line = spawnSync(process.execPath, [script, 'statusline', ...args], { input: '{"rate_limits":{"seven_day":{"used_percentage":74,"resets_at":1763384400}}}', env, encoding: 'utf8' });
  assert.equal(line.status, 0);
  assert.match(line.stdout, /^seat-b · 5h – · week 74% · .*Fable 100%/);
  assert.match(line.stdout, /\nseat-b weekly Fable 100%/);
  const hook = spawnSync(process.execPath, [script, 'hook', ...args], { input: '{"hook_event_name":"UserPromptSubmit","session_id":"abc"}', env, encoding: 'utf8' });
  assert.equal(hook.status, 0);
  const out = JSON.parse(hook.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /Fable 100%/);
  const quiet = spawnSync(process.execPath, [script, 'hook', ...args], { input: '{"hook_event_name":"PostToolUse","session_id":"abc"}', env, encoding: 'utf8' });
  assert.equal(quiet.stdout, '');
  const broken = spawnSync(process.execPath, [script, 'hook', '--dir', dir], { input: 'not json', env, encoding: 'utf8' });
  assert.equal(broken.status, 0);
  assert.match(broken.stderr, /--seat is required/);
});
