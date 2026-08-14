import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { hashInputCard, hashSnapshot, sha256 } from './recheck-v3-schema.mjs';

const EXPECTED_ROWS = 861;

function stripHash(row) {
  const { input_card_sha256: ignored, ...withoutHash } = row;
  return withoutHash;
}

function parseDataSource(dataSourceText) {
  const marker = 'export const POUCH_DB =';
  const start = dataSourceText.indexOf(marker);
  if (start < 0) throw new Error('data.js does not export POUCH_DB');
  const nextExport = dataSourceText.indexOf('\nexport const ', start + marker.length);
  const end = nextExport < 0 ? dataSourceText.length : nextExport;
  const expression = dataSourceText.slice(start + marker.length, end).trim().replace(/;\s*$/u, '');
  const rows = runInNewContext(`(${expression})`, Object.create(null), { timeout: 1000 });
  if (!Array.isArray(rows)) throw new Error('data.js POUCH_DB is not an array');
  return rows;
}

function triple(row) {
  return { b: row.b, n: row.n, mg: row.mg };
}

function sameTriple(left, right) {
  return left?.b === right?.b && left?.n === right?.n && Number(left?.mg) === Number(right?.mg);
}

function snapshotHashInput(snapshot) {
  return {
    schema: snapshot.schema,
    source_file: snapshot.source_file,
    input_snapshot_sha256: snapshot.input_snapshot_sha256,
    data_source_sha256: snapshot.data_source_sha256,
    rows: snapshot.rows,
  };
}

export function buildInputSnapshot({ inputSnapshot, unresolvedInput, dataSourceText, now = new Date().toISOString() }) {
  if (!inputSnapshot || !Array.isArray(inputSnapshot.rows)) throw new Error('input.json rows are required');
  if (!unresolvedInput || !Array.isArray(unresolvedInput.rows)) throw new Error('unresolved-input.json rows are required');
  if (unresolvedInput.rows.length !== EXPECTED_ROWS) throw new Error(`Expected exactly ${EXPECTED_ROWS} unresolved input rows`);
  const unresolvedIds = unresolvedInput.rows.map((row) => row.input_id);
  if (new Set(unresolvedIds).size !== EXPECTED_ROWS) throw new Error('Unresolved input IDs must be unique');
  const inputById = new Map(inputSnapshot.rows.map((row) => [row.input_id, row]));
  const currentRows = parseDataSource(dataSourceText);
  const rows = unresolvedInput.rows.map((unresolvedRow) => {
    const inputRow = inputById.get(unresolvedRow.input_id);
    if (!inputRow) throw new Error(`Unresolved input ID missing from input snapshot: ${unresolvedRow.input_id}`);
    if (!sameTriple(inputRow.original, unresolvedRow.original)) throw new Error(`Unresolved input original mismatch: ${unresolvedRow.input_id}`);
    if (!currentRows.some((row) => sameTriple(row, inputRow.original))) throw new Error(`Current data.js no longer contains frozen card ${unresolvedRow.input_id}`);
    const row = {
      input_id: inputRow.input_id,
      original_index: inputRow.original_index,
      original: triple(inputRow.original),
    };
    return { ...row, input_card_sha256: hashInputCard(row) };
  });
  const sourceSnapshot = {
    schema: inputSnapshot.schema,
    source_file: inputSnapshot.source_file,
    source_sha256: inputSnapshot.source_sha256,
    expected_input_rows: inputSnapshot.expected_input_rows,
    input_rows: inputSnapshot.input_rows,
  };
  const snapshot = {
    schema: 3,
    created_at: now,
    source_file: inputSnapshot.source_file ?? 'audit/pouches/input.json',
    input_snapshot_sha256: sha256(sourceSnapshot),
    data_source_sha256: sha256(dataSourceText),
    rows,
  };
  return { ...snapshot, snapshot_sha256: hashSnapshot(snapshot) };
}

export function assertFrozenSnapshot(existing, candidate) {
  if (!existing || !candidate) throw new Error('Both frozen and candidate snapshots are required');
  if (existing.schema !== 3 || candidate.schema !== 3) throw new Error('Snapshot schema must be 3');
  if (existing.rows.length !== EXPECTED_ROWS || candidate.rows.length !== EXPECTED_ROWS) throw new Error('Frozen snapshot must contain exactly 861 rows');
  const existingIds = existing.rows.map((row) => row.input_id);
  const candidateIds = candidate.rows.map((row) => row.input_id);
  if (JSON.stringify(existingIds) !== JSON.stringify(candidateIds)) throw new Error('Frozen snapshot membership or order changed');
  if (existing.data_source_sha256 !== candidate.data_source_sha256 || existing.input_snapshot_sha256 !== candidate.input_snapshot_sha256) throw new Error('Frozen snapshot source hash changed');
  for (let index = 0; index < existing.rows.length; index += 1) {
    const left = existing.rows[index];
    const right = candidate.rows[index];
    if (JSON.stringify(left.original) !== JSON.stringify(right.original) || left.original_index !== right.original_index) throw new Error(`Frozen original changed at row ${index + 1}`);
    if (right.input_card_sha256 !== hashInputCard(stripHash(right)) || left.input_card_sha256 !== hashInputCard(stripHash(left))) throw new Error(`Frozen input card hash changed at row ${index + 1}`);
  }
  if (existing.snapshot_sha256 !== hashSnapshot(existing) || candidate.snapshot_sha256 !== hashSnapshot(candidate)) throw new Error('Frozen snapshot hash is invalid');
  if (existing.snapshot_sha256 !== candidate.snapshot_sha256) throw new Error('Frozen snapshot hash changed');
  return true;
}

export async function freezeInputSnapshot({ inputPath, unresolvedPath, dataPath, outputPath, now }) {
  const [inputSnapshot, unresolvedInput, dataSourceText] = await Promise.all([
    readFile(resolve(inputPath), 'utf8').then(JSON.parse),
    readFile(resolve(unresolvedPath), 'utf8').then(JSON.parse),
    readFile(resolve(dataPath), 'utf8'),
  ]);
  const candidate = buildInputSnapshot({ inputSnapshot, unresolvedInput, dataSourceText, now });
  try {
    const existing = JSON.parse(await readFile(resolve(outputPath), 'utf8'));
    assertFrozenSnapshot(existing, candidate);
    return { snapshot: existing, unchanged: true };
  } catch (error) {
    if (error.code !== 'ENOENT' && !/ENOENT/u.test(String(error.message))) throw error;
  }
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(resolve(outputPath), `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
  return { snapshot: candidate, unchanged: false };
}

export { EXPECTED_ROWS };
