import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
const source = readFileSync(indexPath, 'utf8');

test('index imports the tested application-core helpers', () => {
  assert.match(source, /from ['"]\.\/app-core\.mjs['"]/);
  for (const helper of [
    'buildHistoryCsv',
    'evaluatePeriodAchievements',
    'getHistoryOwnerMode',
    'mergeHistories',
    'safeParseJson',
    'selectBenchmark',
    'toLocalDateTimeInput',
    'validateBackup',
    'validateSettings'
  ]) {
    assert.match(source, new RegExp(`\\b${helper}\\b`));
  }
});

test('startup storage reads use safe JSON parsing', () => {
  assert.doesNotMatch(source, /JSON\.parse\(localStorage\.getItem\(/);
  assert.match(source, /safeParseStoredValue\('nt_history'/);
  assert.match(source, /safeParseStoredValue\('nt_settings'/);
});

test('history actions do not interpolate imported IDs into inline JavaScript', () => {
  assert.doesNotMatch(source, /onclick="(?:window\.)?(?:editHist|delHist)\('/);
  assert.match(source, /editButton\.addEventListener\('click'/);
  assert.match(source, /deleteButton\.addEventListener\('click'/);
});

test('wizard and backup restore use strict validated values before state mutation', () => {
  assert.match(source, /const validation = validateSettings\(/);
  assert.match(source, /const validation = validateBackup\(/);
  assert.match(source, /if\s*\(!validation\.ok\)\s*\{/);
});

test('history editor and CSV export delegate to tested local-date and escaping helpers', () => {
  assert.match(source, /toLocalDateTimeInput\(entry\.date\)/);
  assert.match(source, /buildHistoryCsv\(state\.history\)/);
  assert.doesNotMatch(source, /entry\.date\.slice\(0,\s*10\)/);
});

test('empty benchmark and period badges delegate to tested helpers', () => {
  assert.match(source, /selectBenchmark\(dailyAvg,\s*USER_BENCHMARKS,\s*state\.history\.length\)/);
  assert.match(source, /evaluatePeriodAchievements\(/);
});

test('authentication title uses translations instead of hard-coded English', () => {
  assert.match(source, /isRegistering\s*\?\s*t\('register'\)\s*:\s*t\('auth_title'\)/);
  assert.doesNotMatch(source, /isRegistering\s*\?\s*"Register"\s*:\s*"Sync"/);
});

test('remote history snapshots are allowed to replace local state with an empty array', () => {
  assert.doesNotMatch(source, /if\s*\(h\.length\)\s*\{\s*state\.history\s*=\s*normalizeHistory\(h\)/);
  assert.match(source, /state\.history\s*=\s*normalizeHistory\(remoteHistory\)/);
});

test('account deletion requires exact e-mail confirmation and provider reauthentication', () => {
  assert.match(source, /id="deleteAccountModal"/);
  assert.match(source, /id="deleteAccountBtn"/);
  assert.match(source, /confirmationEmail\s*!==\s*state\.user\.email/);
  assert.match(source, /reauthenticateWithPopup\(state\.user,\s*new GoogleAuthProvider\(\)\)/);
  assert.match(source, /EmailAuthProvider\.credential\(state\.user\.email,\s*password\)/);
  assert.match(source, /reauthenticateWithCredential\(state\.user,\s*credential\)/);
});

test('account deletion calls the backend before clearing PouchLog local keys', () => {
  const callableIndex = source.indexOf("httpsCallable(functionsClient, 'deleteAccount')");
  const handlerIndex = source.indexOf('async function handleDeleteAccount()');
  const invokeIndex = source.indexOf('await deleteAccountRequest()', handlerIndex);
  const clearIndex = source.indexOf("startsWith('nt_')", handlerIndex);
  assert.ok(callableIndex > -1);
  assert.ok(handlerIndex > -1);
  assert.ok(invokeIndex > handlerIndex);
  assert.ok(clearIndex > invokeIndex);
});
