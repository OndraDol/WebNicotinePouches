import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHistoryCsv,
  evaluatePeriodAchievements,
  getHistoryOwnerMode,
  mergeHistories,
  safeParseJson,
  selectBenchmark,
  toLocalDateTimeInput,
  validateBackup,
  validateSettings
} from '../app-core.mjs';

const validSettings = {
  currency: 'CZK',
  packPrice: 150,
  pouchesPerPack: 20,
  dailyLimit: 5,
  goal: 'track',
  createdAt: new Date(2026, 7, 1, 12).getTime(),
  onboarded: true
};

const validEntry = {
  id: '1723725000000',
  brand: 'VELO',
  name: 'Freeze',
  mg: 10,
  date: new Date(2026, 7, 14, 9, 30).toISOString(),
  localDate: '2026-08-14'
};

test('safeParseJson returns fallback and reports corrupt JSON without changing the source', () => {
  const raw = '{broken';
  const fallback = [];
  const errors = [];

  const parsed = safeParseJson(raw, fallback, (error) => errors.push(error));

  assert.equal(parsed, fallback);
  assert.equal(raw, '{broken');
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Error);
});

test('safeParseJson accepts valid JSON and handles a missing value', () => {
  assert.deepEqual(safeParseJson('{"ok":true}', null), { ok: true });
  assert.deepEqual(safeParseJson(null, { fallback: true }), { fallback: true });
});

test('validateSettings trims valid input and normalizes numeric fields', () => {
  const result = validateSettings({
    ...validSettings,
    currency: ' CZK ',
    packPrice: '149.90',
    pouchesPerPack: '20',
    dailyLimit: '0'
  }, '2026-08-14');

  assert.equal(result.ok, true);
  assert.deepEqual(
    {
      currency: result.value.currency,
      packPrice: result.value.packPrice,
      pouchesPerPack: result.value.pouchesPerPack,
      dailyLimit: result.value.dailyLimit
    },
    { currency: 'CZK', packPrice: 149.9, pouchesPerPack: 20, dailyLimit: 0 }
  );
});

test('validateSettings rejects blank currency, invalid quantities, and a past quit date', () => {
  const result = validateSettings({
    ...validSettings,
    currency: '   ',
    packPrice: -1,
    pouchesPerPack: 0,
    dailyLimit: -2,
    goal: 'quit',
    strategy: 'smooth',
    targetDate: '2026-08-13'
  }, '2026-08-14');

  assert.equal(result.ok, false);
  assert.deepEqual(
    new Set(result.errors.map((error) => error.field)),
    new Set(['currency', 'packPrice', 'pouchesPerPack', 'dailyLimit', 'targetDate'])
  );
});

test('validateSettings rejects fractions for integer settings and allows today as quit target', () => {
  const invalid = validateSettings({ ...validSettings, pouchesPerPack: 2.5, dailyLimit: 1.5 }, '2026-08-14');
  assert.equal(invalid.ok, false);

  const valid = validateSettings({
    ...validSettings,
    goal: 'quit',
    strategy: 'cutoff',
    targetDate: '2026-08-14'
  }, '2026-08-14');
  assert.equal(valid.ok, true);
});

test('validateBackup accepts a complete valid backup and normalizes dates', () => {
  const result = validateBackup({ settings: validSettings, history: [validEntry] }, '2026-08-14');

  assert.equal(result.ok, true);
  assert.equal(result.value.history.length, 1);
  assert.equal(result.value.history[0].date, validEntry.date);
  assert.equal(result.value.history[0].localDate, '2026-08-14');
});

test('validateBackup rejects the entire backup when a history ID could inject JavaScript', () => {
  const malicious = { ...validEntry, id: "x');window.__qaXss='executed';//" };
  const result = validateBackup({ settings: validSettings, history: [validEntry, malicious] }, '2026-08-14');

  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.ok(result.errors.some((error) => error.field === 'history[1].id'));
});

test('validateBackup rejects invalid root values, future records, and blank names', () => {
  assert.equal(validateBackup(null, '2026-08-14').ok, false);
  const result = validateBackup({
    settings: validSettings,
    history: [{ ...validEntry, name: ' ', date: new Date(2026, 7, 15, 9).toISOString() }]
  }, '2026-08-14');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.field === 'history[0].name'));
  assert.ok(result.errors.some((error) => error.field === 'history[0].date'));
});

test('toLocalDateTimeInput uses the local calendar day around Prague midnight', () => {
  const value = toLocalDateTimeInput('2026-08-14T22:30:00.000Z');
  assert.deepEqual(value, { date: '2026-08-15', time: '00:30' });
});

test('buildHistoryCsv escapes quotes, commas, newlines, Czech text, and formulas', () => {
  const csv = buildHistoryCsv([{
    ...validEntry,
    brand: '=HYPERLINK("https://invalid.example")',
    name: 'Řada, "silná"\nnová'
  }]);

  assert.ok(csv.startsWith('\uFEFFDate,Time,Brand,Name,Mg\r\n'));
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/invalid\.example""\)"/);
  assert.match(csv, /"Řada, ""silná""\nnová"/);
  assert.ok(csv.endsWith(',10\r\n'));
});

test('mergeHistories returns a stable date order and lets remote records win ID conflicts', () => {
  const localOnly = { ...validEntry, id: 'local', date: new Date(2026, 7, 14, 8).toISOString() };
  const localConflict = { ...validEntry, id: 'same', name: 'Local', date: new Date(2026, 7, 14, 9).toISOString() };
  const remoteConflict = { ...localConflict, name: 'Remote' };
  const remoteOnly = { ...validEntry, id: 'remote', date: new Date(2026, 7, 14, 10).toISOString() };

  const result = mergeHistories([localOnly, localConflict], [remoteConflict, remoteOnly]);

  assert.deepEqual(result.merged.map((entry) => entry.id), ['remote', 'same', 'local']);
  assert.equal(result.merged.find((entry) => entry.id === 'same').name, 'Remote');
  assert.deepEqual(result.localOnly.map((entry) => entry.id), ['local']);
});

test('getHistoryOwnerMode distinguishes guest, current account, and another account', () => {
  assert.equal(getHistoryOwnerMode(null, 'uid-a'), 'guest');
  assert.equal(getHistoryOwnerMode('guest', 'uid-a'), 'guest');
  assert.equal(getHistoryOwnerMode('uid-a', 'uid-a'), 'current');
  assert.equal(getHistoryOwnerMode('uid-b', 'uid-a'), 'other');
});

test('selectBenchmark returns no percentile for empty history', () => {
  const benchmarks = [{ max: 2, percentile: 10 }, { max: 5, percentile: 50 }];
  assert.equal(selectBenchmark(0, benchmarks, 0), null);
  assert.deepEqual(selectBenchmark(1.5, benchmarks, 2), benchmarks[0]);
});

test('period badges stay locked when tracking started today', () => {
  const today = new Date(2026, 7, 14, 12);
  const result = evaluatePeriodAchievements({
    createdAt: today.getTime(),
    history: [validEntry],
    today,
    getLimitForDate: () => 5
  });

  assert.deepEqual(result, { cleanWeekend: false, yesterdaySuccess: false });
});

test('period badges evaluate only completed periods after tracking began', () => {
  const today = new Date(2026, 7, 14, 12);
  const result = evaluatePeriodAchievements({
    createdAt: new Date(2026, 7, 7, 9).getTime(),
    history: [
      { ...validEntry, id: 'sat', date: new Date(2026, 7, 8, 10).toISOString(), localDate: '2026-08-08' },
      { ...validEntry, id: 'thu', date: new Date(2026, 7, 13, 10).toISOString(), localDate: '2026-08-13' }
    ],
    today,
    getLimitForDate: () => 2
  });

  assert.deepEqual(result, { cleanWeekend: true, yesterdaySuccess: true });
});

test('period badges fail when the completed period exceeds its limit', () => {
  const today = new Date(2026, 7, 14, 12);
  const history = [
    ...Array.from({ length: 3 }, (_, index) => ({
      ...validEntry,
      id: `sat-${index}`,
      date: new Date(2026, 7, 8, 10 + index).toISOString(),
      localDate: '2026-08-08'
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      ...validEntry,
      id: `thu-${index}`,
      date: new Date(2026, 7, 13, 10 + index).toISOString(),
      localDate: '2026-08-13'
    }))
  ];

  const result = evaluatePeriodAchievements({
    createdAt: new Date(2026, 7, 1, 9).getTime(),
    history,
    today,
    getLimitForDate: () => 2
  });

  assert.deepEqual(result, { cleanWeekend: false, yesterdaySuccess: false });
});
