import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseBitrateKbps, cleanName, fmtClock, fmtDuration, mergeSegments, safeDirName } from './format.js';

test('fmtClock', () => {
  assert.equal(fmtClock(65.9), '01:05');
  assert.equal(fmtClock(3725), '1:02:05');
});

test('fmtDuration', () => {
  assert.equal(fmtDuration(10_000), '1 min');
  assert.equal(fmtDuration(42 * 60_000), '42 min');
  assert.equal(fmtDuration(95 * 60_000), '1 h 35 min');
});

test('mergeSegments orders by time and drops blanks', () => {
  const out = mergeSegments({
    alice: [{ start: 5, end: 6, text: ' second ' }, { start: 9, end: 10, text: '   ' }],
    bob: [{ start: 1, end: 2, text: 'first' }],
  });
  assert.deepEqual(out, ['[00:01] bob: first', '[00:05] alice: second']);
});

test('chooseBitrateKbps fits the budget or gives up', () => {
  assert.equal(chooseBitrateKbps(9_000_000, 600_000), 24);
  assert.equal(chooseBitrateKbps(9_000_000, 3600_000), 20);
  assert.equal(chooseBitrateKbps(9_000_000, 3 * 3600_000), null);
});

test('cleanName strips markdown and control characters', () => {
  assert.equal(cleanName('**ev\nil**_x_'), 'evilx');
  assert.equal(cleanName('***'), 'unknown');
  assert.equal(cleanName('a'.repeat(100)).length, 32);
});

test('safeDirName', () => {
  assert.equal(safeDirName('General / Lounge!'), 'General-Lounge');
  assert.equal(safeDirName('///'), 'session');
});
