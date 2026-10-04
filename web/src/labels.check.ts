// Self-check for the pure helpers in labels.ts. Run: node web/src/labels.check.ts
import { daysUntil, excerptPattern, fromLocalInput, groupOf, toLocalInput } from './labels.ts';

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`labels.check failed: ${what}`);
};
const found = (q: string, text: string, maxWords?: number) => text.search(excerptPattern(q, maxWords)!) !== -1;

check(found('IELTS  Academic\n overall 7.0', 'Result: ielts academic overall   7.0 (C1)'), 'excerpt ignores case and whitespace');
check(found('fee (USD) $50+ [a]', 'the fee (usd) $50+ [a] applies'), 'regex characters are literal');
check(!found('one two three', 'one two four') && found('one two three', 'one two four', 2), 'maxWords keeps the start');
check(excerptPattern('  ') === null && excerptPattern(null) === null, 'blank excerpt has no pattern');
check(daysUntil('2026-10-14', new Date(2026, 9, 4, 23, 30)) === 10, 'days until a calendar day');
check(daysUntil('2026-10-03', new Date(2026, 9, 4, 0, 5)) === -1, 'a past day is negative');
check(fromLocalInput(toLocalInput('2026-10-04T10:15:00.000Z')) === '2026-10-04T10:15:00.000Z', 'datetime-local round trip');
check(groupOf({ status: 'satisfied', user_verified: false }) === 'evidence', 'AI evidence is not verification');
check(groupOf({ status: 'satisfied', user_verified: true }) === 'verified' && groupOf(null) === 'pending', 'verified / not assessed');
console.log('labels.check: ok');
