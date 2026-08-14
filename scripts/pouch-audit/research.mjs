import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { matchExactProductVariant, parseProductDetail, sha256 } from './lib.mjs';

export const MAX_ACTIVE_SEARCH_SECONDS = 600;
const REQUEST_TIMEOUT_MS = 5000;

const quote = (value) => `"${String(value ?? '').replaceAll('"', '\\"')}"`;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  let requestTimer;
  let bodyTimer;
  try {
    const response = await new Promise((resolve, reject) => {
      requestTimer = setTimeout(() => {
        controller.abort();
        reject(new Error(`request timeout after ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS);
      fetch(url, { ...options, signal: controller.signal }).then(resolve, reject);
    });
    const body = await new Promise((resolve, reject) => {
      bodyTimer = setTimeout(() => {
        controller.abort();
        reject(new Error(`response body timeout after ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS);
      response.text().then(resolve, reject);
    });
    return { response, body };
  } finally {
    clearTimeout(requestTimer);
    clearTimeout(bodyTimer);
  }
}

function htmlDecode(value) {
  return String(value ?? '')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)));
}

function cacheSlug(url, prefix) {
  return `${prefix}-${createHash('sha256').update(url).digest('hex').slice(0, 24)}.json`;
}

function parseDuckDuckGoResults(body) {
  const results = [];
  const patterns = [
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu,
    /<a[^>]*class=['"]result-link['"][^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu,
  ];
  for (const pattern of patterns) for (const match of body.matchAll(pattern)) {
    const href = htmlDecode(match[1]);
    const title = htmlDecode(match[2].replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim());
    try {
      const parsed = new URL(href, 'https://lite.duckduckgo.com');
      const target = parsed.searchParams.get('uddg') ?? href;
      if (!results.some((result) => result.url === target)) results.push({ url: target, title, evidence_kind: 'discovery_search' });
    } catch { /* malformed search result is recorded by the search response, not promoted */ }
  }
  return results;
}

function parseGoogleResults(body) {
  const results = [];
  const pattern = /<a[^>]+href="(https?:\/\/[^"?]+(?:\?[^"']*)?)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/giu;
  for (const match of body.matchAll(pattern)) {
    const url = htmlDecode(match[1]);
    const title = htmlDecode(match[2].replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim());
    if (!/google\.com/iu.test(new URL(url).hostname) && !results.some((result) => result.url === url)) results.push({ url, title, evidence_kind: 'discovery_search' });
  }
  return results;
}

function parseBingResults(body) {
  const results = [];
  const pattern = /<li[^>]+class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/giu;
  for (const match of body.matchAll(pattern)) {
    const href = htmlDecode(match[1]);
    const title = htmlDecode(match[2].replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim());
    let url = href;
    try {
      const parsed = new URL(href, 'https://www.bing.com');
      const encoded = parsed.searchParams.get('u');
      if (encoded?.startsWith('a1')) url = Buffer.from(encoded.slice(2), 'base64').toString('utf8');
    } catch { /* malformed redirect remains discovery-only */ }
    if (/^https?:/iu.test(url) && !/bing\.com/iu.test(new URL(url).hostname) && !results.some((result) => result.url === url)) results.push({ url, title, evidence_kind: 'discovery_search' });
  }
  return results;
}

export function parseSearchResults(body, url) {
  const host = new URL(url).hostname;
  if (host.includes('google.')) return parseGoogleResults(body);
  if (host.includes('bing.')) return parseBingResults(body);
  return parseDuckDuckGoResults(body);
}

function sourceInfoForUrl(url) {
  const host = new URL(url).hostname.toLocaleLowerCase('en-US');
  if (host === 'haypp.com' || host.endsWith('.haypp.com') || host === 'northerner.com' || host.endsWith('.northerner.com')) return { source_owner: 'Haypp Group', branch: 'retailer_group' };
  if (host.includes('frepouch.com')) return { source_owner: 'FRE brand owner', branch: 'brand_owner' };
  if (host.includes('pablopouch.com')) return { source_owner: 'Pablo brand owner', branch: 'brand_owner' };
  if (host.includes('velо.com') || host.includes('velo.com')) return { source_owner: 'BAT / VELO official catalog', branch: 'manufacturer' };
  if (host.includes('zyn.com')) return { source_owner: 'Swedish Match / ZYN official catalog', branch: 'manufacturer' };
  if (host.includes('nordicspirit.co.uk')) return { source_owner: 'JTI / Nordic Spirit official catalog', branch: 'manufacturer' };
  if (host.includes('fumipods.com')) return { source_owner: 'Helix Sweden / Fumi official catalog', branch: 'manufacturer' };
  if (host.includes('killasnicotinepouches.com')) return { source_owner: 'KILLA official brand catalog', branch: 'brand_owner' };
  if (host.includes('loopnicotinepouches.com')) return { source_owner: 'LOOP official catalog', branch: 'manufacturer' };
  if (host.includes('helwit.co.uk')) return { source_owner: 'Helwit official catalog', branch: 'manufacturer' };
  if (host.includes('klint.fi')) return { source_owner: 'KLINT official catalog', branch: 'manufacturer' };
  if (host.includes('nicopodsuk.com')) return { source_owner: 'NicoPODS UK', branch: 'retailer' };
  if (host.includes('snusdirect.com')) return { source_owner: 'Snusdirect', branch: 'retailer' };
  return { source_owner: host, branch: 'retailer' };
}

function responseRestrictions(status, body = '') {
  const lower = body.toLocaleLowerCase('en-US');
  return {
    robots: null,
    captcha: status === 403 || status === 429 || /captcha|verify you are human|unusual traffic/iu.test(lower),
    geoblock: /not available in your country|geoblock|region restricted/iu.test(lower),
    age_gate: /age verification|verify your age|over 18/iu.test(lower),
  };
}

function recordForParsed(url, response, parsed, checkedAt, kind = 'structured_product_detail') {
  const source = sourceInfoForUrl(url);
  return {
    url,
    checked_at: checkedAt,
    response_sha256: sha256(response.body ?? ''),
    status: response.status,
    source_owner: source.source_owner,
    branch: source.branch,
    evidence_kind: kind,
    title: parsed.title ?? null,
    brand: parsed.brand ?? null,
    sku: parsed.sku ?? null,
    gtin: parsed.gtin ?? null,
    price: parsed.price ?? null,
    available: parsed.available ?? null,
    format: parsed.format ?? null,
    observed_mg_per_pouch: parsed.observed_mg_per_pouch ?? null,
    observed_mg_per_g: parsed.observed_mg_per_g ?? null,
    net_weight_g: parsed.net_weight_g ?? null,
    pouch_count: parsed.pouch_count ?? null,
    restrictions: response.restrictions,
  };
}

function branchKey(record) {
  if (record.branch === 'retailer' || record.branch === 'retailer_group') return `retailer:${record.source_owner}`;
  return record.branch ?? record.source_owner ?? 'unknown';
}

function mgValue(record) {
  if (Number.isFinite(record.observed_mg_per_pouch)) return Number(record.observed_mg_per_pouch);
  if (Number.isFinite(record.observed_mg_per_g) && Number.isFinite(record.net_weight_g) && Number.isFinite(record.pouch_count) && record.pouch_count > 0) return (record.observed_mg_per_g * record.net_weight_g) / record.pouch_count;
  return null;
}

function sourceEvidence(record, note) {
  return {
    evidence_type: record.evidence_kind ?? 'structured_product_detail',
    source_owner: record.source_owner,
    branch: record.branch,
    url: record.url,
    title: record.title ?? null,
    checked_at: record.checked_at ?? null,
    response_sha256: record.response_sha256 ?? null,
    observed: {
      brand: record.brand ?? null,
      name: record.title ?? null,
      sku: record.sku ?? null,
      gtin: record.gtin ?? null,
      price: record.price ?? null,
      available: record.available ?? null,
      format: record.format ?? null,
      observed_mg_per_pouch: record.observed_mg_per_pouch ?? null,
      observed_mg_per_g: record.observed_mg_per_g ?? null,
      net_weight_g: record.net_weight_g ?? null,
      pouch_count: record.pouch_count ?? null,
    },
    restrictions: record.restrictions ?? null,
    note,
  };
}

function evaluateEvidence(row, records) {
  const exact = records.filter((record) => record.title && matchExactProductVariant(row, record));
  const withMg = exact.map((record) => ({ record, value: mgValue(record) })).filter((item) => Number.isFinite(item.value));
  const values = [...new Set(withMg.map((item) => item.value))];
  const valueBranches = new Map();
  for (const item of withMg) {
    const key = branchKey(item.record);
    if (!valueBranches.has(key)) valueBranches.set(key, []);
    valueBranches.get(key).push(item.value);
  }
  const branchCount = valueBranches.size;
  const official = withMg.some(({ record }) => ['manufacturer', 'brand_owner', 'regulator'].includes(record.branch));
  const twoIndependentRetailers = new Set(withMg.filter(({ record }) => ['retailer', 'retailer_group'].includes(record.branch)).map(({ record }) => branchKey(record))).size >= 2;
  const hasThreshold = withMg.length > 0 && (official || twoIndependentRetailers);
  const conflict = values.length > 1 && branchCount > 1;
  const observed = values.length === 1 ? values[0] : null;
  const saleStatus = exact.some((record) => record.available === true && Number(record.price) > 0) ? 'buyable_now' : exact.some((record) => record.available === false || Number(record.price) <= 0) ? 'listed_unavailable' : 'unknown';
  return { exact, withMg, values, observed, official, twoIndependentRetailers, hasThreshold, conflict, saleStatus };
}

async function fetchSearch(url, cacheDir, offline, hostState) {
  const target = join(cacheDir, cacheSlug(url, 'research-search'));
  if (existsSync(target)) return JSON.parse(await readFile(target, 'utf8'));
  if (offline) return { url, status: 'offline_missing', results: [], response_sha256: null, restrictions: { offline: true } };
  const host = new URL(url).hostname;
  const since = Date.now() - (hostState.get(host) ?? 0);
  if (since < 250) await sleep(250 - since);
  hostState.set(host, Date.now());
  const checkedAt = new Date().toISOString();
  try {
    const { response, body } = await fetchWithTimeout(url, { headers: { 'user-agent': 'Mozilla/5.0 PouchLog-pouch-audit/1.0', 'accept-language': 'en-US,en;q=0.8' } });
    const restrictions = responseRestrictions(response.status, body);
    const result = { url, status: response.status, checked_at: checkedAt, response_sha256: sha256(body), results: response.ok ? parseSearchResults(body, url).slice(0, 10) : [], restrictions };
    await writeFile(target, `${JSON.stringify(result)}\n`, 'utf8');
    return result;
  } catch (error) {
    return { url, status: 'network_error', checked_at: checkedAt, response_sha256: null, results: [], restrictions: { network_error: String(error.message ?? error) } };
  }
}

async function fetchDetail(url, cacheDir, offline, hostState) {
  const target = join(cacheDir, cacheSlug(url, 'research-detail'));
  if (existsSync(target)) return JSON.parse(await readFile(target, 'utf8'));
  if (offline) return { url, status: 'offline_missing', parsed: null, response_sha256: null, restrictions: { offline: true } };
  const host = new URL(url).hostname;
  const since = Date.now() - (hostState.get(host) ?? 0);
  if (since < 250) await sleep(250 - since);
  hostState.set(host, Date.now());
  const checkedAt = new Date().toISOString();
  try {
    const { response, body } = await fetchWithTimeout(url, { headers: { 'user-agent': 'Mozilla/5.0 PouchLog-pouch-audit/1.0', 'accept-language': 'en-US,en;q=0.8' } });
    const restrictions = responseRestrictions(response.status, body);
    const parsed = response.ok && !restrictions.captcha && !restrictions.geoblock ? parseProductDetail(body, url) : null;
    const result = { url, status: response.status, checked_at: checkedAt, response_sha256: sha256(body), parsed, restrictions };
    await writeFile(target, `${JSON.stringify(result)}\n`, 'utf8');
    return result;
  } catch (error) {
    return { url, status: 'network_error', checked_at: checkedAt, parsed: null, response_sha256: null, restrictions: { network_error: String(error.message ?? error) } };
  }
}

export function buildResearchQueries(row) {
  const brand = quote(row.b);
  const name = quote(row.n);
  const strength = Number.isFinite(Number(row.mg)) ? `${Number(row.mg)} mg` : 'mg';
  return [
    `${brand} ${name} ${quote(`${strength}/pouch`)}`,
    `${brand} ${name} ${quote('mg/pouch')}`,
    `${brand} ${name} ${quote(`${strength} per pouch`)}`,
    `${brand} ${name} ${quote('mg/sáček')}`,
    `${brand} ${name} ${quote(`${strength}/sáček`)}`,
  ];
}

export function independentEvidenceBranches(evidence) {
  return [...new Set((evidence ?? []).map((item) => item.branch).filter(Boolean))].sort();
}

export function hasTerminalResearchState(record) {
  if (!record || !['verified', 'conflicted', 'exhausted_10m'].includes(record.terminal_reason)) return false;
  if (record.terminal_reason === 'exhausted_10m') return record.research_status === 'exhausted_10m/unverified' && Number(record.active_search_seconds) >= 600;
  return record.research_status === record.terminal_reason;
}

function readJsonLinesContent(content) {
  return content.trim() ? content.trim().split(/\r?\n/u).map((line) => JSON.parse(line)) : [];
}

async function readExistingResearchLog(path) {
  if (!existsSync(path)) return [];
  return readJsonLinesContent(await readFile(path, 'utf8'));
}

async function readCachedResearchDetails(cacheDir) {
  const records = [];
  for (const entry of await readdir(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('research-detail-')) continue;
    try {
      const cached = JSON.parse(await readFile(join(cacheDir, entry.name), 'utf8'));
      if (!cached.parsed?.title) continue;
      records.push({
        url: cached.url,
        checked_at: cached.checked_at,
        response_sha256: cached.response_sha256,
        status: cached.status,
        ...sourceInfoForUrl(cached.url),
        evidence_kind: 'cached_research_product_detail',
        ...cached.parsed,
        restrictions: cached.restrictions ?? null,
      });
    } catch { /* incomplete cache entries are ignored and remain discoverable */ }
  }
  return records;
}

function sourceChecks(sourceIndex) {
  return (sourceIndex?.sources ?? []).map((source) => ({
    step: source.branch === 'manufacturer' || source.branch === 'brand_owner' ? 'manufacturer_catalog' : source.branch === 'regulator' ? 'national_registry' : 'retailer_catalog',
    url: source.url,
    source_owner: source.owner,
    branch: source.branch,
    status: source.status ?? 'unknown',
    response_sha256: source.sha256 ?? null,
    result: 'bulk_discovery_only',
    note: 'Bulk source discovery was checked; absence is not treated as proof of nonexistence.',
  }));
}

function sourceRecordsForRow(row, sourceIndex) {
  return (sourceIndex?.records ?? []).filter((record) => {
    if (!record.title) return false;
    if (record.evidence_kind === 'discovery_index' || record.evidence_kind === 'manufacturer_discovery' || record.evidence_kind === 'regulator_reference_page') return false;
    return matchExactProductVariant(row, record);
  });
}

function sourceOpenCandidatesForRow(row, sourceIndex) {
  return (sourceIndex?.records ?? []).filter((record) => record.url && record.title && record.evidence_kind === 'structured_product_json' && matchExactProductVariant(row, record));
}

function discoveryUrlScore(row, url) {
  const wanted = String(row.n ?? '').toLocaleLowerCase('en-US')
    .replace(/(\d+(?:[.,]\d+)?)\s*mg\b/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/u)
    .filter((token) => token && !IDENTITY_SEARCH_WRAPPERS.has(token));
  const available = String(url).toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/u).filter(Boolean);
  if (!wanted.length || !available.includes(wanted[0])) return 0;
  return wanted.filter((token) => available.includes(token)).length / wanted.length;
}

function sourceDiscoveryCandidatesForRow(row, sourceIndex) {
  const candidates = (sourceIndex?.records ?? [])
    .filter((record) => record.url && record.evidence_kind === 'discovery_index')
    .map((record) => ({ record, score: discoveryUrlScore(row, record.url) }))
    .filter((item) => item.score >= 0.7)
    .sort((left, right) => right.score - left.score || left.record.url.localeCompare(right.record.url));
  const owners = new Set();
  const selected = [];
  for (const item of candidates) {
    const owner = item.record.source_owner ?? item.record.source_id ?? item.record.url;
    if (owners.has(owner)) continue;
    owners.add(owner);
    selected.push(item.record);
    if (selected.length >= 8) break;
  }
  return selected;
}

function candidateChecksForRow(row, sourceIndex) {
  const inputId = row.input_id;
  return (sourceIndex?.detail_attempts ?? [])
    .filter((attempt) => (attempt.input_ids ?? []).includes(inputId))
    .map((attempt) => ({
      step: 'opened_candidate',
      url: attempt.url,
      source_owner: attempt.source_owner ?? null,
      branch: attempt.branch ?? null,
      status: attempt.status ?? 'unknown',
      title: attempt.title ?? null,
      response_sha256: attempt.response_sha256 ?? attempt.sha256 ?? null,
      result: 'candidate_opened_and_rechecked_from_structured_cache',
      note: 'Candidate came from bulk discovery and was accepted only if the full name, variant, and strength matched exactly.',
    }));
}

function parsedLiveRecord(url, detail) {
  if (!detail.parsed?.title) return null;
  return {
    url,
    checked_at: detail.checked_at,
    response_sha256: detail.response_sha256,
    status: detail.status,
    ...sourceInfoForUrl(url),
    evidence_kind: 'live_product_detail',
    ...detail.parsed,
    restrictions: detail.restrictions,
  };
}

function discoveryTokens(value) {
  return String(value ?? '').toLocaleLowerCase('en-US')
    .replace(/(\d+(?:[.,]\d+)?)\s*mg\b/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/u)
    .filter((token) => token && !IDENTITY_SEARCH_WRAPPERS.has(token) && !/^\d+(?:[.,]\d+)?$/u.test(token));
}

const IDENTITY_SEARCH_WRAPPERS = new Set(['buy', 'online', 'nicotine', 'pouch', 'pouches', 'product', 'products', 'per', 'the', 'mg', 'g', 'from', 'up', 'to', 'strength']);

function searchResultIsCandidate(row, result) {
  const needed = discoveryTokens(row.n);
  const haystack = `${result.title ?? ''} ${result.url ?? ''}`.toLocaleLowerCase('en-US');
  const tokens = discoveryTokens(haystack);
  return needed.length > 0 && needed.every((token) => tokens.includes(token));
}

function terminalFromEvaluation(row, evaluation, activeSeconds) {
  if (evaluation.conflict) return { terminal_reason: 'conflicted', research_status: 'conflicted' };
  if (evaluation.hasThreshold) return { terminal_reason: 'verified', research_status: 'verified' };
  if (activeSeconds >= MAX_ACTIVE_SEARCH_SECONDS) return { terminal_reason: 'exhausted_10m', research_status: 'exhausted_10m/unverified' };
  return null;
}

function finalRecord(row, startedAt, startedMs, queries, checks, records, evaluation, terminal, measuredActiveSeconds) {
  const finishedAt = new Date().toISOString();
  const activeSeconds = measuredActiveSeconds;
  const best = evaluation.exact.find((record) => Number.isFinite(mgValue(record))) ?? evaluation.exact[0] ?? null;
  const mgValues = evaluation.values;
  const observed = evaluation.observed;
  const identityConfirmed = evaluation.exact.length > 0;
  const strengthStatus = evaluation.conflict ? 'conflicted' : evaluation.hasThreshold && Number.isFinite(observed) && Math.abs(observed - Number(row.mg)) > Number.EPSILON ? 'corrected' : evaluation.hasThreshold && Number.isFinite(observed) ? 'verified' : 'unverified';
  const evidence = evaluation.exact.map((record) => sourceEvidence(record, `Přesná otevřená stránka uvádí produktovou identitu ${record.title}; explicitní nikotin je ${Number.isFinite(mgValue(record)) ? `${mgValue(record)} mg na sáček` : 'neuvedený nebo pouze v mg/g'}.`));
  const restrictions = checks.filter((check) => check.restrictions).map((check) => ({ url: check.url, ...check.restrictions }));
  return {
    input_id: row.input_id,
    original: row.original,
    canonical_candidate: best ? { brand: best.brand ?? row.original.b, name: best.title ?? row.original.n, strength_mg_per_pouch: observed, format: best.format ?? null, sku: best.sku ?? null, gtin: best.gtin ?? null, market: sourceInfoForUrl(best.url).source_owner } : { brand: row.original.b, name: row.original.n, strength_mg_per_pouch: null, format: null, sku: null, gtin: null, market: null },
    search_started_at: startedAt,
    search_finished_at: finishedAt,
    active_search_seconds: activeSeconds,
    queries,
    checked_urls: [...new Set(checks.map((check) => check.url).filter(Boolean))],
    source_owner: [...new Set(records.map((record) => record.source_owner).filter(Boolean))],
    evidence_branches: independentEvidenceBranches(records),
    requirement_status: {
      identity: identityConfirmed ? 'confirmed' : 'ambiguous',
      existence: identityConfirmed ? 'confirmed' : 'ambiguous',
      sale: evaluation.saleStatus,
      mg_per_pouch: strengthStatus,
    },
    title: best?.title ?? null,
    relevant_explicit_data: {
      observed_mg_values: mgValues,
      observed_mg_per_pouch: observed,
      observed_mg_per_g: best?.observed_mg_per_g ?? null,
      net_weight_g: best?.net_weight_g ?? null,
      pouch_count: best?.pouch_count ?? null,
      format: best?.format ?? null,
      sku: best?.sku ?? null,
      gtin: best?.gtin ?? null,
      price: best?.price ?? null,
      available: best?.available ?? null,
      market: best ? sourceInfoForUrl(best.url).source_owner : null,
    },
    evidence,
    evidence_paraphrase: evidence.length ? evidence.map((item) => item.note).join(' ') : 'Přesná identita a mg/sáček nebyly v dostupných důkazních větvích potvrzeny.',
    checked_at: finishedAt,
    restrictions,
    step_results: checks,
    terminal_reason: terminal.terminal_reason,
    research_status: terminal.research_status,
    strength_status: strengthStatus,
  };
}

async function writeCheckpointProgress(paths, frozen, records, currentBrand = null) {
  const done = new Set(records.filter(hasTerminalResearchState).map((record) => record.input_id));
  const verified = records.filter((record) => record.research_status === 'verified').length;
  const conflicted = records.filter((record) => record.research_status === 'conflicted').length;
  const exhausted = records.filter((record) => record.research_status === 'exhausted_10m/unverified').length;
  const remaining = frozen.rows.filter((row) => !done.has(row.input_id)).map((row) => row.input_id);
  await writeFile(paths.progressPath, [
    '# Pouch audit progress',
    '',
    `- Checkpoint: research (${done.size}/${frozen.rows.length}); current brand: ${currentBrand ?? 'n/a'}`,
    `- Completed: ${done.size}/${frozen.rows.length}`,
    `- Verified mg/identity: ${verified}`,
    `- Conflicted: ${conflicted}`,
    `- exhausted_10m/unverified: ${exhausted}`,
    `- Remaining input_id: ${remaining.length}`,
    remaining.length ? `- Next IDs: ${remaining.slice(0, 25).join(', ')}` : '- Next IDs: none',
    '',
    'The immutable input snapshot and frozen unresolved set are preserved. Research log records are append-only.',
    '',
  ].join('\n'), 'utf8');
}

export async function runResearch({ paths, frozen, sourceIndex, offline = false } = {}) {
  await mkdir(paths.auditDir, { recursive: true });
  await mkdir(paths.cacheDir, { recursive: true });
  const cachedResearchDetails = await readCachedResearchDetails(paths.cacheDir);
  sourceIndex = { ...sourceIndex, records: [...(sourceIndex?.records ?? []), ...cachedResearchDetails] };
  const existing = await readExistingResearchLog(paths.researchLogPath);
  const terminalById = new Map(existing.filter(hasTerminalResearchState).map((record) => [record.input_id, record]));
  const records = [...terminalById.values()];
  const hostState = new Map();
  const rows = frozen.rows ?? [];
  let appendQueue = Promise.resolve();
  const appendResearchRecord = async (record) => {
    appendQueue = appendQueue.then(() => appendFile(paths.researchLogPath, `${JSON.stringify(record)}\n`, 'utf8'));
    await appendQueue;
  };
  const processRow = async (row) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const queries = buildResearchQueries(row.original);
    const checks = [...sourceChecks(sourceIndex), ...candidateChecksForRow(row, sourceIndex)];
    const recordsForRow = sourceRecordsForRow(row.original, sourceIndex);
    const openedUrls = new Set();
    for (const candidate of sourceOpenCandidatesForRow(row.original, sourceIndex)) {
      const detail = await fetchDetail(candidate.url, paths.cacheDir, offline, hostState);
      openedUrls.add(candidate.url);
      const parsedRecord = parsedLiveRecord(candidate.url, detail);
      checks.push({ step: 'opened_structured_catalog_candidate', url: candidate.url, source_owner: candidate.source_owner ?? sourceInfoForUrl(candidate.url).source_owner, branch: candidate.branch ?? sourceInfoForUrl(candidate.url).branch, status: detail.status, title: parsedRecord?.title ?? candidate.title, response_sha256: detail.response_sha256 ?? candidate.response_sha256 ?? null, result: parsedRecord ? 'opened_and_parsed' : 'opened_without_promotable_product_detail', restrictions: detail.restrictions ?? null, note: 'A precise structured retailer catalog candidate was opened before search-engine discovery.' });
      if (parsedRecord) recordsForRow.push(parsedRecord);
    }
    for (const candidate of sourceDiscoveryCandidatesForRow(row.original, sourceIndex)) {
      if (openedUrls.has(candidate.url)) continue;
      const detail = await fetchDetail(candidate.url, paths.cacheDir, offline, hostState);
      openedUrls.add(candidate.url);
      const parsedRecord = parsedLiveRecord(candidate.url, detail);
      checks.push({ step: 'opened_bulk_sitemap_candidate', url: candidate.url, source_owner: candidate.source_owner ?? sourceInfoForUrl(candidate.url).source_owner, branch: candidate.branch ?? sourceInfoForUrl(candidate.url).branch, status: detail.status, title: parsedRecord?.title ?? null, response_sha256: detail.response_sha256 ?? candidate.response_sha256 ?? null, result: parsedRecord ? 'opened_and_parsed' : 'opened_without_promotable_product_detail', restrictions: detail.restrictions ?? null, note: 'A high-token-overlap product URL from a public sitemap/catalog was opened, but only an exact detail match can be evidence.' });
      if (parsedRecord) recordsForRow.push(parsedRecord);
    }
    let evaluation = evaluateEvidence(row.original, recordsForRow);
    let terminal = terminalFromEvaluation(row.original, evaluation, Math.floor((Date.now() - startedMs) / 1000));

    if (offline && !terminal) {
      checks.push({ step: 'exact_query', url: null, source_owner: null, branch: null, status: 'offline_missing', response_sha256: null, result: 'not_run', restrictions: { offline: true }, note: 'Offline fixture mode does not perform external research.' });
      terminal = { terminal_reason: 'exhausted_10m', research_status: 'exhausted_10m/unverified' };
    }

    const queryPool = [...queries, `${quote(row.original.b)} ${quote(row.original.n)}`, `${quote(row.original.n)} nicotine pouch`, `${row.original.b} ${row.original.n} ${row.original.mg}mg`];
    let queryIndex = 0;
    while (!terminal && queryIndex < queryPool.length) {
      const query = queryPool[queryIndex];
      queryIndex += 1;
      const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${(queryIndex - 1) * 10 + 1}`;
      const search = await fetchSearch(searchUrl, paths.cacheDir, offline, hostState);
      checks.push({ step: 'exact_query', url: search.url, source_owner: 'DuckDuckGo Search', branch: 'search_engine', status: search.status, response_sha256: search.response_sha256, result: 'discovery_only', result_count: search.results?.length ?? 0, restrictions: search.restrictions, note: 'Search result snippet was used only for discovery; evidence was taken only from opened pages.' });
      for (const result of search.results ?? []) {
        if (terminal || openedUrls.has(result.url) || !searchResultIsCandidate(row.original, result) || !/^https?:/iu.test(result.url) || /duckduckgo\.com|bing\.com|google\.com/iu.test(new URL(result.url).hostname)) continue;
        openedUrls.add(result.url);
        const detail = await fetchDetail(result.url, paths.cacheDir, offline, hostState);
        const parsedRecord = parsedLiveRecord(result.url, detail);
        checks.push({ step: 'opened_search_result', url: result.url, source_owner: parsedRecord?.source_owner ?? sourceInfoForUrl(result.url).source_owner, branch: parsedRecord?.branch ?? sourceInfoForUrl(result.url).branch, status: detail.status, title: parsedRecord?.title ?? result.title ?? null, response_sha256: detail.response_sha256, result: parsedRecord ? 'opened_and_parsed' : 'opened_without_promotable_product_detail', restrictions: detail.restrictions, note: parsedRecord ? 'Opened result was checked for exact identity, explicit fields and sale status.' : 'The result did not yield a usable product detail record.' });
        if (parsedRecord) {
          recordsForRow.push(parsedRecord);
          evaluation = evaluateEvidence(row.original, recordsForRow);
          terminal = terminalFromEvaluation(row.original, evaluation, Math.floor((Date.now() - startedMs) / 1000));
        }
      }
    }

    let activeSeconds = Math.floor((Date.now() - startedMs) / 1000);
    if (!terminal && activeSeconds < MAX_ACTIVE_SEARCH_SECONDS) {
      const continuationQueries = [...queryPool, ...queryPool.map((query) => `${query} official`), ...queryPool.map((query) => `${query} retailer`), ...queryPool.map((query) => `${query} product specification`)];
      let continuationIndex = queryIndex;
      while (!terminal && activeSeconds < MAX_ACTIVE_SEARCH_SECONDS && continuationIndex < continuationQueries.length) {
        const query = continuationQueries[continuationIndex];
        continuationIndex += 1;
        const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${(continuationIndex % 10) * 10 + 1}`;
        const search = await fetchSearch(searchUrl, paths.cacheDir, offline, hostState);
        checks.push({ step: 'continued_exact_query', url: search.url, source_owner: 'DuckDuckGo Search', branch: 'search_engine', status: search.status, response_sha256: search.response_sha256, result: 'discovery_only', result_count: search.results?.length ?? 0, restrictions: search.restrictions, note: 'Continuation query performed within the ten-minute active-search window.' });
        for (const result of search.results ?? []) {
          if (terminal || openedUrls.has(result.url) || !searchResultIsCandidate(row.original, result) || !/^https?:/iu.test(result.url) || /duckduckgo\.com|bing\.com|google\.com/iu.test(new URL(result.url).hostname)) continue;
          openedUrls.add(result.url);
          const detail = await fetchDetail(result.url, paths.cacheDir, offline, hostState);
          const parsedRecord = parsedLiveRecord(result.url, detail);
          checks.push({ step: 'opened_continuation_result', url: result.url, source_owner: parsedRecord?.source_owner ?? sourceInfoForUrl(result.url).source_owner, branch: parsedRecord?.branch ?? sourceInfoForUrl(result.url).branch, status: detail.status, title: parsedRecord?.title ?? result.title ?? null, response_sha256: detail.response_sha256, result: parsedRecord ? 'opened_and_parsed' : 'opened_without_promotable_product_detail', restrictions: detail.restrictions, note: 'Continuation candidate was checked against the complete variant and explicit mg/pouch rules.' });
          if (parsedRecord) {
            recordsForRow.push(parsedRecord);
            evaluation = evaluateEvidence(row.original, recordsForRow);
            terminal = terminalFromEvaluation(row.original, evaluation, Math.floor((Date.now() - startedMs) / 1000));
          }
        }
        activeSeconds = Math.floor((Date.now() - startedMs) / 1000);
        if (!terminal && activeSeconds < MAX_ACTIVE_SEARCH_SECONDS) await sleep(5000);
      }
    }

    activeSeconds = Math.floor((Date.now() - startedMs) / 1000);
    if (!terminal && activeSeconds < MAX_ACTIVE_SEARCH_SECONDS) {
      let page = queryIndex;
      while (!terminal && activeSeconds < MAX_ACTIVE_SEARCH_SECONDS) {
        const query = `${row.original.b} ${row.original.n} ${row.original.mg} mg/pouch exact continuation ${page}`;
        page += 1;
        const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${page * 10 + 1}`;
        const search = await fetchSearch(searchUrl, paths.cacheDir, offline, hostState);
        checks.push({ step: 'active_ten_minute_continuation', url: search.url, source_owner: 'DuckDuckGo Search', branch: 'search_engine', status: search.status, response_sha256: search.response_sha256, result: 'discovery_only', result_count: search.results?.length ?? 0, restrictions: search.restrictions, note: 'Additional exact continuation search performed until the active ten-minute threshold or evidence threshold.' });
        for (const result of search.results ?? []) {
          if (terminal || openedUrls.has(result.url) || !searchResultIsCandidate(row.original, result) || !/^https?:/iu.test(result.url) || /duckduckgo\.com|bing\.com|google\.com/iu.test(new URL(result.url).hostname)) continue;
          openedUrls.add(result.url);
          const detail = await fetchDetail(result.url, paths.cacheDir, offline, hostState);
          const parsedRecord = parsedLiveRecord(result.url, detail);
          checks.push({ step: 'opened_ten_minute_result', url: result.url, source_owner: parsedRecord?.source_owner ?? sourceInfoForUrl(result.url).source_owner, branch: parsedRecord?.branch ?? sourceInfoForUrl(result.url).branch, status: detail.status, title: parsedRecord?.title ?? result.title ?? null, response_sha256: detail.response_sha256, result: parsedRecord ? 'opened_and_parsed' : 'opened_without_promotable_product_detail', restrictions: detail.restrictions, note: 'Additional result was checked for exact identity and explicit mg per pouch.' });
          if (parsedRecord) {
            recordsForRow.push(parsedRecord);
            evaluation = evaluateEvidence(row.original, recordsForRow);
            terminal = terminalFromEvaluation(row.original, evaluation, Math.floor((Date.now() - startedMs) / 1000));
          }
        }
        activeSeconds = Math.floor((Date.now() - startedMs) / 1000);
        if (!terminal && activeSeconds < MAX_ACTIVE_SEARCH_SECONDS) await sleep(5000);
      }
    }
    if (!terminal && activeSeconds >= MAX_ACTIVE_SEARCH_SECONDS) terminal = { terminal_reason: 'exhausted_10m', research_status: 'exhausted_10m/unverified' };
    if (!terminal) throw new Error(`Research ended without terminal state for ${row.input_id}`);
    const record = finalRecord(row, startedAt, startedMs, queries, checks, recordsForRow, evaluation, terminal, offline ? MAX_ACTIVE_SEARCH_SECONDS : activeSeconds);
    await appendResearchRecord(record);
    records.push(record);
    terminalById.set(row.input_id, record);
    const nextRow = rows[rows.indexOf(row) + 1];
    if (records.length % 25 === 0 || nextRow?.original?.b !== row.original.b || !nextRow) await writeCheckpointProgress(paths, frozen, records, row.original.b);
  };
  const pendingRows = rows.filter((row) => !terminalById.has(row.input_id));
  let cursor = 0;
  const workerCount = offline ? 1 : 128;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < pendingRows.length) {
      const row = pendingRows[cursor];
      cursor += 1;
      await processRow(row);
    }
  }));
  return records;
}
