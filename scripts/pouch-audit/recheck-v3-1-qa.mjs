import { hashInputCard, sha256, verifyEventChain } from './recheck-v3-schema.mjs';
import { compareProductIdentity } from './recheck-v3-1-identity.mjs';
import { sourceForUrl } from './recheck-v3-1-sources.mjs';

function strength(extracted = {}) {
  const claims = Array.isArray(extracted.strength_claims) ? extracted.strength_claims : [];
  const direct = claims.find((claim) => claim?.basis === 'per_pouch' && Number.isFinite(Number(claim.value)));
  if (direct) return Number(direct.value);
  const perG = claims.find((claim) => claim?.basis === 'per_g' && Number.isFinite(Number(claim.value)));
  const weight = Number(extracted.net_weight_g);
  const count = Number(extracted.pouch_count);
  if (!perG || !Number.isFinite(weight) || !Number.isInteger(count) || weight <= 0 || count <= 0) return null;
  return Number(perG.value) * weight / count;
}

function exactFacts(row, events) {
  const decisions = new Map(events.filter((event) => event.event_type === 'candidate_decision').map((event) => [event.payload?.candidate_url, event.payload]));
  const exact = [];
  for (const event of events.filter((item) => item.event_type === 'url_opened')) {
    const url = event.payload?.final_url ?? event.payload?.requested_url ?? event.payload?.candidate_url;
    const extracted = event.payload?.extracted ?? {};
    const identity = compareProductIdentity(row.original, extracted);
    const value = strength(extracted);
    const decision = decisions.get(event.payload?.candidate_url ?? url);
    const source = sourceForUrl(url);
    if (identity.identity_match === 'exact' && event.payload?.page_kind === 'product_detail' && event.payload?.parse_status === 'parsed'
      && Number(event.payload?.status) >= 200 && Number(event.payload?.status) < 300 && Number.isFinite(value)
      && decision?.match_decision === 'exact_match' && source.source_class !== 'unknown') {
      exact.push({ url, source, value });
    }
  }
  return exact;
}

export function qaInput(snapshotRow, events = [], derived, { skipChain = false } = {}) {
  const errors = [];
  const rowHash = hashInputCard(snapshotRow);
  if (snapshotRow.input_card_sha256 && snapshotRow.input_card_sha256 !== rowHash) errors.push('input card hash mismatch');
  if (!skipChain) {
    const chainErrors = verifyEventChain(events, new Set([snapshotRow.input_id]));
    if (chainErrors.length) errors.push(...chainErrors.map((error) => `raw chain: ${error}`));
  }
  const exact = exactFacts(snapshotRow, events);
  const groups = new Set(exact.map((item) => item.source.owner_group_id ?? `unknown:${item.source.host}`));
  const trusted = exact.some((item) => ['official', 'regulator'].includes(item.source.source_class));
  const storedOutcome = derived?.outcome;
  if (storedOutcome === 'verified' && !(exact.length > 0 && (trusted || groups.size >= 2))) errors.push('verified result lacks exact/source/strength evidence');
  if (storedOutcome === 'verified' && [...new Set(exact.map((item) => item.value))].length > 1 && groups.size > 1) errors.push('verified result has conflicting strength evidence');
  if (storedOutcome === 'verified' && Number(derived?.unreviewed_candidate_count ?? 0) !== 0) errors.push('verified result has unreviewed candidates');
  const rawHash = sha256(events);
  const derivedHash = sha256(derived);
  return {
    input_id: snapshotRow.input_id,
    input_card_sha256: rowHash,
    raw_events_sha256: rawHash,
    derived_result_sha256: derivedHash,
    qa_status: errors.length ? 'qa_failed' : 'qa_passed',
    errors,
  };
}

export function qaAll(snapshot, events, derivedRows) {
  const globalChainErrors = verifyEventChain(events, new Set(snapshot.rows.map((row) => row.input_id)));
  const byId = new Map(derivedRows.map((row) => [row.input_id, row]));
  const rows = snapshot.rows.map((row) => {
    const qa = qaInput(row, events.filter((event) => event.input_id === row.input_id), byId.get(row.input_id), { skipChain: true });
    if (globalChainErrors.length) return { ...qa, qa_status: 'qa_failed', errors: [...qa.errors, ...globalChainErrors.map((error) => `raw chain: ${error}`)] };
    return qa;
  });
  return { rows, passed: rows.filter((row) => row.qa_status === 'qa_passed').length, failed: rows.filter((row) => row.qa_status !== 'qa_passed').length };
}
