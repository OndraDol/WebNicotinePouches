import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
const indexSource = readFileSync(indexPath, 'utf8');

function loadStreakCalculator() {
  const match = indexSource.match(
    /\/\/ --- RECORDED-DAY STREAK START ---\r?\n([\s\S]*?)\r?\n\s*\/\/ --- RECORDED-DAY STREAK END ---/
  );
  assert.ok(match, 'index.html must contain the recorded-day streak helper');

  const context = {};
  runInNewContext(
    `${match[1]}\nthis.calculateRecordedDayStreak = calculateRecordedDayStreak;`,
    context
  );
  return context.calculateRecordedDayStreak;
}

function localDateKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const today = new Date(2026, 7, 14, 12);
const limitOf = (limits = {}, fallback = 3) => (date) => limits[localDateKey(date)] ?? fallback;

test('old isolated records followed by inactivity produce no streak', () => {
  const calculate = loadStreakCalculator();
  assert.equal(calculate({ '2025-11-28': 1 }, today, limitOf()), 0);
});

test('consecutive recorded days within their limits are counted', () => {
  const calculate = loadStreakCalculator();
  const days = { '2026-08-14': 2, '2026-08-13': 1, '2026-08-12': 3 };
  assert.equal(calculate(days, today, limitOf()), 3);
});

test('a recorded current day is included immediately', () => {
  const calculate = loadStreakCalculator();
  assert.equal(calculate({ '2026-08-14': 1 }, today, limitOf()), 1);
});

test('an unrecorded current day preserves a streak ending yesterday', () => {
  const calculate = loadStreakCalculator();
  const days = { '2026-08-13': 1, '2026-08-12': 2, '2026-08-11': 1 };
  assert.equal(calculate(days, today, limitOf()), 3);
});

test('missing both today and yesterday produces no streak', () => {
  const calculate = loadStreakCalculator();
  assert.equal(calculate({ '2026-08-12': 1 }, today, limitOf()), 0);
});

test('an empty day inside the sequence ends the streak', () => {
  const calculate = loadStreakCalculator();
  const days = { '2026-08-14': 1, '2026-08-13': 1, '2026-08-11': 1 };
  assert.equal(calculate(days, today, limitOf()), 2);
});

test('a recorded day above its dynamic limit ends the streak', () => {
  const calculate = loadStreakCalculator();
  const days = { '2026-08-14': 1, '2026-08-13': 2, '2026-08-12': 1 };
  const limits = { '2026-08-14': 2, '2026-08-13': 1, '2026-08-12': 2 };
  assert.equal(calculate(days, today, limitOf(limits)), 1);
});

test('empty history produces no streak', () => {
  const calculate = loadStreakCalculator();
  assert.equal(calculate({}, today, limitOf()), 0);
});

test('calculateStats delegates streak calculation to the recorded-day helper', () => {
  assert.match(
    indexSource,
    /const streak = calculateRecordedDayStreak\(days, today, getDynamicLimitForDate\);/
  );
});
