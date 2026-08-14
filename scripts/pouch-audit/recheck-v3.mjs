#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256, readRawEvents } from './recheck-v3-schema.mjs';
import { freezeInputSnapshot } from './recheck-v3-freeze.mjs';
import { CATALOGS, researchOneInput, researchPilot } from './recheck-v3-research.mjs';
import { qaV3Set, writeQaRows } from './recheck-v3-qa.mjs';
import { validateV3Artifacts } from './recheck-v3-validator.mjs';
import { applySafeV3 } from './recheck-v3-apply.mjs';
import { assertFreshBatchState, assertGlobalCoverage, reconcileActiveRawIds, selectNextBatch } from './recheck-v3-batch.mjs';
import { repairRawEventLog } from './recheck-v3-repair.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const AUDIT_DIR = join(ROOT, 'audit', 'pouches', 'recheck-v3');
const PATHS = {
  inputPath: join(ROOT, 'audit', 'pouches', 'input.json'),
  unresolvedPath: join(ROOT, 'audit', 'pouches', 'unresolved-input.json'),
  dataPath: join(ROOT, 'data.js'),
  snapshotPath: join(AUDIT_DIR, 'input-snapshot.json'),
  rawEventsPath: join(AUDIT_DIR, 'raw-events.jsonl'),
  rawEventsIncidentPath: join(AUDIT_DIR, 'raw-events-corrupt-incident.jsonl'),
  rawRepairManifestPath: join(AUDIT_DIR, 'raw-events-repair-manifest.json'),
  derivedResultsPath: join(AUDIT_DIR, 'derived-results.jsonl'),
  qaPath: join(AUDIT_DIR, 'qa.jsonl'),
  reportPath: join(AUDIT_DIR, 'pilot-report.md'),
  progressPath: join(AUDIT_DIR, 'progress.json'),
  approvalPath: join(AUDIT_DIR, 'pilot-approval.json'),
};

const PILOT_BRAND = '77 Pouches';
const BATCH_SEARCH_SYSTEMS = [
  { id: 'bing', base: 'https://www.bing.com/search?q=' },
  { id: 'naver', base: 'https://search.naver.com/search.naver?query=' },
];
const BATCH_FALLBACK_SYSTEM = { id: 'naver', base: 'https://search.naver.com/search.naver?query=' };
const RESEARCH_INPUT_CONCURRENCY = 4;

async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function jsonl(path) {
  if (!existsSync(path)) return [];
  const content = await readFile(path, 'utf8');
  return content.trim() ? content.trim().split(/\r?\n/u).map((line) => JSON.parse(line)) : [];
}
async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
}
async function writeProgress(progress) {
  await mkdir(dirname(PATHS.progressPath), { recursive: true });
  await writeFile(PATHS.progressPath, `${JSON.stringify(progress, null, 2)}\n`, 'utf8');
}
async function snapshot() {
  if (!existsSync(PATHS.snapshotPath)) throw new Error('v3 snapshot is missing; run --freeze first');
  return json(PATHS.snapshotPath);
}
function pilotRows(snap) {
  const rows = snap.rows.filter((row) => row.original.b === PILOT_BRAND);
  if (rows.length !== 5) throw new Error(`Pilot requires exactly five ${PILOT_BRAND} rows, found ${rows.length}`);
  return rows;
}
function scopedSnapshot(snap, rows) { return { ...snap, rows, snapshot_sha256: null }; }
function printJson(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function runFreeze() {
  const before = sha256(await readFile(PATHS.dataPath, 'utf8'));
  const result = await freezeInputSnapshot({ ...PATHS, outputPath: PATHS.snapshotPath });
  const after = sha256(await readFile(PATHS.dataPath, 'utf8'));
  if (before !== after) throw new Error('freeze unexpectedly changed data.js');
  process.stdout.write(`${result.snapshot.rows.length}/861 input cards frozen; 77 Pouches: ${result.snapshot.rows.filter((row) => row.original.b === PILOT_BRAND).length}; data.js changed: no; snapshot: ${result.unchanged ? 'unchanged' : 'created'}\n`);
  return result;
}

async function runRepairRaw() {
  const snap = await snapshot();
  const result = await repairRawEventLog({ sourcePath: PATHS.rawEventsPath, targetPath: PATHS.rawEventsPath, incidentPath: PATHS.rawEventsIncidentPath, manifestPath: PATHS.rawRepairManifestPath, expectedInputIds: snap.rows.map((row) => row.input_id) });
  printJson(result.manifest);
  return result;
}

async function runPilot() {
  const snap = await snapshot();
  const rows = pilotRows(snap);
  if (existsSync(PATHS.progressPath)) {
    const progress = await json(PATHS.progressPath);
    const processed = new Set(progress.processed_input_ids ?? []);
    const pilotIds = rows.map((row) => row.input_id);
    const rawIds = new Set((await readRawEvents(PATHS.rawEventsPath)).map((event) => event.input_id));
    if (pilotIds.every((id) => processed.has(id)) && pilotIds.every((id) => rawIds.has(id))) {
      process.stdout.write('pilot already complete; raw event log unchanged\n');
      return progress;
    }
  }
  const result = await researchPilot({ snapshot: snap, outputPath: PATHS.rawEventsPath, progressPath: PATHS.progressPath });
  const events = await readRawEvents(PATHS.rawEventsPath);
  const ids = [...new Set(events.map((event) => event.input_id))];
  const expected = new Set(rows.map((row) => row.input_id));
  if (ids.some((id) => !expected.has(id)) || ids.length !== 5) throw new Error('Pilot raw events contain a non-pilot input ID');
  process.stdout.write(`pilot processed exactly ${result.processed_input_ids.length} 77 Pouches IDs; raw IDs: ${ids.length}\n`);
  return result;
}

async function runValidate(isPilot) {
  const snap = await snapshot();
  const rows = isPilot ? pilotRows(snap) : snap.rows;
  const result = await validateV3Artifacts({ snapshotPath: PATHS.snapshotPath, rawEventsPath: PATHS.rawEventsPath, derivedResultsPath: PATHS.derivedResultsPath }, { inputIds: isPilot ? rows.map((row) => row.input_id) : undefined });
  printJson(result.summary);
  if (!result.ok) process.exitCode = 1;
  return result;
}

async function runQa(isPilot) {
  const snap = await snapshot();
  const rows = isPilot ? pilotRows(snap) : snap.rows;
  const selected = scopedSnapshot(snap, rows);
  const events = await readRawEvents(PATHS.rawEventsPath);
  const derived = await jsonl(PATHS.derivedResultsPath);
  const scopedEvents = events.filter((event) => rows.some((row) => row.input_id === event.input_id));
  const scopedDerived = derived.filter((row) => rows.some((input) => input.input_id === row.input_id));
  const result = qaV3Set(selected, scopedEvents, scopedDerived);
  await writeQaRows(PATHS.qaPath, result.rows);
  printJson(result.summary);
  if (!result.ok) process.exitCode = 1;
  return result;
}

function mdJson(value) { return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`; }

async function runReport(isPilot) {
  const snap = await snapshot();
  const rows = isPilot ? pilotRows(snap) : snap.rows;
  const events = await readRawEvents(PATHS.rawEventsPath);
  const derived = await jsonl(PATHS.derivedResultsPath);
  const qa = await jsonl(PATHS.qaPath);
  const sections = [`# Pouch audit v3 ${isPilot ? 'pilot' : 'report'}`, '', `Snapshot SHA-256: \`${snap.snapshot_sha256}\``, '', '## Counts', '', mdJson({ total: rows.length, verified: derived.filter((row) => row.outcome === 'verified').length, conflicted: derived.filter((row) => row.outcome === 'conflicted').length, unresolved_after_complete_search: derived.filter((row) => row.outcome === 'unresolved_after_complete_search').length, pending: derived.filter((row) => row.outcome === 'pending').length }), ''];
  for (const row of rows) {
    const rowEvents = events.filter((event) => event.input_id === row.input_id);
    const rowDerived = derived.find((item) => item.input_id === row.input_id) ?? null;
    const rowQa = qa.find((item) => item.input_id === row.input_id) ?? null;
    sections.push(`## ${row.input_id}: ${row.original.b} — ${row.original.n}`, '', '### Frozen input card', mdJson(row), '### Raw queries and transport', mdJson(rowEvents.filter((event) => ['search_attempt', 'owner_lookup', 'catalog_lookup', 'transport_event'].includes(event.event_type))), '### Candidates, opened URLs, and decisions', mdJson(rowEvents.filter((event) => ['url_opened', 'candidate_decision'].includes(event.event_type))), '### Derived result', mdJson(rowDerived), '### QA hashes and status', mdJson(rowQa), '');
  }
  await mkdir(dirname(PATHS.reportPath), { recursive: true });
  await writeFile(PATHS.reportPath, `${sections.join('\n')}\n`, 'utf8');
  process.stdout.write(`report written: ${PATHS.reportPath}\n`);
  return PATHS.reportPath;
}

async function runApprovePilot() {
  const snap = await snapshot();
  const rows = pilotRows(snap);
  const events = await readRawEvents(PATHS.rawEventsPath);
  const validator = await validateV3Artifacts({ snapshotPath: PATHS.snapshotPath, rawEventsPath: PATHS.rawEventsPath, derivedResultsPath: PATHS.derivedResultsPath }, { inputIds: rows.map((row) => row.input_id) });
  const qa = await runQa(true);
  if (!validator.ok || !qa.ok) throw new Error('Pilot approval requires a passed validator and independent QA');
  const validatorSourceSha256 = sha256(await readFile(new URL('./recheck-v3-validator.mjs', import.meta.url), 'utf8'));
  const approval = { schema: 3, snapshot_sha256: snap.snapshot_sha256, validator_source_sha256: validatorSourceSha256, approved_input_ids: rows.map((row) => row.input_id), approved_at: new Date().toISOString(), approval_basis: 'explicit user approval' };
  await writeFile(PATHS.approvalPath, `${JSON.stringify(approval, null, 2)}\n`, 'utf8');
  printJson(approval);
  return approval;
}

async function validateAndQaForIds(snap, inputIds) {
  const rows = snap.rows.filter((row) => inputIds.includes(row.input_id));
  if (rows.length !== inputIds.length) throw new Error('Requested validation scope is not contained in the frozen snapshot');
  const validator = await validateV3Artifacts({ snapshotPath: PATHS.snapshotPath, rawEventsPath: PATHS.rawEventsPath, derivedResultsPath: PATHS.derivedResultsPath }, { inputIds });
  const events = await readRawEvents(PATHS.rawEventsPath);
  const derived = await jsonl(PATHS.derivedResultsPath);
  const selected = scopedSnapshot(snap, rows);
  const scopedEvents = events.filter((event) => inputIds.includes(event.input_id));
  const scopedDerived = derived.filter((row) => inputIds.includes(row.input_id));
  const qa = qaV3Set(selected, scopedEvents, scopedDerived);
  await writeQaRows(PATHS.qaPath, qa.rows);
  return { validator, qa, rows, events, derived: scopedDerived };
}

async function runBatch(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('Batch limit must be an integer from 1 to 25');
  if (!existsSync(PATHS.approvalPath)) throw new Error('Batch processing requires explicit pilot approval');
  const snap = await snapshot();
  const approval = await json(PATHS.approvalPath);
  const validatorHash = sha256(await readFile(new URL('./recheck-v3-validator.mjs', import.meta.url), 'utf8'));
  if (approval.validator_source_sha256 !== validatorHash) throw new Error('Pilot approval is invalid because the validator hash changed; run a new pilot');
  if (approval.snapshot_sha256 !== snap.snapshot_sha256) throw new Error('Pilot approval is invalid because the frozen snapshot hash changed');
  const pilotIds = pilotRows(snap).map((row) => row.input_id);
  if (JSON.stringify(approval.approved_input_ids) !== JSON.stringify(pilotIds)) throw new Error('Pilot approval does not contain exactly the five frozen pilot IDs');

  let progress = existsSync(PATHS.progressPath) ? await json(PATHS.progressPath) : null;
  if (!progress || progress.snapshot_sha256 !== snap.snapshot_sha256) throw new Error('Batch progress is missing or bound to a different snapshot');
  const frozenIds = snap.rows.map((row) => row.input_id);
  const frozenSet = new Set(frozenIds);
  let processedIds = [...new Set(progress.processed_input_ids ?? [])];
  if (processedIds.some((id) => !frozenSet.has(id))) throw new Error('Batch progress contains an input_id outside the frozen snapshot');
  const activeBatchIds = progress.active_batch?.input_ids ?? [];
  const rawEventIds = [...new Set((await readRawEvents(PATHS.rawEventsPath)).map((event) => event.input_id))];
  const reconciledIds = reconcileActiveRawIds(processedIds, rawEventIds, activeBatchIds, frozenIds);
  if (reconciledIds.length !== processedIds.length) {
    processedIds = reconciledIds;
    await writeProgress({ ...progress, processed_input_ids: processedIds });
  }
  if (pilotIds.some((id) => !processedIds.includes(id))) throw new Error('The five pilot IDs must be complete before batch processing');

  let prior = await validateAndQaForIds(snap, processedIds);
  if (!prior.validator.ok) {
    const activeIds = new Set(progress.active_batch?.input_ids ?? []);
    const recoverableRows = prior.validator.rows.filter((row) => activeIds.has(row.input_id)
      && row.outcome === 'pending'
      && (row.unreviewed_candidate_count > 0
        || row.errors.some((error) => /two independent successful search systems|owner-specific successful attempts/iu.test(error))));
    if (recoverableRows.length === 0) throw new Error('Batch validator did not pass');
    process.stdout.write(`recovering ${recoverableRows.length} active row(s) with the Naver fallback search system\n`);
    for (const row of snap.rows.filter((candidate) => recoverableRows.some((item) => item.input_id === candidate.input_id))) {
      await researchOneInput(row, { outputPath: PATHS.rawEventsPath, searchSystems: [BATCH_FALLBACK_SYSTEM], catalogs: [] });
    }
    prior = await validateAndQaForIds(snap, processedIds);
  }
  assertFreshBatchState({ expectedIds: processedIds, validator: prior.validator, qaRows: prior.qa.rows });

  let completedBatches = progress.completed_batches ?? [];
  if (progress.active_batch?.input_ids?.every((id) => processedIds.includes(id))) {
    completedBatches = [...completedBatches, {
      batch_number: progress.active_batch.batch_number,
      brand: progress.active_batch.brand,
      input_ids: progress.active_batch.input_ids,
      validator_summary: prior.validator.summary,
      qa_summary: prior.qa.summary,
    }];
    progress = { schema: 3, mode: 'batch', processed_input_ids: processedIds, expected_input_ids: frozenIds, snapshot_sha256: snap.snapshot_sha256, completed_batches: completedBatches };
    await writeProgress(progress);
  }

  const batchRows = selectNextBatch(snap.rows, new Set(processedIds), limit);
  if (batchRows.length === 0) {
    if (processedIds.length !== frozenIds.length) throw new Error(`No next same-brand batch found but only ${processedIds.length}/${frozenIds.length} IDs are processed`);
    process.stdout.write(`all ${frozenIds.length} frozen IDs already processed; no raw events appended\n`);
    return { complete: true, processed_input_ids: processedIds };
  }

  const batchNumber = completedBatches.length + 1;
  const batchIds = batchRows.map((row) => row.input_id);
  process.stdout.write(`starting batch ${batchNumber}: ${batchRows.length} ${batchRows[0].original.b} rows\n`);
  const activeProgress = {
    schema: 3,
    mode: 'batch',
    processed_input_ids: processedIds,
    expected_input_ids: frozenIds,
    snapshot_sha256: snap.snapshot_sha256,
    active_batch: { batch_number: batchNumber, brand: batchRows[0].original.b, input_ids: batchIds },
    completed_batches: completedBatches,
  };
  await writeProgress(activeProgress);
  const researchResults = [];
  for (let offset = 0; offset < batchRows.length; offset += RESEARCH_INPUT_CONCURRENCY) {
    const chunk = batchRows.slice(offset, offset + RESEARCH_INPUT_CONCURRENCY);
    const chunkResults = await Promise.allSettled(chunk.map((row) => researchOneInput(row, { outputPath: PATHS.rawEventsPath, searchSystems: BATCH_SEARCH_SYSTEMS, catalogs: CATALOGS })));
    researchResults.push(...chunkResults);
    if (chunkResults.some((result) => result.status === 'rejected')) break;
  }
  const researchFailure = researchResults.find((result) => result.status === 'rejected');
  if (researchFailure) throw researchFailure.reason;
  processedIds.push(...batchIds);
  await writeProgress({ ...activeProgress, processed_input_ids: processedIds });

  const current = await validateAndQaForIds(snap, processedIds);
  assertFreshBatchState({ expectedIds: processedIds, validator: current.validator, qaRows: current.qa.rows });
  completedBatches = [...completedBatches, {
    batch_number: batchNumber,
    brand: batchRows[0].original.b,
    input_ids: batchIds,
    validator_summary: current.validator.summary,
    qa_summary: current.qa.summary,
  }];
  await writeProgress({
    schema: 3,
    mode: 'batch',
    processed_input_ids: processedIds,
    expected_input_ids: frozenIds,
    snapshot_sha256: snap.snapshot_sha256,
    completed_batches: completedBatches,
  });
  printJson({ batch_number: batchNumber, brand: batchRows[0].original.b, processed: processedIds.length, remaining: frozenIds.length - processedIds.length, validator: current.validator.summary, qa: current.qa.summary });
  return current;
}

async function runApplySafe() {
  if (!existsSync(PATHS.approvalPath)) throw new Error('Safe application requires explicit pilot approval and global validation');
  const snap = await snapshot();
  const results = await jsonl(PATHS.derivedResultsPath);
  const qa = await jsonl(PATHS.qaPath);
  const source = await readFile(PATHS.dataPath, 'utf8');
  assertGlobalCoverage(snap.rows.map((row) => row.input_id), results, qa);
  const applied = applySafeV3({ results, qa, dataSource: source, expectedCount: snap.rows.length, requireHashes: true });
  if (applied.changed) await writeFile(PATHS.dataPath, applied.source, 'utf8');
  process.stdout.write(`safe application changed data.js: ${applied.changed ? 'yes' : 'no'}\n`);
  return applied;
}

async function main(argv) {
  const isPilot = argv.includes('--pilot');
  if (argv.includes('--freeze')) return runFreeze();
  if (argv.includes('--repair-raw')) return runRepairRaw();
  if (argv.includes('--pilot') && !argv.includes('--validate') && !argv.includes('--qa') && !argv.includes('--report')) return runPilot();
  if (argv.includes('--validate')) return runValidate(isPilot);
  if (argv.includes('--qa')) return runQa(isPilot);
  if (argv.includes('--report')) return runReport(isPilot);
  if (argv.includes('--approve-pilot')) return runApprovePilot();
  if (argv.includes('--batch')) {
    const index = argv.indexOf('--limit');
    return runBatch(index >= 0 ? Number(argv[index + 1]) : NaN);
  }
  if (argv.includes('--apply-safe')) return runApplySafe();
  throw new Error('Usage: --freeze | --repair-raw | --pilot | --validate [--pilot] | --qa [--pilot] | --report [--pilot] | --approve-pilot | --batch --limit N | --apply-safe');
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

export { PATHS, main, runReport };
