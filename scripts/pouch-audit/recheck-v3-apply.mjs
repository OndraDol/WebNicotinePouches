import { hashInputCard } from './recheck-v3-schema.mjs';

function quote(value) {
  return JSON.stringify(String(value));
}

function validateGlobalGate({ results, qa, expectedCount }) {
  if (!Array.isArray(results) || results.length !== expectedCount) throw new Error(`Safe application requires ${expectedCount} validated results`);
  if (new Set(results.map((row) => row.input_id)).size !== expectedCount) throw new Error('Safe application requires unique input IDs');
  if (!Array.isArray(qa) || qa.length !== expectedCount || new Set(qa.map((row) => row.input_id)).size !== expectedCount) throw new Error('Safe application requires one QA row per input ID');
  if (results.some((row) => ['pending', 'incomplete'].includes(row.outcome) || row.protocol_complete !== undefined && row.protocol_complete !== true || Number(row.unreviewed_candidate_count ?? 0) !== 0)) throw new Error('Safe application refuses pending/incomplete or unreviewed results');
  if (qa.some((row) => row.qa_status !== 'qa_passed')) throw new Error('Safe application refuses failed QA');
}

export function applySafeV3({ results, qa, dataSource, expectedCount = 861, requireHashes = false }) {
  validateGlobalGate({ results, qa, expectedCount });
  const qaById = new Map(qa.map((row) => [row.input_id, row]));
  if (requireHashes) {
    for (const result of results) {
      const qaRow = qaById.get(result.input_id);
      if (!result.input_card_sha256 || !qaRow.input_card_sha256 || qaRow.input_card_sha256 !== result.input_card_sha256 || !qaRow.raw_events_sha256 || !qaRow.derived_result_sha256) throw new Error(`Safe application requires hash-bound QA for ${result.input_id}`);
      if (result.input_card_sha256 !== hashInputCard(result)) throw new Error(`Safe application input hash mismatch for ${result.input_id}`);
    }
  }
  let source = String(dataSource ?? '');
  let changed = false;
  for (const result of results) {
    if (result.outcome !== 'verified') continue;
    const original = result.original;
    const evidence = (result.verified_sources ?? []).find((item) => Number.isFinite(Number(item.strength_mg_per_pouch)));
    if (!original || !evidence) continue;
    const nextMg = Number(evidence.strength_mg_per_pouch);
    if (nextMg === Number(original.mg)) continue;
    const rowPattern = new RegExp(`(\\{\\s*b:\\s*${escapeRegExp(quote(original.b))},\\s*n:\\s*${escapeRegExp(quote(original.n))},\\s*mg:\\s*)${escapeRegExp(String(original.mg))}(\\s*\\})`, 'u');
    const replaced = source.replace(rowPattern, `$1${String(nextMg)}$2`);
    if (replaced === source) throw new Error(`Safe application could not locate an exact row for ${result.input_id}`);
    source = replaced;
    changed = true;
  }
  return { source, changed };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
