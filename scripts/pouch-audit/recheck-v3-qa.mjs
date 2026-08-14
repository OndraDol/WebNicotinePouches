import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  SOURCE_REGISTRY,
  hashEvents,
  hashInputCard,
  sha256,
  sourceForUrl,
  assertRawEvent,
  verifyEventChain,
} from './recheck-v3-schema.mjs';

function urlKey(url) {
  try { return new URL(url).toString(); } catch { return null; }
}

function normalize(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/gu, ' ');
}

function successfulSearch(event) {
  return event.event_type === 'search_attempt'
    && Number(event.payload?.status) >= 200 && Number(event.payload?.status) < 300
    && event.payload?.parse_status === 'parsed' && event.payload?.cache_hit !== true;
}

function successfulOwner(event) {
  return event.event_type === 'owner_lookup'
    && Number(event.payload?.status) >= 200 && Number(event.payload?.status) < 300
    && event.payload?.parse_status === 'parsed' && event.payload?.cache_hit !== true;
}

function candidateUrls(event) {
  const values = event.payload?.candidate_urls ?? [];
  return (Array.isArray(values) ? values : []).map((value) => typeof value === 'string' ? value : value?.url).map(urlKey).filter(Boolean);
}

function openedUrls(event) {
  return [
    event.payload?.candidate_url,
    event.payload?.requested_url,
    event.payload?.final_url ?? event.payload?.url,
  ].map(urlKey).filter(Boolean);
}

const DETERMINISTIC_REJECTION_RULES = new Set(['non_http_url', 'obvious_search_or_social_domain', 'robots_disallowed_non_product', 'malformed_candidate_url', 'non_product_document_or_forum']);

function queryKey(query) {
  return [...new Set(String(query ?? '').normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/\b(?:exact\s+)?continuation\s*\d+\b/gu, ' ')
    .replace(/\bpage\s*\d+\b/gu, ' ')
    .replace(/["'“”‘’]/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/u).filter(Boolean))].sort().join(' ');
}

function strength(extracted) {
  if (Number.isFinite(Number(extracted?.strength_mg_per_pouch))) return Number(extracted.strength_mg_per_pouch);
  if (Number.isFinite(Number(extracted?.mg_per_g)) && Number.isFinite(Number(extracted?.net_weight_g)) && Number.isFinite(Number(extracted?.pouch_count)) && Number(extracted.pouch_count) > 0) return Number(extracted.mg_per_g) * Number(extracted.net_weight_g) / Number(extracted.pouch_count);
  return null;
}

function independentEvidence(inputRow, rawEvents, errors, sourceRegistry) {
  const opened = new Map();
  for (const event of rawEvents.filter((item) => item.event_type === 'url_opened')) {
    for (const url of openedUrls(event)) opened.set(url, event);
  }
  const decisions = new Map(rawEvents.filter((event) => event.event_type === 'candidate_decision').map((event) => [urlKey(event.payload?.candidate_url ?? event.payload?.url), event]));
  const evidence = [];
  for (const [url, open] of opened) {
    if (!url) continue;
    const decision = decisions.get(url);
    if (decision?.payload?.match_decision !== 'exact_match') continue;
    const source = sourceForUrl(url, sourceRegistry);
    const extracted = open.payload?.extracted ?? {};
    const identityMatches = normalize(extracted.brand) === normalize(inputRow.original.b) && normalize(extracted.name ?? extracted.title) === normalize(inputRow.original.n);
    const exact = source.source_class !== 'unknown'
      && open.payload?.page_kind === 'product_detail'
      && open.payload?.parse_status === 'parsed'
      && Number(open.payload?.status) >= 200 && Number(open.payload?.status) < 300
      && identityMatches
      && Number.isFinite(strength(extracted));
    if (decision.payload?.match_decision === 'exact_match' && !exact) errors.push(`QA rejected non-exact product evidence at ${url}`);
    if (exact) evidence.push({ url, source, strength_mg_per_pouch: strength(extracted) });
  }
  const groups = new Set(evidence.map((item) => item.source.owner_group_id));
  if (evidence.length > groups.size) errors.push('QA found duplicate evidence within one owner group');
  const values = new Set(evidence.map((item) => item.strength_mg_per_pouch));
  return { evidence, groups, conflict: values.size > 1 && groups.size > 1 };
}

function independentlyCheck(inputRow, rawEvents, derivedResult, { sourceRegistry = SOURCE_REGISTRY } = {}) {
  const errors = [];
  const chainErrors = [];
  const contiguous = rawEvents.every((event, index) => event.sequence === index + 1 && (index === 0 ? event.previous_event_sha256 === null : event.previous_event_sha256 === rawEvents[index - 1].event_sha256));
  if (contiguous) {
    chainErrors.push(...verifyEventChain(rawEvents, new Set([inputRow.input_id])));
  } else {
    for (const event of rawEvents) {
      try { assertRawEvent(event, { expectedInputIds: new Set([inputRow.input_id]) }); } catch (error) { chainErrors.push(error.message); }
    }
  }
  errors.push(...chainErrors.map((error) => `event-chain: ${error}`));
  const successfulSearches = rawEvents.filter(successfulSearch);
  const systems = new Set(successfulSearches.map((event) => event.payload?.system).filter(Boolean));
  if (systems.size < 2) errors.push('QA requires two successful search systems');
  const queryKeys = new Set(successfulSearches.map((event) => queryKey(event.payload?.query)));
  if (queryKeys.size < 2) errors.push('QA requires two materially distinct queries');
  const ownerAttempts = rawEvents.filter(successfulOwner);
  const ownerSystems = new Set(ownerAttempts.map((event) => event.payload?.system).filter(Boolean));
  if (ownerSystems.size < 2) errors.push('QA requires successful owner-specific attempts in both search systems');
  const candidates = new Set(successfulSearches.flatMap(candidateUrls));
  const openedEvents = rawEvents.filter((event) => event.event_type === 'url_opened');
  const opened = new Set(openedEvents.flatMap((event) => [
    ...openedUrls(event),
  ]).filter(Boolean));
  const openedByUrl = new Map(openedEvents.flatMap((event) => [
    ...openedUrls(event).map((url) => [url, event]),
  ]).filter(([url]) => url));
  const decisions = new Map();
  for (const event of rawEvents.filter((item) => item.event_type === 'candidate_decision')) {
    const url = urlKey(event.payload?.candidate_url ?? event.payload?.url);
    if (url) {
      decisions.set(url, event);
      for (const relatedUrl of openedByUrl.has(url) ? openedUrls(openedByUrl.get(url)) : []) decisions.set(relatedUrl, event);
    }
  }
  const unreviewed = [...candidates].filter((url) => {
    const decision = decisions.get(url);
    if (!opened.has(url) && DETERMINISTIC_REJECTION_RULES.has(decision?.payload?.rejection_rule)) return false;
    return !opened.has(url) || !decision;
  });
  if (unreviewed.length) errors.push(`QA found ${unreviewed.length} unreviewed candidates`);
  const seenCandidates = new Set();
  let noNewQueries = 0;
  for (const event of successfulSearches) {
    const candidatesForQuery = candidateUrls(event);
    if (!candidatesForQuery.some((url) => !seenCandidates.has(url))) noNewQueries += 1;
    candidatesForQuery.forEach((url) => seenCandidates.add(url));
  }
  const saturation = successfulSearches.length >= 2 && queryKeys.size >= 2 && noNewQueries >= 2;
  if (!saturation) errors.push('QA saturation precondition failed');
  const evidence = independentEvidence(inputRow, rawEvents, errors, sourceRegistry);
  if (derivedResult?.input_id !== inputRow.input_id) errors.push('Derived result input_id does not match frozen card');
  if (derivedResult?.input_card_sha256 !== hashInputCard(inputRow)) errors.push('Derived result input-card hash does not match frozen card');
  if (derivedResult?.outcome === 'verified' && evidence.evidence.length === 0) errors.push('QA refuses verified without product evidence');
  if (derivedResult?.outcome === 'conflicted' && !evidence.conflict) errors.push('QA refuses conflicted without independent conflicting evidence');
  if (derivedResult?.unreviewed_candidate_count !== undefined && derivedResult.unreviewed_candidate_count !== unreviewed.length) errors.push('Derived unreviewed candidate count differs from raw events');
  return { errors, checks: { event_chain: chainErrors.length === 0, two_search_systems: systems.size >= 2, material_queries: queryKeys.size >= 2, owner_attempts: ownerSystems.size >= 2, candidate_coverage: unreviewed.length === 0, saturation, exact_evidence: evidence.evidence.length > 0 || derivedResult?.outcome === 'unresolved_after_complete_search' }, unreviewed, evidence };
}

export function qaOneInput(inputRow, rawEvents, derivedResult, options = {}) {
  const inputHash = hashInputCard(inputRow);
  const rawHash = hashEvents(rawEvents);
  const derivedHash = sha256(derivedResult);
  const check = independentlyCheck(inputRow, rawEvents, derivedResult, options);
  return {
    input_id: inputRow.input_id,
    input_card_sha256: inputHash,
    raw_events_sha256: rawHash,
    derived_result_sha256: derivedHash,
    checks: check.checks,
    errors: check.errors,
    qa_status: check.errors.length === 0 ? 'qa_passed' : 'qa_failed',
  };
}

export function qaV3Set(snapshot, events, derivedResults, options = {}) {
  const byId = new Map((derivedResults ?? []).map((row) => [row.input_id, row]));
  const globalChainErrors = verifyEventChain(events, new Set((snapshot.rows ?? []).map((row) => row.input_id)));
  const rows = (snapshot.rows ?? []).map((inputRow) => {
    const row = qaOneInput(inputRow, events.filter((event) => event.input_id === inputRow.input_id), byId.get(inputRow.input_id) ?? {}, options);
    if (globalChainErrors.length) {
      row.errors.push(...globalChainErrors.map((error) => `global-event-chain: ${error}`));
      row.qa_status = 'qa_failed';
    }
    row.checks.global_event_chain = globalChainErrors.length === 0;
    return row;
  });
  return { ok: rows.length === snapshot.rows.length && rows.every((row) => row.qa_status === 'qa_passed'), rows, summary: { total: rows.length, passed: rows.filter((row) => row.qa_status === 'qa_passed').length, failed: rows.filter((row) => row.qa_status === 'qa_failed').length } };
}

export async function writeQaRows(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
}

export async function readQaRows(path) {
  const content = await readFile(path, 'utf8');
  return content.trim() ? content.trim().split(/\r?\n/u).map((line) => JSON.parse(line)) : [];
}
