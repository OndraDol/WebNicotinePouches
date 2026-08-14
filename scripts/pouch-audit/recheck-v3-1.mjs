import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hashInputCard, hashSnapshot, readRawEvents, sha256 } from './recheck-v3-schema.mjs';
import { researchOneInput } from './recheck-v3-1-research.mjs';
import { deriveResults } from './recheck-v3-1-validator.mjs';
import { qaAll, qaInput } from './recheck-v3-1-qa.mjs';
import { applyVerifiedChanges } from './recheck-v3-1-apply.mjs';
import { buildManifest, buildReport, deterministicGzip, summarizeFallbacks } from './recheck-v3-1-artifacts.mjs';

export const EXPECTED_ROWS = 861;
export const PILOT_BRAND = '77 Pouches';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const AUDIT_DIR = join(ROOT, 'audit', 'pouches', 'recheck-v3.1');
export const PATHS = Object.freeze({
  data: join(ROOT, 'data.js'),
  input: join(ROOT, 'audit', 'pouches', 'input.json'),
  unresolved: join(ROOT, 'audit', 'pouches', 'unresolved-input.json'),
  snapshot: join(AUDIT_DIR, 'input-snapshot.json'),
  raw: join(AUDIT_DIR, 'raw-events.jsonl'),
  results: join(AUDIT_DIR, 'derived-results.jsonl'),
  qa: join(AUDIT_DIR, 'qa.jsonl'),
  progress: join(AUDIT_DIR, 'progress.json'),
  approval: join(AUDIT_DIR, 'approval.json'),
  report: join(AUDIT_DIR, 'report.md'),
  reportGz: join(AUDIT_DIR, 'report.md.gz'),
  rawGz: join(AUDIT_DIR, 'raw-events.jsonl.gz'),
  manifest: join(AUDIT_DIR, 'manifest.json'),
  summary: join(AUDIT_DIR, 'summary.md'),
});

function parseDataSource(dataText) {
  const marker = 'export const POUCH_DB =';
  const start = dataText.indexOf(marker);
  if (start < 0) throw new Error('data.js does not export POUCH_DB');
  const end = dataText.indexOf('\nexport const ', start + marker.length);
  const expression = dataText.slice(start + marker.length, end < 0 ? dataText.length : end).trim().replace(/;\s*$/u, '');
  const rows = runInNewContext(`(${expression})`, Object.create(null), { timeout: 1000 });
  if (!Array.isArray(rows)) throw new Error('POUCH_DB is not an array');
  return rows;
}

function sameTriple(left, right) { return left?.b === right?.b && left?.n === right?.n && Number(left?.mg) === Number(right?.mg); }

export function buildSnapshot({ input, unresolved, dataText, now = new Date().toISOString() }) {
  if (!Array.isArray(input?.rows) || !Array.isArray(unresolved?.rows)) throw new Error('input and unresolved rows are required');
  if (unresolved.rows.length !== EXPECTED_ROWS) throw new Error(`Expected exactly ${EXPECTED_ROWS} unresolved rows`);
  const inputById = new Map(input.rows.map((row) => [row.input_id, row]));
  const dataRows = parseDataSource(dataText);
  const rows = unresolved.rows.map((unresolvedRow) => {
    const inputRow = inputById.get(unresolvedRow.input_id);
    if (!inputRow || !sameTriple(inputRow.original, unresolvedRow.original)) throw new Error(`Frozen input mismatch: ${unresolvedRow.input_id}`);
    if (!dataRows.some((row) => sameTriple(row, inputRow.original))) throw new Error(`Frozen card missing from data.js: ${unresolvedRow.input_id}`);
    const row = { input_id: inputRow.input_id, original_index: inputRow.original_index, original: { b: inputRow.original.b, n: inputRow.original.n, mg: inputRow.original.mg } };
    return { ...row, input_card_sha256: hashInputCard(row) };
  });
  if (new Set(rows.map((row) => row.input_id)).size !== EXPECTED_ROWS) throw new Error('Frozen input IDs must be unique');
  const snapshot = {
    schema: 3,
    audit_version: '3.1',
    created_at: now,
    source_file: input.source_file ?? 'audit/pouches/input.json',
    input_snapshot_sha256: input.source_sha256 ?? sha256(input),
    data_source_sha256: sha256(dataText),
    rows,
  };
  return { ...snapshot, snapshot_sha256: hashSnapshot(snapshot) };
}

async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
async function readLines(path) { if (!existsSync(path)) return []; return (await readFile(path, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)); }
async function writeLines(path, rows) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8'); }

async function shaFile(path) { return sha256(await readFile(path)); }

async function historicalHashes() {
  const paths = [PATHS.data, join(ROOT, 'scripts', 'pouch-audit', 'recheck-v2.mjs'), join(ROOT, 'scripts', 'pouch-audit', 'recheck-v2.test.mjs')];
  const v3Dir = join(ROOT, 'audit', 'pouches', 'recheck-v3');
  if (existsSync(v3Dir)) {
    const { readdir } = await import('node:fs/promises');
    async function collect(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await collect(path); else paths.push(path); } }
    await collect(v3Dir);
  }
  const result = {};
  for (const path of paths) if (existsSync(path)) result[relative(ROOT, path).replaceAll('\\', '/')] = await shaFile(path);
  return result;
}

async function loadSnapshot() { return json(PATHS.snapshot); }
async function loadRaw() { return readRawEvents(PATHS.raw); }
function pilotRows(snapshot) { const rows = snapshot.rows.filter((row) => row.original.b === PILOT_BRAND); if (rows.length !== 5) throw new Error(`Expected five pilot rows, got ${rows.length}`); return rows; }
async function selectedValidation(ids = null) {
  const snapshot = await loadSnapshot();
  const events = await loadRaw();
  const selected = ids ? new Set(ids) : null;
  const rows = selected ? snapshot.rows.filter((row) => selected.has(row.input_id)) : snapshot.rows;
  const scoped = { ...snapshot, rows, snapshot_sha256: selected ? null : snapshot.snapshot_sha256 };
  const scopedEvents = selected ? events.filter((event) => selected.has(event.input_id)) : events;
  return { snapshot, events, result: deriveResults(scoped, scopedEvents, { skipChain: Boolean(selected) }), rows, scopedEvents };
}

async function runResearchRows(rows) {
  for (const row of rows) await researchOneInput(row, { outputPath: PATHS.raw, responseCache: new Map() });
}

async function validateAndWrite(ids = null) {
  const scoped = await selectedValidation(ids);
  await writeLines(PATHS.results, scoped.result.rows);
  return scoped;
}

async function qaAndWrite(ids = null) {
  const scoped = await selectedValidation(ids);
  const qaRows = scoped.rows.map((row) => qaInput(row, scoped.scopedEvents.filter((event) => event.input_id === row.input_id), scoped.result.rows.find((item) => item.input_id === row.input_id), { skipChain: true }));
  await writeLines(PATHS.qa, qaRows);
  return { ...scoped, qaRows };
}

async function freeze() {
  const input = await json(PATHS.input);
  const unresolved = await json(PATHS.unresolved);
  const dataText = await readFile(PATHS.data, 'utf8');
  const baseline = await historicalHashes();
  const snapshot = buildSnapshot({ input, unresolved, dataText });
  if (existsSync(PATHS.snapshot)) {
    const old = await loadSnapshot();
    if (old.snapshot_sha256 !== snapshot.snapshot_sha256 || old.data_source_sha256 !== snapshot.data_source_sha256) throw new Error('Existing v3.1 snapshot is bound to a different initial data.js');
  } else await writeJson(PATHS.snapshot, snapshot);
  await writeJson(PATHS.progress, { schema: 'pouch-audit-v3.1-progress', run_id: `recheck-v3.1-${snapshot.snapshot_sha256.slice(0, 12)}`, snapshot_sha256: snapshot.snapshot_sha256, processed_ids: [], completed_batches: [], pre_run_hashes: baseline });
  return snapshot;
}

async function pilot() {
  const snapshot = await loadSnapshot();
  const rows = pilotRows(snapshot);
  await runResearchRows(rows);
  return rows;
}

async function recordPreapproval() {
  const snapshot = await loadSnapshot();
  const validatorSource = await shaFile(join(ROOT, 'scripts', 'pouch-audit', 'recheck-v3-1-validator.mjs'));
  const qaSource = await shaFile(join(ROOT, 'scripts', 'pouch-audit', 'recheck-v3-1-qa.mjs'));
  const approval = { schema: 'pouch-audit-v3.1-approval', snapshot_sha256: snapshot.snapshot_sha256, validator_source_sha256: validatorSource, qa_source_sha256: qaSource, pilot_input_ids: pilotRows(snapshot).map((row) => row.input_id), approved_at: new Date().toISOString(), basis: 'explicit user preapproval for all 861 and main push' };
  await writeJson(PATHS.approval, approval);
  return approval;
}

async function loadProgress() { return existsSync(PATHS.progress) ? json(PATHS.progress) : { processed_ids: [], completed_batches: [] }; }

async function runOneBatch(limit = 25) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('Batch limit must be an integer from 1 to 25');
  const snapshot = await loadSnapshot();
  const progress = await loadProgress();
  const done = new Set(progress.processed_ids ?? []);
  const remaining = snapshot.rows.filter((row) => !done.has(row.input_id));
  if (!remaining.length) return { finished: true, progress };
  const brand = remaining[0].original.b;
  const batch = remaining.filter((row) => row.original.b === brand).slice(0, limit);
  await runResearchRows(batch);
  const ids = batch.map((row) => row.input_id);
  const validated = await validateAndWrite(ids);
  if (validated.result.summary.pending !== 0 || validated.result.summary.unreviewed !== 0 || !validated.result.ok) throw new Error(`Checkpoint gate failed for batch ${brand}: ${JSON.stringify(validated.result.summary)}`);
  const qa = await qaAndWrite(ids);
  if (qa.qaRows.some((row) => row.qa_status !== 'qa_passed')) throw new Error(`QA checkpoint failed for batch ${brand}`);
  const next = { ...progress, processed_ids: [...new Set([...progress.processed_ids, ...ids])], completed_batches: [...(progress.completed_batches ?? []), { brand, input_ids: ids, count: ids.length, validator: validated.result.summary, qa_passed: qa.qaRows.length }] };
  await writeJson(PATHS.progress, next);
  return { finished: next.processed_ids.length === EXPECTED_ROWS, progress: next, summary: validated.result.summary };
}

async function runAll() {
  if (!existsSync(PATHS.approval)) throw new Error('Full run requires --record-preapproval');
  const approval = await json(PATHS.approval);
  const snapshot = await loadSnapshot();
  if (approval.snapshot_sha256 !== snapshot.snapshot_sha256 || approval.pilot_input_ids.length !== 5) throw new Error('Approval does not bind the current snapshot and five pilot IDs');
  const pilotIds = approval.pilot_input_ids;
  const pilotValidation = await selectedValidation(pilotIds);
  if (pilotValidation.result.summary.pending !== 0 || pilotValidation.result.summary.unreviewed !== 0 || !pilotValidation.result.ok) throw new Error('Pilot gate failed; full run stopped');
  const pilotQa = await qaAndWrite(pilotIds);
  if (pilotQa.qaRows.some((row) => row.qa_status !== 'qa_passed')) throw new Error('Pilot QA gate failed; full run stopped');
  const progress = await loadProgress();
  await writeJson(PATHS.progress, { ...progress, processed_ids: [...new Set([...(progress.processed_ids ?? []), ...pilotIds])] });
  let state = await runOneBatch(25);
  while (!state.finished) state = await runOneBatch(25);
  return state;
}

async function report() {
  const snapshot = await loadSnapshot();
  const raw = await loadRaw();
  const results = await readLines(PATHS.results);
  const qaRows = await readLines(PATHS.qa);
  if (results.length !== EXPECTED_ROWS || qaRows.length !== EXPECTED_ROWS) throw new Error('Report requires complete 861 result and QA rows');
  await writeFile(PATHS.report, buildReport(snapshot, raw, results, qaRows), 'utf8');
  return { raw: raw.length, results: results.length, qa: qaRows.length };
}

async function packageArtifacts() {
  const raw = await readFile(PATHS.raw);
  const reportBytes = await readFile(PATHS.report);
  await writeFile(PATHS.rawGz, deterministicGzip(raw));
  await writeFile(PATHS.reportGz, deterministicGzip(reportBytes));
  const files = {};
  for (const [name, path] of Object.entries({ snapshot: PATHS.snapshot, raw: PATHS.raw, results: PATHS.results, qa: PATHS.qa, report: PATHS.report, raw_gz: PATHS.rawGz, report_gz: PATHS.reportGz, progress: PATHS.progress, approval: PATHS.approval })) files[name] = { path: relative(ROOT, path).replaceAll('\\', '/'), sha256: await shaFile(path) };
  const results = await readLines(PATHS.results);
  const qaRows = await readLines(PATHS.qa);
  const snapshot = await loadSnapshot();
  const rawEvents = await loadRaw();
  const dataHash = await shaFile(PATHS.data);
  const progress = await loadProgress();
  const manifest = buildManifest({ files, counts: { total: results.length, verified: results.filter((row) => row.outcome === 'verified').length, conflicted: results.filter((row) => row.outcome === 'conflicted').length, unresolved: results.filter((row) => row.outcome === 'unresolved_after_complete_search').length, pending: results.filter((row) => row.outcome === 'pending').length, qa_passed: qaRows.filter((row) => row.qa_status === 'qa_passed').length, unreviewed: results.reduce((sum, row) => sum + Number(row.unreviewed_candidate_count ?? 0), 0) }, dataJsBefore: snapshot.data_source_sha256, dataJsAfter: dataHash, sourceVersions: { validator: await shaFile(join(ROOT, 'scripts/pouch-audit/recheck-v3-1-validator.mjs')), qa: await shaFile(join(ROOT, 'scripts/pouch-audit/recheck-v3-1-qa.mjs')), research: await shaFile(join(ROOT, 'scripts/pouch-audit/recheck-v3-1-research.mjs')) }, unavailableSources: ['Google direct search rate-limited during portions of the run; direct live evidence was not accepted without complete replacement transport.'], fallbacks: summarizeFallbacks(rawEvents), dataChanges: [], previousArtifacts: progress.pre_run_hashes ?? {} });
  await writeJson(PATHS.manifest, manifest);
  const summary = `# Pouch audit v3.1 summary\n\n- Total: ${results.length}\n- Verified: ${manifest.counts.verified}\n- Conflicted: ${manifest.counts.conflicted}\n- Unresolved: ${manifest.counts.unresolved}\n- Pending: ${manifest.counts.pending}\n- QA passed: ${manifest.counts.qa_passed}\n- Unreviewed: ${manifest.counts.unreviewed}\n`;
  await writeFile(PATHS.summary, summary, 'utf8');
  return manifest;
}

async function applySafe() {
  const snapshot = await loadSnapshot();
  const raw = await loadRaw();
  const results = await readLines(PATHS.results);
  const qaRows = await readLines(PATHS.qa);
  const validation = deriveResults(snapshot, raw);
  if (validation.rows.length !== EXPECTED_ROWS) throw new Error('Safe apply requires 861 fresh validation rows');
  const before = await readFile(PATHS.data, 'utf8');
  const applied = applyVerifiedChanges(before, { snapshot, results, qaRows, validator: validation });
  if (applied.changedRows.length) await writeFile(PATHS.data, applied.text, 'utf8');
  return { changedRows: applied.changedRows, data_js_before_sha256: sha256(before), data_js_after_sha256: sha256(applied.text) };
}

export function selectCommand(argv) {
  if (argv.includes('--freeze')) return 'freeze';
  if (argv.includes('--record-preapproval')) return 'approval';
  if (argv.includes('--run-all')) return 'run-all';
  if (argv.includes('--batch')) return 'batch';
  if (argv.includes('--validate')) return 'validate';
  if (argv.includes('--qa')) return 'qa';
  if (argv.includes('--report')) return 'report';
  if (argv.includes('--package')) return 'package';
  if (argv.includes('--apply-safe')) return 'apply-safe';
  if (argv.includes('--pilot')) return 'pilot';
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  await mkdir(AUDIT_DIR, { recursive: true });
  const command = selectCommand(argv);
  if (command === 'freeze') return freeze();
  if (command === 'pilot') return pilot();
  if (command === 'approval') return recordPreapproval();
  if (command === 'run-all') return runAll();
  if (command === 'batch') return runOneBatch(Number(argv[argv.indexOf('--limit') + 1] ?? 25));
  if (command === 'validate') return validateAndWrite(argv.includes('--pilot') ? pilotRows(await loadSnapshot()).map((row) => row.input_id) : null);
  if (command === 'qa') return qaAndWrite(argv.includes('--pilot') ? pilotRows(await loadSnapshot()).map((row) => row.input_id) : null);
  if (command === 'report') return report();
  if (command === 'package') return packageArtifacts();
  if (command === 'apply-safe') return applySafe();
  throw new Error('Use --freeze, --pilot, --record-preapproval, --batch, --run-all, --validate, --qa, --report, --package or --apply-safe');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((result) => { if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`); }).catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
}
