import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every seat loads these profiles on every turn, so their size is paid on every call. A correction that keeps
// coming back belongs in a check or a hook, not another line here.
const profiles = join(dirname(fileURLToPath(import.meta.url)), '..', 'profiles');
const BUDGET = 4000;
const CREDIT = /Shaan, \d{1,2} [A-Z][a-z]{2}/;

for (const name of ['claude.md', 'codex.md']) {
  const text = readFileSync(join(profiles, name), 'utf8');

  test(`${name} stays under ${BUDGET} bytes`, () => {
    const size = Buffer.byteLength(text);
    assert.ok(size <= BUDGET, `${name} is ${size} bytes; make the new rule a check or a hook, or cut another line`);
  });

  test(`${name} states reasons, not who said it when`, () => {
    const hit = text.split('\n').find((line) => CREDIT.test(line));
    assert.equal(hit, undefined, `drop the "Shaan, <date>" credit and state the reason instead: ${hit}`);
  });
}
