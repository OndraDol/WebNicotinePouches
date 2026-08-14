import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  SOURCE_REGISTRY,
  hashInputCard,
  hashSnapshot,
  readRawEvents,
  sourceForUrl,
  verifyEventChain,
} from './recheck-v3-schema.mjs';

const SUCCESS_STATUS = (event) => event.event_type === 'search_attempt'
  && Number.isInteger(event.payload?.status)
  && event.payload.status >= 200
  && event.payload.status < 300
  && event.payload.parse_status === 'parsed'
  && event.payload.cache_hit !== true;

const SUCCESS_OWNER_STATUS = (event) => event.event_type === 'owner_lookup'
  && Number.isInteger(event.payload?.status)
  && event.payload.status >= 200
  && event.payload.status < 300
  && event.payload.parse_status === 'parsed'
  && event.payload.cache_hit !== true;

const DETERMINISTIC_REJECTION_RULES = new Set([
  'non_http_url',
  'obvious_search_or_social_domain',
  'robots_disallowed_non_product',
  'malformed_candidate_url',
  'non_product_document_or_forum',
]);

function normalize(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/gu, ' ');
}

function urlKey(url) {
  try { return new URL(url).toString(); } catch { return null; }
}

function candidateUrls(event) {
  const values = event.payload?.candidate_urls ?? event.payload?.candidates ?? [];
  if (!Array.isArray(values)) return [];
  return values.map((value) => typeof value === 'string' ? value : value?.url).filter(Boolean).map(urlKey).filter(Boolean);
}

function eventUrl(event) {
  return urlKey(event.payload?.final_url ?? event.payload?.requested_url ?? event.payload?.url);
}

function openedUrls(event) {
  return [
    event.payload?.candidate_url,
    event.payload?.requested_url,
    event.payload?.final_url ?? event.payload?.url,
  ].map(urlKey).filter(Boolean);
}

function decisionUrl(event) {
  return urlKey(event.payload?.candidate_url ?? event.payload?.final_url ?? event.payload?.url);
}

export function materialQueryKey(query) {
  const cleaned = String(query ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\b(?:exact\s+)?continuation\s*\d+\b/gu, ' ')
    .replace(/\bpage\s*\d+\b/gu, ' ')
    .replace(/["'“”‘’]/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  return [...new Set(cleaned.split(/\s+/u).filter(Boolean))].sort().join(' ');
}

export function materiallyDistinct(left, right) {
  return materialQueryKey(left) !== materialQueryKey(right);
}

function exactStrength(extracted) {
  if (Number.isFinite(Number(extracted?.strength_mg_per_pouch))) return { value: Number(extracted.strength_mg_per_pouch), calculation: null };
  if (Number.isFinite(Number(extracted?.mg_per_g))
    && Number.isFinite(Number(extracted?.net_weight_g))
    && Number.isFinite(Number(extracted?.pouch_count))
    && Number(extracted.pouch_count) > 0) {
    const value = Number(extracted.mg_per_g) * Number(extracted.net_weight_g) / Number(extracted.pouch_count);
    return { value, calculation: { expression: 'mg_per_g * net_weight_g / pouch_count', result: value } };
  }
  return { value: null, calculation: null };
}

function successfulCatalog(event) {
  const payload = event.payload ?? {};
  return event.event_type === 'catalog_lookup'
    && typeof (payload.lookup_key ?? payload.item_specific_lookup_key) === 'string'
    && (payload.result === 'found' || payload.result === 'no_match')
    && typeof payload.snapshot_sha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(payload.snapshot_sha256)
    && (Array.isArray(payload.candidate_urls) || payload.result === 'no_match');
}

function deriveCandidateAccounting(events, errors) {
  const candidates = new Map();
  for (const event of events) {
    if (SUCCESS_STATUS(event) || successfulCatalog(event)) {
      for (const url of candidateUrls(event)) candidates.set(url, { url, sources: [...(candidates.get(url)?.sources ?? []), event.event_type] });
    }
  }
  const opened = new Map();
  for (const event of events.filter((item) => item.event_type === 'url_opened')) {
    for (const url of openedUrls(event)) opened.set(url, event);
  }
  const decisions = new Map();
  for (const event of events.filter((item) => item.event_type === 'candidate_decision')) {
    const url = decisionUrl(event);
    if (url) {
      decisions.set(url, event);
      const openedEvent = opened.get(url);
      for (const relatedUrl of openedEvent ? openedUrls(openedEvent) : []) decisions.set(relatedUrl, event);
    }
  }
  let unreviewed = 0;
  const candidateRecords = [];
  for (const [url] of candidates) {
    const open = opened.get(url);
    const decision = decisions.get(url);
    const rejectionRule = decision?.payload?.rejection_rule;
    const deterministicallyRejected = !open && DETERMINISTIC_REJECTION_RULES.has(rejectionRule);
    if (!open && !deterministicallyRejected) unreviewed += 1;
    if (open && !decision) unreviewed += 1;
    if (decision && !open && !deterministicallyRejected) unreviewed += 1;
    candidateRecords.push({ url, opened: Boolean(open), decided: Boolean(decision), openedEvent: open, decisionEvent: decision });
  }
  for (const event of events.filter((item) => item.event_type === 'candidate_decision')) {
    const url = decisionUrl(event);
    const related = opened.get(url);
    const relatedUrls = related ? openedUrls(related) : [];
    if (url && !candidates.has(url) && !relatedUrls.some((relatedUrl) => candidates.has(relatedUrl)) && event.payload?.match_decision === 'exact_match') errors.push(`Candidate decision has no discovered candidate: ${url}`);
  }
  return { candidates: candidateRecords, opened, decisions, unreviewed };
}

function deriveEvidence(row, candidateRecords, errors) {
  const exact = [];
  for (const candidate of candidateRecords) {
    const open = candidate.openedEvent;
    const decision = candidate.decisionEvent;
    if (!open || !decision) continue;
    const url = eventUrl(open);
    const source = sourceForUrl(url);
    const extracted = open.payload?.extracted ?? {};
    const matchDecision = decision.payload?.match_decision;
    if (open.payload?.source_class && open.payload.source_class !== source.source_class) errors.push(`Source classification is not independently derived for ${url}`);
    const identityMatches = normalize(extracted.brand) === normalize(row.original.b)
      && normalize(extracted.name ?? extracted.title) === normalize(row.original.n);
    if (matchDecision === 'exact_match' && !identityMatches) errors.push(`Copied or mismatched product identity at ${url}`);
    if (matchDecision !== 'exact_match') continue;
    if (source.source_class === 'unknown') errors.push(`Unknown source cannot support exact evidence: ${url}`);
    if (open.payload?.page_kind !== 'product_detail') errors.push(`Exact evidence requires a product_detail page: ${url}`);
    if (Number(open.payload?.status) < 200 || Number(open.payload?.status) >= 300 || open.payload?.parse_status !== 'parsed') errors.push(`Exact evidence requires a successful parsed response: ${url}`);
    const strength = exactStrength(extracted);
    if (!Number.isFinite(strength.value)) errors.push(`Exact evidence has no exact strength semantics: ${url}`);
    if (!identityMatches || source.source_class === 'unknown' || open.payload?.page_kind !== 'product_detail' || !Number.isFinite(strength.value)) continue;
    exact.push({ url, source, extracted, strength_mg_per_pouch: strength.value, calculation: strength.calculation, match_decision: matchDecision });
  }
  const groups = new Map();
  for (const source of exact) {
    const group = source.source.owner_group_id ?? `unknown:${source.source.host}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(source);
  }
  if (exact.length > 1 && groups.size < exact.length) errors.push('Two exact URLs from the same owner group cannot count as independent sources');
  const values = [...new Set(exact.map((source) => source.strength_mg_per_pouch))];
  const conflicts = values.length > 1 && groups.size > 1
    ? exact.map((source) => ({ url: source.url, owner_group_id: source.source.owner_group_id, strength_mg_per_pouch: source.strength_mg_per_pouch }))
    : [];
  const independentExact = [...groups.values()].map((items) => items[0]);
  const trustedSingle = independentExact.some((source) => ['official', 'regulator'].includes(source.source.source_class));
  const verified = !conflicts.length && (trustedSingle || independentExact.length >= 2) && exact.length > 0;
  return { exact, independentExact, verified, conflicts };
}

function deriveInputResult(row, events, { sourceRegistry = SOURCE_REGISTRY } = {}) {
  const errors = [];
  const searches = events.filter((event) => event.event_type === 'search_attempt');
  const successfulSearches = searches.filter(SUCCESS_STATUS);
  const systems = new Set(successfulSearches.map((event) => event.payload.system).filter(Boolean));
  if (systems.size < 2) errors.push('Two independent successful search systems are required');
  const queries = successfulSearches.map((event) => event.payload.query).filter((query) => typeof query === 'string');
  const queryKeys = new Set(queries.map(materialQueryKey));
  const materialSuccessfulQueries = queryKeys.size >= 2;
  if (!materialSuccessfulQueries) errors.push('Two materially distinct successful queries are required');
  const seenCandidates = new Set();
  let noNewSuccessfulQueries = 0;
  for (const event of successfulSearches) {
    const candidates = candidateUrls(event);
    const introducedNewCandidate = candidates.some((url) => !seenCandidates.has(url));
    if (!introducedNewCandidate) noNewSuccessfulQueries += 1;
    candidates.forEach((url) => seenCandidates.add(url));
  }
  const saturation = successfulSearches.length >= 2 && materialSuccessfulQueries && noNewSuccessfulQueries >= 2;
  if (!saturation) errors.push('Saturation is not evidenced by materially distinct successful no-new queries');

  const ownerEvents = events.filter(SUCCESS_OWNER_STATUS);
  const ownerSystems = new Set(ownerEvents.map((event) => event.payload.system).filter(Boolean));
  const usedSystems = new Set(successfulSearches.map((event) => event.payload.system).filter(Boolean));
  const ownerResolution = ownerEvents.some((event) => event.payload.owner) ? 'identified' : 'not_identified';
  if (ownerSystems.size < usedSystems.size || usedSystems.size < 2) errors.push('Owner-specific successful attempts are required in both used search systems');

  const invalidCatalogs = events.filter((event) => event.event_type === 'catalog_lookup' && !successfulCatalog(event));
  if (invalidCatalogs.length) errors.push('Every catalog result requires an item-specific lookup key, result, candidate/no-match, and snapshot hash');
  for (const event of events.filter((item) => item.event_type === 'url_opened')) {
    const url = eventUrl(event);
    const source = sourceForUrl(url, sourceRegistry);
    if (event.payload?.source_class && event.payload.source_class !== source.source_class) errors.push(`Source classification is not independently derived for ${url}`);
  }

  const candidateAccounting = deriveCandidateAccounting(events, errors);
  const evidence = deriveEvidence(row, candidateAccounting.candidates, errors);
  if (candidateAccounting.unreviewed > 0) errors.push(`Unreviewed candidates: ${candidateAccounting.unreviewed}`);
  const protocolComplete = errors.length === 0 && candidateAccounting.unreviewed === 0;
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
    unreviewed_candidate_count: candidateAccounting.unreviewed,
    verified_sources: evidence.independentExact,
    conflicts: evidence.conflicts,
    candidate_records: candidateAccounting.candidates.map((candidate) => ({ url: candidate.url, opened: candidate.opened, decided: candidate.decided, decision: candidate.decisionEvent?.payload?.match_decision ?? null, reason: candidate.decisionEvent?.payload?.reason ?? null })),
    gates: { successful_search_systems: [...systems], material_query_keys: [...queryKeys], owner_systems: [...ownerSystems], candidate_count: candidateAccounting.candidates.length, exact_evidence_count: evidence.exact.length },
    outcome,
    errors,
  };
}

export function deriveResults(snapshot, events, options = {}) {
  const errors = [];
  if (!snapshot || snapshot.schema !== 3 || !Array.isArray(snapshot.rows)) errors.push('Invalid v3 input snapshot');
  const rows = snapshot?.rows ?? [];
  if (snapshot?.snapshot_sha256 && snapshot.snapshot_sha256 !== hashSnapshot(snapshot)) errors.push('Input snapshot hash mismatch');
  const expectedIds = new Set(rows.map((row) => row.input_id));
  errors.push(...verifyEventChain(events, expectedIds));
  const derivedRows = rows.map((row) => deriveInputResult(row, events.filter((event) => event.input_id === row.input_id), options));
  for (const row of derivedRows) for (const error of row.errors) errors.push(`${row.input_id}: ${error}`);
  const pending = derivedRows.filter((row) => row.outcome === 'pending').length;
  return {
    ok: errors.length === 0 && pending === 0,
    errors,
    rows: derivedRows,
    summary: {
      total: derivedRows.length,
      verified: derivedRows.filter((row) => row.outcome === 'verified').length,
      conflicted: derivedRows.filter((row) => row.outcome === 'conflicted').length,
      unresolved_after_complete_search: derivedRows.filter((row) => row.outcome === 'unresolved_after_complete_search').length,
      pending,
      unreviewed_candidate_count: derivedRows.reduce((sum, row) => sum + row.unreviewed_candidate_count, 0),
    },
  };
}

export async function validateV3Artifacts(paths, options = {}) {
  const snapshot = JSON.parse(await readFile(paths.snapshotPath, 'utf8'));
  const events = await readRawEvents(paths.rawEventsPath);
  const selected = options.inputIds ? new Set(options.inputIds) : null;
  const scopedSnapshot = selected ? { ...snapshot, rows: snapshot.rows.filter((row) => selected.has(row.input_id)), snapshot_sha256: null } : snapshot;
  const scopedEvents = selected ? events.filter((event) => selected.has(event.input_id)) : events;
  const result = deriveResults(scopedSnapshot, scopedEvents, options);
  if (paths.derivedResultsPath) {
    await mkdir(dirname(paths.derivedResultsPath), { recursive: true });
    await writeFile(paths.derivedResultsPath, result.rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
  }
  return result;
}

export { deriveInputResult, SUCCESS_STATUS };
