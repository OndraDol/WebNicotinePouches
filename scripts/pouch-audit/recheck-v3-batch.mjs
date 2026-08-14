export const MAX_BATCH_SIZE = 25;

function asIdSet(values, label) {
  const ids = [...(values instanceof Set ? values : values ?? [])];
  if (ids.some((id) => typeof id !== 'string' || id.length === 0)) throw new Error(`${label} contains an invalid input_id`);
  const set = new Set(ids);
  if (set.size !== ids.length) throw new Error(`${label} contains duplicate input_id values`);
  return set;
}

export function selectNextBatch(snapshotRows, processedInputIds, limit = MAX_BATCH_SIZE) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) throw new Error(`Batch limit must be an integer from 1 to ${MAX_BATCH_SIZE}`);
  if (!Array.isArray(snapshotRows)) throw new Error('Snapshot rows are required');
  const processed = asIdSet(processedInputIds, 'processed_input_ids');
  const remaining = snapshotRows.filter((row) => !processed.has(row.input_id));
  if (remaining.length === 0) return [];
  const brand = remaining[0].original?.b;
  if (typeof brand !== 'string' || brand.length === 0) throw new Error(`Next batch row ${remaining[0].input_id} has no brand`);
  return remaining.filter((row) => row.original?.b === brand).slice(0, limit);
}

export function reconcileActiveRawIds(processedInputIds, rawEventInputIds, activeBatchIds, frozenInputIds) {
  const processed = asIdSet(processedInputIds, 'processed_input_ids');
  const raw = asIdSet(rawEventInputIds, 'raw event input_ids');
  const active = asIdSet(activeBatchIds, 'active batch input_ids');
  const frozen = asIdSet(frozenInputIds, 'frozen input_ids');
  for (const id of raw) if (!frozen.has(id)) throw new Error(`Raw event input_id ${id} is outside the frozen snapshot`);
  const uncheckpointed = [...raw].filter((id) => !processed.has(id));
  if (uncheckpointed.some((id) => !active.has(id))) throw new Error('Raw event input_id is not in the active batch and cannot be checkpointed safely');
  return [...processed, ...uncheckpointed];
}

export function assertFreshBatchState({ expectedIds, validator, qaRows }) {
  const expected = asIdSet(expectedIds, 'expected batch IDs');
  if (!validator || validator.ok !== true) throw new Error('Batch validator did not pass');
  const summary = validator.summary ?? {};
  if (summary.total !== undefined && summary.total !== expected.size) throw new Error('Batch validator coverage does not match the batch state');
  if ((summary.pending ?? 0) !== 0 || (summary.unreviewed ?? 0) !== 0 || (summary.unreviewed_candidate_count ?? 0) !== 0) throw new Error('Batch validator still has pending or unreviewed rows');
  if (!Array.isArray(qaRows)) throw new Error('Batch QA rows are missing');
  const qaIds = asIdSet(qaRows.map((row) => row.input_id), 'batch QA rows');
  if (qaIds.size !== expected.size || [...expected].some((id) => !qaIds.has(id))) throw new Error('Batch QA coverage is incomplete');
  const failed = qaRows.filter((row) => row.qa_status !== 'qa_passed');
  if (failed.length > 0) throw new Error(`Batch QA failed for ${failed.length} row(s)`);
  return true;
}

export function assertGlobalCoverage(frozenIds, results, qaRows) {
  const expected = asIdSet(frozenIds, 'frozen input IDs');
  if (expected.size !== 861) throw new Error(`Global coverage requires exactly 861 frozen input IDs, found ${expected.size}`);
  if (!Array.isArray(results) || !Array.isArray(qaRows)) throw new Error('Global derived results and QA rows are required');
  const resultIds = asIdSet(results.map((row) => row.input_id), 'derived results');
  const qaIds = asIdSet(qaRows.map((row) => row.input_id), 'QA rows');
  if (resultIds.size !== expected.size || [...expected].some((id) => !resultIds.has(id))) throw new Error('Global coverage is missing derived results');
  if (qaIds.size !== expected.size || [...expected].some((id) => !qaIds.has(id))) throw new Error('Global coverage is missing QA rows');
  const pending = results.filter((row) => row.outcome === 'pending' || row.protocol_complete !== true);
  if (pending.length > 0) throw new Error(`Global coverage has ${pending.length} incomplete result(s)`);
  const failedQa = qaRows.filter((row) => row.qa_status !== 'qa_passed');
  if (failedQa.length > 0) throw new Error(`Global QA has ${failedQa.length} failed row(s)`);
  return true;
}
