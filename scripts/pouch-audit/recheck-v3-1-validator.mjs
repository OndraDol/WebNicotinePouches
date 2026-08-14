import { hashInputCard, hashSnapshot, sha256, verifyEventChain } from './recheck-v3-schema.mjs';
import { compareProductIdentity } from './recheck-v3-1-identity.mjs';
import { SOURCE_REGISTRY, sourceForUrl } from './recheck-v3-1-sources.mjs';

const SUCCESS_SEARCH = (event) => event?.event_type === 'search_attempt'
  && Number.isInteger(event.payload?.status) && event.payload.status >= 200 && event.payload.status < 300
  && event.payload.parse_status === 'parsed' && event.payload.cache_hit !== true;
const SUCCESS_OWNER = (event) => event?.event_type === 'owner_lookup'
  && Number.isInteger(event.payload?.status) && event.payload.status >= 200 && event.payload.status < 300
  && event.payload.parse_status === 'parsed' && event.payload.cache_hit !== true;

const DETERMINISTIC_REJECTIONS = new Set(['non_http_url', 'obvious_search_or_social_domain', 'malformed_candidate_url', 'non_product_document_or_forum', 'robots_disallowed_non_product']);

function urlKey(value) {
  try { return new URL(value).toString(); } catch { return null; }
}

export function materialQueryKey(query) {
  return [...new Set(String(query ?? '').normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/\b(?:continuation|page)\s*\d+\b/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/u).filter(Boolean))].sort().join(' ');
}

function candidateUrls(event) {
  const values = event.payload?.candidate_urls ?? event.payload?.candidate_urls_found ?? [];
  return Array.isArray(values) ? values.map((value) => typeof value === 'string' ? value : value?.url).map(urlKey).filter(Boolean) : [];
}

function openedUrls(event) {
  return [event.payload?.candidate_url, event.payload?.requested_url, event.payload?.final_url ?? event.payload?.url]
    .map(urlKey).filter(Boolean);
}

function decisionUrl(event) {
  return urlKey(event.payload?.candidate_url ?? event.payload?.final_url ?? event.payload?.url);
}

export function deriveStrength(extracted = {}) {
  const claims = Array.isArray(extracted.strength_claims) ? extracted.strength_claims : [];
  const direct = claims.find((claim) => claim?.basis === 'per_pouch' && Number.isFinite(Number(claim.value)));
  if (direct) return { value: Number(direct.value), calculation: 'direct_mg_per_pouch', inputs: [direct] };
  const perG = claims.find((claim) => claim?.basis === 'per_g' && Number.isFinite(Number(claim.value)));
  const weight = Number(extracted.net_weight_g);
  const count = Number(extracted.pouch_count);
  if (!perG || !Number.isFinite(weight) || !Number.isInteger(count) || weight <= 0 || count <= 0) return { value: null, calculation: null, inputs: [] };
  const value = Number(perG.value) * weight / count;
  return { value, calculation: 'mg_per_g_x_net_weight_div_pouches', inputs: [perG, { net_weight_g: weight }, { pouch_count: count }] };
}

function accountCandidates(events, errors) {
  const candidates = new Map();
  for (const event of events.filter(SUCCESS_SEARCH)) for (const url of candidateUrls(event)) candidates.set(url, { url });
  const opened = new Map();
  for (const event of events.filter((item) => item.event_type === 'url_opened')) for (const url of openedUrls(event)) opened.set(url, event);
  const decisions = new Map();
  for (const event of events.filter((item) => item.event_type === 'candidate_decision')) {
    const url = decisionUrl(event);
    if (!url) continue;
    decisions.set(url, event);
    for (const related of opened.get(url) ? openedUrls(opened.get(url)) : []) decisions.set(related, event);
  }
  let unreviewed = 0;
  const records = [];
  for (const item of candidates.values()) {
    const open = opened.get(item.url);
    const decision = decisions.get(item.url);
    const rejected = DETERMINISTIC_REJECTIONS.has(decision?.payload?.rejection_rule);
    if (!open && !rejected) unreviewed += 1;
    if (open && !decision) unreviewed += 1;
    records.push({ ...item, opened: Boolean(open), decided: Boolean(decision), openedEvent: open, decisionEvent: decision });
  }
  for (const event of events.filter((item) => item.event_type === 'candidate_decision')) {
    const url = decisionUrl(event);
    if (url && !candidates.has(url) && event.payload?.match_decision === 'exact_match') errors.push(`Candidate decision has no discovered candidate: ${url}`);
  }
  return { records, opened, decisions, unreviewed };
}

function deriveEvidence(row, records, errors, sourceRegistry) {
  const exact = [];
  const aligned = [];
  for (const record of records) {
    const open = record.openedEvent;
    const decision = record.decisionEvent;
    if (!open || !decision) continue;
    const url = urlKey(open.payload?.final_url ?? open.payload?.requested_url ?? open.payload?.candidate_url);
    const source = sourceForUrl(url, sourceRegistry);
    const extracted = open.payload?.extracted ?? {};
    const identity = compareProductIdentity(row.original, extracted);
    const strength = deriveStrength(extracted);
    if (identity.identity_match === 'exact' && open.payload?.page_kind === 'product_detail'
      && Number(open.payload?.status) >= 200 && Number(open.payload?.status) < 300
      && open.payload?.parse_status === 'parsed' && Number.isFinite(strength.value)) {
      const item = { url, source, identity, extracted, strength_mg_per_pouch: strength.value, calculation: strength.calculation, writer_match_decision: decision.payload?.match_decision ?? null };
      exact.push(item);
      if (decision.payload?.match_decision === 'exact_match') aligned.push(item);
    }
  }
  const branches = new Map();
  for (const item of aligned) {
    const key = item.source.owner_group_id ?? `unknown:${item.source.host}`;
    if (!branches.has(key)) branches.set(key, item);
  }
  const values = [...new Set(aligned.map((item) => item.strength_mg_per_pouch))];
  const conflicts = values.length > 1 && branches.size > 1 ? aligned.map((item) => ({ url: item.url, owner_group_id: item.source.owner_group_id, strength_mg_per_pouch: item.strength_mg_per_pouch })) : [];
  if (exact.some((item) => item.source.source_class === 'unknown')) errors.push('Unknown source cannot support exact evidence');
  const trustedSingle = [...branches.values()].some((item) => ['official', 'regulator'].includes(item.source.source_class));
  const verified = !conflicts.length && aligned.length > 0 && (trustedSingle || branches.size >= 2);
  return { exact, aligned, branches: [...branches.values()], conflicts, verified };
}

export function deriveInputResult(row, events, { sourceRegistry = SOURCE_REGISTRY } = {}) {
  const errors = [];
  const successfulSearches = events.filter(SUCCESS_SEARCH);
  const systems = new Set(successfulSearches.map((event) => event.payload.system).filter(Boolean));
  if (systems.size < 2) errors.push('Two independent successful search systems are required');
  const queryKeys = new Set(successfulSearches.map((event) => materialQueryKey(event.payload.query)).filter(Boolean));
  if (queryKeys.size < 2) errors.push('Two materially distinct successful queries are required');
  const seen = new Set();
  let noNew = 0;
  for (const event of successfulSearches) {
    const urls = candidateUrls(event);
    if (!urls.some((url) => !seen.has(url))) noNew += 1;
    urls.forEach((url) => seen.add(url));
  }
  const saturation = systems.size >= 2 && queryKeys.size >= 2 && noNew >= 2;
  if (!saturation) errors.push('Saturation is not evidenced by materially distinct successful no-new queries');
  const ownerEvents = events.filter(SUCCESS_OWNER);
  const ownerSystems = new Set(ownerEvents.map((event) => event.payload.system).filter(Boolean));
  if (ownerSystems.size < systems.size) errors.push('Owner-specific successful attempts are required in both used search systems');
  const ownerResolution = ownerEvents.some((event) => typeof event.payload.owner === 'string' && event.payload.owner.trim()) ? 'identified' : 'not_identified';
  const accounting = accountCandidates(events, errors);
  if (accounting.unreviewed > 0) errors.push(`Unreviewed candidates: ${accounting.unreviewed}`);
  const evidence = deriveEvidence(row, accounting.records, errors, sourceRegistry);
  const protocolComplete = errors.length === 0;
  let outcome = 'pending';
  if (protocolComplete) outcome = evidence.conflicts.length ? 'conflicted' : evidence.verified ? 'verified' : 'unresolved_after_complete_search';
  return {
    input_id: row.input_id,
    original_index: row.original_index,
    original: row.original,
    input_card_sha256: row.input_card_sha256 ?? hashInputCard(row),
    protocol_complete: protocolComplete,
    saturation,
    owner_resolution: ownerResolution,
    unreviewed_candidate_count: accounting.unreviewed,
    verified_sources: evidence.branches,
    conflicts: evidence.conflicts,
    candidate_records: accounting.records.map((item) => ({ url: item.url, opened: item.opened, decided: item.decided, decision: item.decisionEvent?.payload?.match_decision ?? null, reason: item.decisionEvent?.payload?.reason ?? item.decisionEvent?.payload?.rejection_rule ?? null })),
    gates: { successful_search_systems: [...systems], material_query_keys: [...queryKeys], owner_systems: [...ownerSystems], candidate_count: accounting.records.length, exact_evidence_count: evidence.exact.length },
    outcome,
    errors,
  };
}

export function deriveResults(snapshot, events, options = {}) {
  const errors = [];
  if (!snapshot || !Array.isArray(snapshot.rows)) errors.push('Invalid v3.1 input snapshot');
  const rows = snapshot?.rows ?? [];
  if (snapshot?.snapshot_sha256 && snapshot.snapshot_sha256 !== hashSnapshot(snapshot)) errors.push('Input snapshot hash mismatch');
  const expectedIds = new Set(rows.map((row) => row.input_id));
  if (events?.length && !options.skipChain) errors.push(...verifyEventChain(events, expectedIds));
  const derivedRows = rows.map((row) => deriveInputResult(row, events.filter((event) => event.input_id === row.input_id), options));
  for (const row of derivedRows) for (const error of row.errors) errors.push(`${row.input_id}: ${error}`);
  const summary = {
    total: derivedRows.length,
    verified: derivedRows.filter((row) => row.outcome === 'verified').length,
    conflicted: derivedRows.filter((row) => row.outcome === 'conflicted').length,
    unresolved: derivedRows.filter((row) => row.outcome === 'unresolved_after_complete_search').length,
    pending: derivedRows.filter((row) => row.outcome === 'pending').length,
    unreviewed: derivedRows.reduce((sum, row) => sum + row.unreviewed_candidate_count, 0),
  };
  return { ok: errors.length === 0 && summary.pending === 0 && summary.unreviewed === 0, errors, rows: derivedRows, summary };
}

export { SUCCESS_SEARCH, SUCCESS_OWNER };
