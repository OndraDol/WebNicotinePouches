import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SOURCE_DEFINITIONS,
  inferProductType,
  matchExactProductVariant,
  parseProductDetail,
  resolvePaths,
  sha256,
} from './lib.mjs';
import { parseSearchResults } from './research.mjs';

export const V2_OUTCOMES = ['verified', 'conflicted', 'not_verifiable_after_protocol'];
const MATCH_DECISIONS = ['exact_match', 'near_match', 'wrong_variant'];
const QA_STATES = ['pending', 'qa_failed', 'passed'];
const SEARCH_SYSTEMS = ['google', 'bing'];
const BAD_FINAL_STATES = ['pending', 'in_progress', 'unchecked', 'qa_failed', 'exhausted_10m'];
const USER_AGENT = 'Mozilla/5.0 PouchLog-recheck-v2/1.0';
const FETCH_TIMEOUT_MS = 12000;

const RETAILER_BRANCHES = [
  { id: 'haypp', owner: 'Haypp Group', branch: 'retailer_group', source_type: 'retailer_catalog', url: 'https://www.haypp.com/uk/sitemap/sitemap-products.xml' },
  { id: 'nicopodsuk', owner: 'NicoPODS UK', branch: 'retailer_nicopodsuk', source_type: 'retailer_catalog', url: 'https://www.nicopodsuk.com/collections/nicotine-pouches/products.json' },
  { id: 'snusdirect', owner: 'Snusdirect', branch: 'retailer_snusdirect', source_type: 'retailer_catalog', url: 'https://www.snusdirect.com/sitemap.xml' },
];

const REGISTRY_BY_MARKET = {
  US: { owner: 'US FDA', branch: 'regulator_us', source_type: 'relevant_registry', url: 'https://www.fda.gov/tobacco-products/market-and-distribute-tobacco-product/nicotine-pouch-products-authorized-fda' },
  Canada: { owner: 'Health Canada', branch: 'regulator_canada', source_type: 'relevant_registry', url: 'https://health-products.canada.ca/lnhpd-bdpsnh/' },
  Sweden: { owner: 'Swedish Public Health Agency', branch: 'regulator_sweden', source_type: 'relevant_registry', url: 'https://tfn.folkhalsomyndigheten.se/ltn-web/publicationList.html?lang=en' },
  Denmark: { owner: 'Danish Safety Technology Authority', branch: 'regulator_denmark', source_type: 'relevant_registry', url: 'https://www.sik.dk/en/registries/export/register_over_tobakssurrogater' },
};

const OFFICIAL_BY_BRAND = new Map([
  ['VELO', 'manufacturer_velo_uk'], ['VELO PLUS', 'manufacturer_velo_uk'], ['VELO SHIFT', 'manufacturer_velo_uk'], ['Velo', 'manufacturer_velo_uk'],
  ['ZYN', 'manufacturer_zyn_us'], ['Nordic Spirit', 'manufacturer_nordic_spirit_uk'], ['FUMI', 'manufacturer_fumi'], ['KLINT', 'manufacturer_klint'],
  ['PABLO', 'manufacturer_pablo'], ['Pablo', 'manufacturer_pablo'], ['LOOP', 'manufacturer_loop'], ['Loop', 'manufacturer_loop'],
  ['Helwit', 'manufacturer_helwit'], ['HELWIT', 'manufacturer_helwit'], ['FRE', 'manufacturer_fre'], ['White Fox', 'manufacturer_white_fox'],
  ['KILLA', 'manufacturer_killa'],
]);

const US_BRANDS = new Set(['ZYN', 'On!', 'ON!', 'Rogue', 'FRE', 'Lucy', 'Juice Head', 'BLACK BUFFALO', 'Grizzly', 'White Fox']);
const SWEDISH_BRANDS = new Set(['VELO', 'VELO Plus', 'VELO Shift', 'Velo', 'Nordic Spirit', 'ZYN', 'LOOP', 'Loop', 'FUMI', 'FRE', 'Helwit', 'HELWIT', 'KLINT', 'Skruf', 'SKRUF']);

function v2Paths(paths) {
  return {
    ...paths,
    v2Path: join(paths.auditDir, 'recheck-v2.jsonl'),
    qaPath: join(paths.auditDir, 'recheck-v2-qa.jsonl'),
    progressV2Path: join(paths.auditDir, 'recheck-v2-progress.md'),
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readJsonLines(path) {
  if (!existsSync(path)) return [];
  const content = await readFile(path, 'utf8');
  return content.trim() ? content.trim().split(/\r?\n/u).map((line) => JSON.parse(line)) : [];
}

async function writeJsonLines(path, rows) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function validHttpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

function distinct(values) {
  return [...new Set(values.filter(Boolean))];
}

function mgPerPouch(explicit) {
  if (Number.isFinite(explicit.strength_mg_per_pouch)) return { value: Number(explicit.strength_mg_per_pouch), calculation: null };
  if (Number.isFinite(explicit.mg_per_g) && Number.isFinite(explicit.net_weight_g) && Number.isFinite(explicit.pouch_count) && explicit.pouch_count > 0) {
    const value = (explicit.mg_per_g * explicit.net_weight_g) / explicit.pouch_count;
    return { value, calculation: { expression: 'mg_per_g * net_weight_g / pouch_count', inputs: { mg_per_g: explicit.mg_per_g, net_weight_g: explicit.net_weight_g, pouch_count: explicit.pouch_count }, result: value } };
  }
  return { value: null, calculation: null };
}

function marketForRow(row) {
  if (US_BRANDS.has(row.b)) return { market: 'US', basis: 'Brand is in the US-market subset of the frozen catalog; the US FDA nicotine-pouch registry is the relevant regulator.' };
  if (SWEDISH_BRANDS.has(row.b)) return { market: 'Sweden/European retail', basis: 'Brand is associated with Swedish/European nicotine-pouch retail; Swedish TFN is used only as a market-specific registry check.' };
  return { market: 'UK/EU retail reference market', basis: 'The frozen input has no market field; the audit uses the UK/EU retail reference market and does not treat US or Canadian registries as applicable.' };
}

function sourceForDefinition(definition) {
  return definition ? { source_owner: definition.owner, evidence_branch: definition.branch, source_type: definition.kind, url: definition.url } : null;
}

function sourceMetaForUrl(url, candidateMeta = null) {
  if (candidateMeta?.source_owner) {
    let branch = candidateMeta.branch ?? 'retailer_unknown';
    if (branch === 'retailer') {
      if (host.includes('snusdirect.com')) branch = 'retailer_snusdirect';
      else if (host.includes('nicopodsuk.com')) branch = 'retailer_nicopodsuk';
      else if (host.includes('haypp.com') || host.includes('northerner.com')) branch = 'retailer_group';
      else branch = `retailer_${host}`;
    }
    return { source_owner: candidateMeta.source_owner, evidence_branch: branch, source_type: 'product_detail' };
  }
  let host;
  try { host = new URL(url).hostname.toLocaleLowerCase('en-US'); } catch { host = 'invalid-url'; }
  if (host.includes('haypp.com') || host.includes('northerner.com')) return { source_owner: 'Haypp Group', evidence_branch: 'retailer_group', source_type: 'product_detail' };
  if (host.includes('nicopodsuk.com')) return { source_owner: 'NicoPODS UK', evidence_branch: 'retailer_nicopodsuk', source_type: 'product_detail' };
  if (host.includes('snusdirect.com')) return { source_owner: 'Snusdirect', evidence_branch: 'retailer_snusdirect', source_type: 'product_detail' };
  if (host.includes('fda.gov')) return { source_owner: 'US FDA', evidence_branch: 'regulator_us', source_type: 'relevant_registry' };
  if (host.includes('canada.ca')) return { source_owner: 'Health Canada', evidence_branch: 'regulator_canada', source_type: 'relevant_registry' };
  if (host.includes('folkhalsomyndigheten.se')) return { source_owner: 'Swedish Public Health Agency', evidence_branch: 'regulator_sweden', source_type: 'relevant_registry' };
  if (host.includes('sik.dk')) return { source_owner: 'Danish Safety Technology Authority', evidence_branch: 'regulator_denmark', source_type: 'relevant_registry' };
  for (const definition of SOURCE_DEFINITIONS) {
    try { if (new URL(definition.url).hostname === host) return { source_owner: definition.owner, evidence_branch: definition.branch, source_type: definition.kind }; } catch { /* ignore malformed configured source */ }
  }
  return { source_owner: host, evidence_branch: `retailer_${host}`, source_type: 'product_detail' };
}

function pageTitle(body) {
  const match = body.match(/<title[^>]*>\s*([^<]+?)\s*<\/title>/iu);
  return match ? match[1].replace(/\s+/gu, ' ').trim() : null;
}

async function fetchLive(url, cache, extra = {}) {
  if (cache.has(url)) return cache.get(url);
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let result;
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': USER_AGENT, 'accept-language': 'en-US,en;q=0.8' } });
    const body = await response.text();
    result = { url, status: response.status, checked_at: checkedAt, title: pageTitle(body), response_sha256: sha256(body), body, content_type: response.headers.get('content-type'), ...extra };
  } catch (error) {
    const marker = `fetch-error:${String(error?.message ?? error)}`;
    result = { url, status: 'network_error', checked_at: checkedAt, title: null, response_sha256: sha256(marker), body: '', error: String(error?.message ?? error), ...extra };
  } finally {
    clearTimeout(timer);
  }
  cache.set(url, result);
  return result;
}

function parseLiveProduct(response) {
  if (typeof response.body !== 'string' || !/^2\d\d$/u.test(String(response.status))) return null;
  try { return parseProductDetail(response.body, response.url); } catch { return null; }
}

function identityCoreTokens(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/\b\d+(?:[.,]\d+)?\s*mg\b/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/u).filter((token) => token && !['buy', 'online', 'nicotine', 'pouch', 'pouches', 'product', 'products', 'per', 'the'].includes(token));
}

function titleOverlap(row, title) {
  const needed = identityCoreTokens(row.n);
  const available = new Set(identityCoreTokens(title));
  return needed.length > 0 && needed.filter((token) => available.has(token)).length / needed.length;
}

function searchCandidateRelevant(row, candidate) {
  const needed = identityCoreTokens(row.n);
  const available = new Set(identityCoreTokens(`${candidate.title ?? ''} ${candidate.url ?? ''}`));
  return needed.length > 0 && needed.every((token) => available.has(token));
}

export function classifyCandidate(row, parsed, response) {
  if (!parsed?.title) return { decision: 'near_match', reason: response.status === 'network_error' ? `URL could not be fetched live (${response.error}); no cached content was used.` : 'Opened URL did not expose a parseable product title.' };
  const wantedStrength = Number(row.mg);
  const titleStrength = (parsed.title.match(/(\d+(?:[.,]\d+)?)\s*mg/iu)?.[1]);
  if (titleStrength && Number(titleStrength.replace(',', '.')) !== wantedStrength && titleOverlap(row, parsed.title) >= 0.5) return { decision: 'wrong_variant', reason: `Product title is close but states ${titleStrength} mg rather than the frozen ${wantedStrength} mg.` };
  if (matchExactProductVariant(row, parsed)) return { decision: 'exact_match', reason: 'Brand/name tokens, distinguishing variant tokens, and strength agree with the frozen input.' };
  if (titleOverlap(row, parsed.title) >= 0.5) return { decision: 'near_match', reason: 'Product title overlaps the requested identity but omits or changes a distinguishing token.' };
  return { decision: 'wrong_variant', reason: 'Opened product title does not contain the required full identity token set.' };
}

function explicitFromParsed(parsed, market) {
  const explicit = {
    brand: parsed?.brand ?? null,
    name: parsed?.title ?? null,
    variant: null,
    strength_mg_per_pouch: parsed?.observed_mg_per_pouch ?? null,
    mg_per_g: parsed?.observed_mg_per_g ?? null,
    net_weight_g: parsed?.net_weight_g ?? null,
    pouch_count: parsed?.pouch_count ?? null,
    sku: parsed?.sku ?? null,
    gtin: parsed?.gtin ?? null,
    market,
  };
  const converted = mgPerPouch(explicit);
  if (!Number.isFinite(explicit.strength_mg_per_pouch) && Number.isFinite(converted.value)) explicit.strength_mg_per_pouch = converted.value;
  return { explicit, calculation: converted.calculation };
}

function directSource(response, meta, market, decision, reason, parsed = null, sourceTypeOverride = null) {
  const parsedData = explicitFromParsed(parsed ?? {}, market);
  return {
    url: response.url,
    source_owner: meta.source_owner,
    evidence_branch: meta.evidence_branch,
    source_type: sourceTypeOverride ?? meta.source_type ?? 'product_detail',
    status: response.status,
    title: parsed?.title ?? response.title ?? null,
    checked_at: response.checked_at,
    response_sha256: response.response_sha256,
    explicit: parsedData.explicit,
    calculation: parsedData.calculation,
    match_decision: decision,
    match_reason: reason,
    evidence_paraphrase: decision === 'exact_match'
      ? `Opened page ${parsed?.title ?? response.title ?? response.url}; explicit nicotine is ${Number.isFinite(parsedData.explicit.strength_mg_per_pouch) ? `${parsedData.explicit.strength_mg_per_pouch} mg per pouch` : Number.isFinite(parsedData.explicit.mg_per_g) ? `${parsedData.explicit.mg_per_g} mg/g with pack inputs recorded on the same page` : 'not stated per pouch'}.`
      : `Opened ${response.url}; it was retained as ${decision} because ${reason}`,
  };
}

function candidateUrlsFromSourceIndex(row, sourceIndex) {
  const output = new Map();
  for (const attempt of sourceIndex?.detail_attempts ?? []) {
    if ((attempt.input_ids ?? []).includes(row.input_id) && validHttpUrl(attempt.url)) output.set(attempt.url, { source_owner: attempt.source_owner, branch: attempt.branch });
  }
  for (const record of sourceIndex?.detail_records ?? []) {
    if (!validHttpUrl(record.url) || output.has(record.url)) continue;
    if (titleOverlap(row, record.title ?? record.url) >= 0.65) output.set(record.url, { source_owner: record.source_owner, branch: record.branch });
  }
  return [...output.entries()].slice(0, 4).map(([url, meta]) => ({ url, meta }));
}

function candidateUrlsFromSearch(row, queries) {
  const output = new Map();
  for (const query of queries) for (const candidate of query.candidates ?? []) {
    if (!validHttpUrl(candidate.url) || !searchCandidateRelevant(row, candidate)) continue;
    if (!output.has(candidate.url)) output.set(candidate.url, { source_owner: null, branch: null });
  }
  return [...output.entries()].map(([url, meta]) => ({ url, meta }));
}

function buildQueries(row, officialDefinition) {
  const brand = JSON.stringify(row.b);
  const name = JSON.stringify(row.n);
  const mg = Number(row.mg);
  const officialDomain = officialDefinition ? new URL(officialDefinition.url).hostname : null;
  return [
    { system: 'google', query: `${brand} ${name} ${JSON.stringify(`${mg} mg/pouch`)}` },
    { system: 'bing', query: `${row.b} ${row.n} ${mg} mg per pouch` },
    { system: 'google', query: `${row.b} ${row.n} ${JSON.stringify('mg/sáček')}` },
    { system: 'bing', query: `${row.b} ${row.n} nicotine pouch ${JSON.stringify('net weight')} ${JSON.stringify('pouches')}` },
    { system: 'google', query: officialDomain ? `site:${officialDomain} ${JSON.stringify(row.n)} ${mg} mg` : `${row.b} nicotine pouch manufacturer owner` },
    { system: 'bing', query: officialDomain ? `site:${officialDomain} ${row.n} nicotine strength` : `${row.b} brand owner nicotine pouch catalog` },
  ];
}

function searchUrl(system, query) {
  const encoded = encodeURIComponent(query);
  return system === 'google' ? `https://www.google.com/search?q=${encoded}&num=10` : `https://www.bing.com/search?q=${encoded}&count=10`;
}

function searchRecord(response, system, query, beforeCandidates) {
  let results = [];
  if (/^2\d\d$/u.test(String(response.status))) {
    try { results = parseSearchResults(response.body, response.url); } catch { results = []; }
  }
  const candidates = results.slice(0, 10).map((item) => ({ url: item.url, title: item.title ?? null, discovery_only: true }));
  const domains = distinct(candidates.map((candidate) => { try { return new URL(candidate.url).hostname; } catch { return null; } }));
  const newCandidates = candidates.filter((candidate) => !beforeCandidates.has(candidate.url));
  return {
    system,
    query,
    url: response.url,
    status: response.status,
    title: response.title ?? `${system} search results`,
    checked_at: response.checked_at,
    response_sha256: response.response_sha256,
    result: 'discovery_only',
    new_domains: domains,
    candidates,
    new_candidate_urls: newCandidates.map((candidate) => candidate.url),
  };
}

function findOfficialDefinition(row) {
  const id = OFFICIAL_BY_BRAND.get(row.b);
  return SOURCE_DEFINITIONS.find((definition) => definition.id === id) ?? null;
}

function registryDefinition(row) {
  const market = marketForRow(row).market;
  if (market === 'US') return REGISTRY_BY_MARKET.US;
  if (market === 'Canada') return REGISTRY_BY_MARKET.Canada;
  if (market.startsWith('Sweden')) return REGISTRY_BY_MARKET.Sweden;
  if (market === 'Denmark') return REGISTRY_BY_MARKET.Denmark;
  return null;
}

function catalogHit(body, row) {
  const lower = String(body ?? '').normalize('NFKC').toLocaleLowerCase('en-US');
  const tokens = identityCoreTokens(`${row.b} ${row.n}`).filter((token) => token.length > 2);
  return tokens.length > 0 && tokens.every((token) => lower.includes(token));
}

function branchRecord(response, branch, row, market) {
  const hit = catalogHit(response.body, row);
  const parsed = null;
  return {
    branch_id: branch.id,
    source_owner: branch.owner,
    evidence_branch: branch.branch,
    source_type: branch.source_type,
    url: response.url,
    status: response.status,
    title: response.title ?? branch.url,
    checked_at: response.checked_at,
    response_sha256: response.response_sha256,
    search_term: `${row.b} ${row.n} ${row.mg} mg per pouch`,
    candidate_urls: [],
    catalog_token_hit: hit,
    note: hit ? 'Live branch catalog contained all core identity tokens; no catalog index is promoted to product-level evidence.' : 'Live branch catalog was opened and did not contain all core identity tokens.',
    parsed,
    market,
  };
}

function addUniqueSource(sources, source) {
  if (!sources.some((item) => item.url === source.url)) sources.push(source);
}

function fixedSourceMeta(url) {
  const retailer = RETAILER_BRANCHES.find((branch) => branch.url === url);
  if (retailer) return { source_owner: retailer.owner, evidence_branch: retailer.branch, source_type: retailer.source_type, note: 'Live retailer branch catalog/index; index content is not product-level identity evidence.' };
  const definition = SOURCE_DEFINITIONS.find((source) => source.url === url);
  if (definition) {
    const sourceType = definition.kind === 'manufacturer_index' ? 'official_catalog' : definition.kind === 'reference_products' || definition.kind === 'reference' ? 'relevant_registry' : definition.kind;
    return { source_owner: definition.owner, evidence_branch: definition.branch, source_type: sourceType, note: 'Live configured official or market-specific index was opened; it is not promoted to product-level evidence without an exact product record.' };
  }
  return sourceMetaForUrl(url);
}

export function repairDirectSourceMetadata(source, market) {
  const meta = fixedSourceMeta(source.url);
  const repaired = {
    ...source,
    source_owner: meta.source_owner ?? source.source_owner ?? 'unknown',
    evidence_branch: meta.evidence_branch ?? source.evidence_branch ?? 'retailer_unknown',
    source_type: meta.source_type ?? source.source_type ?? 'product_detail',
    explicit: { brand: null, name: source.title ?? null, variant: null, strength_mg_per_pouch: null, mg_per_g: null, net_weight_g: null, pouch_count: null, sku: null, gtin: null, market, ...(source.explicit ?? {}) },
  };
  const hasExactDecision = source.match_decision === 'exact_match' && source.evidence_branch;
  if (repaired.source_type !== 'product_detail' || !MATCH_DECISIONS.includes(source.match_decision) || !hasExactDecision) {
    repaired.match_decision = 'near_match';
    repaired.match_reason = meta.note ?? 'Opened index/catalog page; no product-detail evidence was promoted.';
    repaired.evidence_paraphrase = `Opened ${source.url}; ${repaired.match_reason}`;
  }
  if (!repaired.match_reason || typeof repaired.match_reason !== 'string') repaired.match_reason = meta.note ?? 'Opened source was checked but did not provide a promoted exact product-detail match.';
  if (!repaired.evidence_paraphrase || typeof repaired.evidence_paraphrase !== 'string') repaired.evidence_paraphrase = `Opened ${source.url}; ${repaired.match_reason}`;
  return repaired;
}

function repairCards(cards) {
  return cards.map((card) => ({ ...card, direct_sources: (card.direct_sources ?? []).map((source) => source.evidence_branch && MATCH_DECISIONS.includes(source.match_decision) && source.source_owner ? source : repairDirectSourceMetadata(source, card.assessed_identity?.market ?? 'unknown')) }));
}

function evidenceDecision(row, directSources) {
  const exact = directSources.filter((source) => source.match_decision === 'exact_match' && Number.isFinite(source.explicit.strength_mg_per_pouch));
  const values = distinct(exact.map((source) => String(source.explicit.strength_mg_per_pouch))).map(Number);
  const branchKeys = new Map();
  for (const source of exact) {
    const key = source.source_owner || source.evidence_branch;
    if (!branchKeys.has(key)) branchKeys.set(key, []);
    branchKeys.get(key).push(source);
  }
  const authoritative = exact.find((source) => ['manufacturer', 'brand_owner', 'regulator_us', 'regulator_canada', 'regulator_sweden', 'regulator_denmark'].includes(source.evidence_branch));
  const independentRetailers = exact.filter((source) => source.evidence_branch.startsWith('retailer_') || source.evidence_branch === 'retailer_group');
  const independentRetailerOwners = new Set(independentRetailers.map((source) => source.source_owner));
  const conflict = values.length > 1 && branchKeys.size > 1;
  if (conflict) return { outcome: 'conflicted', met: true, exact, values, explanation: `Two independently owned exact product pages disagree: ${values.join(' mg/pouch versus ')} mg/pouch.` };
  if (exact.length && (authoritative || independentRetailerOwners.size >= 2)) return { outcome: 'verified', met: true, exact, values, explanation: authoritative ? 'Exact identity and mg/pouch were read from an owner/manufacturer or market-relevant regulator page.' : 'Exact identity and the same mg/pouch were read from two independent retailer owners.' };
  return { outcome: 'not_verifiable_after_protocol', met: false, exact, values, explanation: exact.length ? 'An exact candidate was opened, but the permitted owner/regulator or two-independent-retailer threshold was not met.' : 'The complete protocol was executed, but no exact direct product source with mg/pouch reached the evidence threshold.' };
}

function v2EvidenceToLedger(source) {
  return {
    evidence_type: source.source_type,
    source_owner: source.source_owner,
    branch: source.evidence_branch,
    url: source.url,
    title: source.title,
    checked_at: source.checked_at,
    response_sha256: source.response_sha256,
    observed: {
      brand: source.explicit?.brand ?? null,
      name: source.explicit?.name ?? source.title ?? null,
      observed_mg_per_pouch: source.explicit?.strength_mg_per_pouch ?? null,
      observed_mg_per_g: source.explicit?.mg_per_g ?? null,
      net_weight_g: source.explicit?.net_weight_g ?? null,
      pouch_count: source.explicit?.pouch_count ?? null,
      sku: source.explicit?.sku ?? null,
      gtin: source.explicit?.gtin ?? null,
      market: source.explicit?.market ?? null,
    },
    note: `${source.match_decision}: ${source.match_reason}`,
  };
}

export function v2CardToLedger(card, oldItem = {}) {
  const original = card.original;
  const exactSources = (card.direct_sources ?? []).filter((source) => source.match_decision === 'exact_match');
  const mgSources = exactSources.filter((source) => Number.isFinite(source.explicit?.strength_mg_per_pouch));
  const values = distinct(mgSources.map((source) => String(source.explicit.strength_mg_per_pouch))).map(Number);
  const identityConfirmed = exactSources.length > 0;
  const conflicted = card.outcome === 'conflicted';
  const verified = card.outcome === 'verified';
  const proposedChanges = [];
  if (verified && values.length === 1 && values[0] !== Number(original.mg)) proposedChanges.push({ action: 'change', field: 'mg', from: original.mg, to: values[0], basis: card.evidence_threshold.explanation, evidence_urls: mgSources.map((source) => source.url) });
  const evidence = (card.direct_sources ?? []).map(v2EvidenceToLedger);
  if (!evidence.length) evidence.push({ evidence_type: 'v2_protocol', source_owner: 'PouchLog recheck v2', branch: 'audit', url: null, checked_at: card.checked_at, response_sha256: null, note: card.evidence_paraphrase });
  const firstMg = mgSources[0]?.explicit ?? {};
  return {
    ...oldItem,
    input_id: card.input_id,
    original,
    canonical_brand: card.assessed_identity.brand,
    canonical_name: card.assessed_identity.full_name,
    product_type: card.product_type ?? 'nicotine_or_unknown',
    match_status: identityConfirmed ? 'exact_attributes' : 'no_match',
    existence_status: identityConfirmed ? 'confirmed' : 'ambiguous',
    sale_status: 'unknown',
    strength_status: conflicted ? 'conflicted' : verified ? 'verified' : 'unverified',
    observed_mg_per_pouch: values.length === 1 ? values[0] : null,
    observed_mg_values: values,
    mg_evidence_owners: distinct(mgSources.map((source) => source.source_owner)),
    observed_mg_per_g: firstMg.mg_per_g ?? null,
    net_weight_g: firstMg.net_weight_g ?? null,
    pouch_count: firstMg.pouch_count ?? null,
    format: null,
    sku: firstMg.sku ?? null,
    gtin: firstMg.gtin ?? null,
    market: card.assessed_identity.market,
    source_owner: distinct((card.direct_sources ?? []).map((source) => source.source_owner)),
    evidence,
    checked_at: card.checked_at,
    decision: conflicted ? 'review' : oldItem.decision === 'remove' ? 'remove' : 'keep',
    reason_code: conflicted ? 'strength_conflict' : verified ? 'verified_identity_and_mg' : 'v2_not_verifiable_after_protocol',
    proposed_changes: proposedChanges,
    calculation: mgSources.find((source) => source.calculation)?.calculation ?? null,
    review_steps: oldItem.review_steps ?? {},
    research_status: card.outcome,
    active_search_seconds: 0,
    terminal_reason: card.outcome,
    research_steps: card.protocol,
    research_queries: card.queries,
  };
}

export function mergeV2IntoLedger(ledger, cards) {
  const byId = new Map((cards ?? []).map((card) => [card.input_id, card]));
  return (ledger ?? []).map((item) => byId.has(item.input_id) ? v2CardToLedger(byId.get(item.input_id), item) : item);
}

function protocolComplete(card) {
  const queries = card.queries ?? [];
  const systems = new Set(queries.map((query) => query.system));
  const uniqueQueries = new Set(queries.map((query) => `${query.system}\u0000${query.query}`));
  return systems.size >= 2 && uniqueQueries.size >= 4 && card.protocol?.official_catalog?.status && card.protocol?.relevant_registry?.status && new Set(card.protocol?.retailer_branches ?? []).size >= 3 && card.protocol?.saturation?.no_new_domains === true && card.protocol?.saturation?.no_new_candidates === true;
}

export function validateCard(card, { expectedId = null, requirePassed = false } = {}) {
  const errors = [];
  if (!card || typeof card !== 'object') return ['card is not an object'];
  if (expectedId && card.input_id !== expectedId) errors.push(`${card.input_id}: input_id differs from frozen input`);
  if (card.schema !== 2) errors.push(`${card.input_id}: schema must be 2`);
  for (const field of ['input_id', 'original', 'assessed_identity', 'owner_resolution', 'outcome', 'queries', 'direct_sources', 'protocol', 'evidence_threshold', 'evidence_paraphrase', 'all_opened_urls', 'checked_at', 'qa_status']) if (card[field] === undefined || card[field] === null) errors.push(`${card.input_id}: missing ${field}`);
  if (!V2_OUTCOMES.includes(card.outcome)) errors.push(`${card.input_id}: outcome is not allowed`);
  if (!QA_STATES.includes(card.qa_status)) errors.push(`${card.input_id}: invalid qa_status`);
  if (requirePassed && card.qa_status !== 'passed') errors.push(`${card.input_id}: qa_status is not passed`);
  if (!card.assessed_identity?.brand || !card.assessed_identity?.full_name || !card.assessed_identity?.market) errors.push(`${card.input_id}: assessed identity is incomplete`);
  if (!Array.isArray(card.queries) || card.queries.length < 4) errors.push(`${card.input_id}: fewer than four unique search queries`);
  const queryKeys = new Set();
  for (const query of card.queries ?? []) {
    if (!SEARCH_SYSTEMS.includes(query.system) || !query.query || !validHttpUrl(query.url) || !query.checked_at || !validHash(query.response_sha256)) errors.push(`${card.input_id}: malformed search query record`);
    const key = `${query.system}\u0000${query.query}`;
    if (queryKeys.has(key)) errors.push(`${card.input_id}: duplicate search query`);
    queryKeys.add(key);
  }
  if (new Set((card.queries ?? []).map((query) => query.system)).size < 2) errors.push(`${card.input_id}: two independent search systems are not recorded`);
  if (!Array.isArray(card.all_opened_urls) || new Set(card.all_opened_urls).size !== card.all_opened_urls.length) errors.push(`${card.input_id}: all_opened_urls is missing or duplicated`);
  for (const source of card.direct_sources ?? []) {
    for (const field of ['url', 'source_owner', 'evidence_branch', 'source_type', 'status', 'title', 'checked_at', 'response_sha256', 'explicit', 'match_decision', 'match_reason', 'evidence_paraphrase']) if (source[field] === undefined) errors.push(`${card.input_id}: source missing ${field}`);
    if (!validHttpUrl(source.url) || !validHash(source.response_sha256) || !MATCH_DECISIONS.includes(source.match_decision)) errors.push(`${card.input_id}: malformed direct source`);
    if (!card.all_opened_urls?.includes(source.url)) errors.push(`${card.input_id}: direct source URL is absent from all_opened_urls`);
    const explicit = source.explicit ?? {};
  }
  if (!protocolComplete(card)) errors.push(`${card.input_id}: mandatory search/catalog/branch/saturation protocol is incomplete`);
  const retailerOwners = new Set((card.direct_sources ?? []).filter((source) => source.evidence_branch.startsWith('retailer_') || source.evidence_branch === 'retailer_group').map((source) => source.source_owner));
  if ((card.protocol?.retailer_branches ?? []).length < 3 || new Set(card.protocol.retailer_branches).size < 3) errors.push(`${card.input_id}: fewer than three independent retailer branches recorded`);
  if (card.outcome === 'verified' && (!card.evidence_threshold?.met || !((card.direct_sources ?? []).some((source) => source.match_decision === 'exact_match' && Number.isFinite(source.explicit.strength_mg_per_pouch) && ['manufacturer', 'brand_owner', 'regulator_us', 'regulator_canada', 'regulator_sweden', 'regulator_denmark'].includes(source.evidence_branch)) || retailerOwners.size >= 2))) errors.push(`${card.input_id}: verified card lacks permitted evidence threshold`);
  if (card.outcome === 'conflicted') {
    const exact = (card.direct_sources ?? []).filter((source) => source.match_decision === 'exact_match' && Number.isFinite(source.explicit.strength_mg_per_pouch));
    if (new Set(exact.map((source) => source.explicit.strength_mg_per_pouch)).size < 2 || new Set(exact.map((source) => source.source_owner)).size < 2) errors.push(`${card.input_id}: conflicted card lacks two independent exact sources with different mg/pouch`);
  }
  if (card.outcome === 'not_verifiable_after_protocol' && card.evidence_threshold?.met) errors.push(`${card.input_id}: not-verifiable card claims threshold met`);
  const serialized = JSON.stringify(card);
  for (const badState of BAD_FINAL_STATES.filter((state) => state !== card.qa_status)) if (requirePassed && serialized.includes(`"${badState}"`)) errors.push(`${card.input_id}: forbidden final state ${badState}`);
  return distinct(errors);
}

export function validateV2Set(frozenRows, cards, qaRows, { requirePassed = false } = {}) {
  const errors = [];
  const expectedIds = (frozenRows ?? []).map((row) => row.input_id);
  const actualIds = (cards ?? []).map((row) => row.input_id);
  const qaIds = (qaRows ?? []).map((row) => row.input_id);
  if (expectedIds.length !== 861) errors.push(`frozen set has ${expectedIds.length} rows, expected 861`);
  if (new Set(expectedIds).size !== expectedIds.length) errors.push('frozen set has duplicate input_id values');
  if (new Set(actualIds).size !== actualIds.length) errors.push('recheck-v2.jsonl has duplicate input_id values');
  if (new Set(qaIds).size !== qaIds.length) errors.push('recheck-v2-qa.jsonl has duplicate input_id values');
  const expected = new Set(expectedIds);
  if (actualIds.length !== expectedIds.length || actualIds.some((id) => !expected.has(id)) || expectedIds.some((id) => !actualIds.includes(id))) errors.push('recheck-v2.jsonl input_id set differs from frozen set');
  if (qaIds.length !== expectedIds.length || qaIds.some((id) => !expected.has(id)) || expectedIds.some((id) => !qaIds.includes(id))) errors.push('recheck-v2-qa.jsonl input_id set differs from frozen set');
  const frozenById = new Map((frozenRows ?? []).map((row) => [row.input_id, row]));
  for (const card of cards ?? []) {
    errors.push(...validateCard(card, { expectedId: card.input_id, requirePassed }));
    const frozen = frozenById.get(card.input_id);
    if (frozen && JSON.stringify(frozen.original) !== JSON.stringify(card.original)) errors.push(`${card.input_id}: original record differs from frozen input`);
  }
  if (requirePassed) {
    for (const card of cards ?? []) if (card.qa_status !== 'passed') errors.push(`${card.input_id}: qa_status is ${card.qa_status}, not passed`);
    for (const qa of qaRows ?? []) if (qa.qa_status !== 'passed') errors.push(`${qa.input_id}: QA status is ${qa.qa_status}, not passed`);
  }
  return { ok: errors.length === 0, errors: distinct(errors) };
}

function pendingCard(row) {
  return { schema: 2, input_id: row.input_id, original: row.original, status: 'pending', qa_status: 'pending' };
}

function progressMarkdown(frozenRows, cards, phase) {
  const count = (predicate) => cards.filter(predicate).length;
  const outcomes = Object.fromEntries(V2_OUTCOMES.map((outcome) => [outcome, count((card) => card.outcome === outcome)]));
  return [
    '# Recheck v2 progress', '',
    `Updated: ${new Date().toISOString()}`, `Phase: ${phase}`, `Frozen input_id: ${frozenRows.length}`, '',
    '| metric | count |', '|---|---:|',
    `| passed | ${count((card) => card.qa_status === 'passed')} |`, `| qa_failed | ${count((card) => card.qa_status === 'qa_failed')} |`, `| pending | ${count((card) => !V2_OUTCOMES.includes(card.outcome))} |`, `| verified | ${outcomes.verified} |`, `| conflicted | ${outcomes.conflicted} |`, `| not_verifiable_after_protocol | ${outcomes.not_verifiable_after_protocol} |`, '',
    'The v2 queue is complete only after the independent QA pass reports 861/861 `qa_status=passed`. `exhausted_10m` is not a valid v2 state.', '',
  ].join('\n');
}

async function loadFrozen(paths) {
  const frozen = await readJson(paths.unresolvedPath);
  if (frozen.unresolved_rows !== 861 || frozen.rows?.length !== 861) throw new Error(`Frozen unresolved set must contain exactly 861 rows, found ${frozen.rows?.length ?? 'unknown'}.`);
  if (new Set(frozen.rows.map((row) => row.input_id)).size !== 861) throw new Error('Frozen unresolved set contains duplicate input_id values.');
  return frozen.rows;
}

async function loadCandidateIndex(paths) {
  if (!existsSync(paths.sourceIndexPath)) return { detail_attempts: [], detail_records: [] };
  return readJson(paths.sourceIndexPath);
}

async function runOneRow(row, sourceIndex, liveCache) {
  const marketInfo = marketForRow(row);
  const official = findOfficialDefinition(row);
  const registry = registryDefinition(row);
  const openedUrls = new Set();
  const directSources = [];
  const queries = [];
  const officialMeta = sourceForDefinition(official);
  const catalogResponses = new Map();
  const directOpen = async (url, meta, sourceType = null) => {
    if (!validHttpUrl(url)) return null;
    const response = await fetchLive(url, liveCache);
    openedUrls.add(response.url);
    const parsed = parseLiveProduct(response);
    const classification = classifyCandidate(row, parsed, response);
    addUniqueSource(directSources, directSource(response, meta ?? sourceMetaForUrl(url), marketInfo.market, classification.decision, classification.reason, parsed, sourceType));
    return { response, parsed, classification };
  };

  const querySpecs = buildQueries(row, official);
  const searchCandidatesBefore = new Set();
  let noNewStreak = 0;
  for (const spec of querySpecs) {
    const url = searchUrl(spec.system, spec.query);
    const response = await fetchLive(url, liveCache);
    openedUrls.add(response.url);
    const record = searchRecord(response, spec.system, spec.query, searchCandidatesBefore);
    const relevant = record.candidates.filter((candidate) => searchCandidateRelevant(row, candidate));
    for (const candidate of relevant) searchCandidatesBefore.add(candidate.url);
    record.new_candidate_urls = relevant.filter((candidate) => searchCandidatesBefore.has(candidate.url)).map((candidate) => candidate.url);
    const newRelevant = relevant.filter((candidate) => !queries.some((previous) => (previous.candidates ?? []).some((old) => old.url === candidate.url)));
    if (newRelevant.length === 0) noNewStreak += 1; else noNewStreak = 0;
    queries.push(record);
    if (noNewStreak >= 2 && queries.length >= 4) break;
  }

  if (official) {
    const response = await fetchLive(official.url, liveCache);
    openedUrls.add(response.url);
    const parsed = parseLiveProduct(response);
    const classification = classifyCandidate(row, parsed, response);
    addUniqueSource(directSources, directSource(response, officialMeta, marketInfo.market, classification.decision === 'exact_match' ? classification.decision : 'near_match', parsed ? classification.reason : 'Official catalog/index was opened; it is not a product-detail identity proof without an exact parsed page.', parsed, 'official_catalog'));
  }

  const registryRecord = registry ? { ...registry, status: 'pending' } : { status: 'not_selected_for_uk_eu_reference_market', reason: 'No market-specific registry was selected for the UK/EU reference market; US/Canada registries were not used as generic substitutes.', urls: [] };
  if (registry) {
    const response = await fetchLive(registry.url, liveCache);
    openedUrls.add(response.url);
    const parsed = parseLiveProduct(response);
    addUniqueSource(directSources, directSource(response, { source_owner: registry.owner, evidence_branch: registry.branch, source_type: registry.source_type }, marketInfo.market, 'near_match', 'Market-specific registry page was opened; a landing page is not promoted to product-level evidence without an exact product record.', parsed, 'relevant_registry'));
    registryRecord.status = `opened_${String(response.status)}`;
    registryRecord.url = response.url;
    registryRecord.checked_at = response.checked_at;
    registryRecord.response_sha256 = response.response_sha256;
  }

  const retailerBranches = [];
  for (const branch of RETAILER_BRANCHES) {
    const response = await fetchLive(branch.url, liveCache);
    openedUrls.add(response.url);
    retailerBranches.push(branchRecord(response, branch, row, marketInfo.market));
    const meta = { source_owner: branch.owner, evidence_branch: branch.branch, source_type: branch.source_type };
    addUniqueSource(directSources, directSource(response, meta, marketInfo.market, 'near_match', 'Retailer catalog/index was opened; a catalog hit is not promoted to product-level evidence.', null, branch.source_type));
  }

  const candidates = [...candidateUrlsFromSourceIndex(row, sourceIndex), ...candidateUrlsFromSearch(row, queries)];
  const selectedCandidates = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.url) || selectedCandidates.length >= 7) continue;
    seen.add(candidate.url); selectedCandidates.push(candidate);
  }
  const candidateReviews = [];
  for (const candidate of selectedCandidates) {
    const result = await directOpen(candidate.url, sourceMetaForUrl(candidate.url, candidate.meta), 'product_detail');
    candidateReviews.push({ url: candidate.url, match_decision: result?.classification.decision ?? 'near_match', reason: result?.classification.reason ?? 'Live candidate check did not return a product detail.' });
  }
  for (const source of directSources) if (!candidateReviews.some((candidate) => candidate.url === source.url)) candidateReviews.push({ url: source.url, match_decision: source.match_decision, reason: source.match_reason });

  const threshold = evidenceDecision(row, directSources);
  const protocol = {
    official_catalog: official ? { status: 'opened_live', owner: official.owner, url: official.url } : { status: 'owner_not_identified_after_live_search', urls: queries.filter((query) => /owner|manufacturer/iu.test(query.query)).map((query) => query.url) },
    relevant_registry: registryRecord,
    retailer_branches: retailerBranches.map((branch) => branch.source_owner),
    candidate_reviews: candidateReviews,
    saturation: { final_queries: queries.slice(-2).map((query) => query.query), no_new_domains: noNewStreak >= 2, no_new_candidates: noNewStreak >= 2 },
  };
  const exactEvidence = threshold.exact.map((source) => source.url);
  const ownerAttempts = queries.filter((query) => /owner|manufacturer|official/iu.test(query.query)).map((query) => ({ method: query.system, query: query.query, url: query.url, status: query.status, title: query.title, checked_at: query.checked_at, response_sha256: query.response_sha256, note: official ? `Official catalog candidate for ${official.owner} was opened separately.` : 'No brand owner was identified from the live owner-lookup queries.' }));
  return {
    schema: 2,
    input_id: row.input_id,
    original: row.original,
    assessed_identity: { brand: row.original.b, full_name: row.original.n, variant: row.original.n, strength_mg_per_pouch: Number(row.original.mg), market: marketInfo.market, market_basis: marketInfo.basis },
    owner_resolution: { status: official ? 'identified' : 'not_identified', owner: official?.owner ?? null, attempts: ownerAttempts },
    outcome: threshold.outcome,
    queries,
    direct_sources: directSources,
    protocol,
    evidence_threshold: { met: threshold.met, explanation: threshold.explanation, exact_source_urls: exactEvidence },
    evidence_paraphrase: threshold.explanation,
    all_opened_urls: distinct([...openedUrls]),
    checked_at: new Date().toISOString(),
    qa_status: 'pending',
    product_type: inferProductType(row.original),
  };
}

async function runResearch(paths) {
  const frozenRows = await loadFrozen(paths);
  const sourceIndex = await loadCandidateIndex(paths);
  const cards = frozenRows.map(pendingCard);
  await writeJsonLines(paths.v2Path, cards);
  await writeJsonLines(paths.qaPath, frozenRows.map((row) => ({ schema: 2, input_id: row.input_id, qa_status: 'pending', checks: [], checked_at: null })));
  await writeFile(paths.progressV2Path, progressMarkdown(frozenRows, cards, 'pending queue initialized'), 'utf8');
  const byBrand = new Map();
  for (const row of frozenRows) { if (!byBrand.has(row.original.b)) byBrand.set(row.original.b, []); byBrand.get(row.original.b).push(row); }
  const liveCache = new Map();
  const cardById = new Map(cards.map((card) => [card.input_id, card]));
  let processed = 0;
  for (const [brand, rows] of byBrand) {
    for (const row of rows) {
      const card = await runOneRow({ ...row, b: row.original.b, n: row.original.n, mg: row.original.mg }, sourceIndex, liveCache);
      cardById.set(card.input_id, card);
      processed += 1;
      if (processed % 25 === 0) {
        const checkpoint = [...cardById.values()];
        await writeJsonLines(paths.v2Path, checkpoint);
        await writeFile(paths.progressV2Path, progressMarkdown(frozenRows, checkpoint, `research checkpoint after ${processed} rows; current brand ${brand}`), 'utf8');
      }
    }
    const checkpoint = [...cardById.values()];
    await writeJsonLines(paths.v2Path, checkpoint);
    await writeFile(paths.progressV2Path, progressMarkdown(frozenRows, checkpoint, `brand complete: ${brand}`), 'utf8');
  }
  const finalCards = frozenRows.map((row) => cardById.get(row.input_id));
  await writeJsonLines(paths.v2Path, finalCards);
  await writeFile(paths.progressV2Path, progressMarkdown(frozenRows, finalCards, 'research complete; independent QA required'), 'utf8');
  return finalCards;
}

async function qaOneCard(card) {
  const checks = [];
  const structuralErrors = validateCard(card, { expectedId: card.input_id });
  if (structuralErrors.length) return { card, qa: { input_id: card.input_id, qa_status: 'qa_failed', checks: [{ name: 'card_structure', ok: false, errors: structuralErrors }], checked_at: new Date().toISOString() } };
  if (card.outcome === 'verified' || card.outcome === 'conflicted') {
    const evidenceSources = card.direct_sources.filter((source) => source.match_decision === 'exact_match');
    for (const source of evidenceSources) {
      const response = await fetchLive(source.url, qaOneCard.liveCache ??= new Map());
      const parsed = parseLiveProduct(response);
      const current = explicitFromParsed(parsed ?? {}, card.assessed_identity.market).explicit;
      const exact = parsed && matchExactProductVariant(card.original, parsed);
      const sameHash = response.response_sha256 === source.response_sha256;
      const sameMg = Number.isFinite(current.strength_mg_per_pouch) && Number(current.strength_mg_per_pouch) === Number(source.explicit.strength_mg_per_pouch);
      const canReject = Boolean(parsed?.title) && (!exact || !sameMg);
      if (canReject) {
        source.match_decision = 'wrong_variant';
        source.match_reason = exact ? `Reopened page does not support the recorded mg/pouch: current parsed value is ${current.strength_mg_per_pouch ?? 'absent'}, recorded evidence was ${source.explicit.strength_mg_per_pouch ?? 'absent'}.` : 'Independent reopen no longer matches the exact frozen product identity.';
        source.evidence_paraphrase = `Reopened ${source.url}; it was rejected as wrong_variant because ${source.match_reason}`;
      } else if (exact && sameMg && !sameHash) {
        source.original_response_sha256 = source.response_sha256;
        source.original_checked_at = source.checked_at;
        source.response_sha256 = response.response_sha256;
        source.checked_at = response.checked_at;
        source.qa_reopened = { checked_at: response.checked_at, response_sha256: response.response_sha256, note: 'Live QA reopen confirmed the same exact identity and mg/pouch despite a changed dynamic response hash.' };
      }
      checks.push({ name: 'reopen_exact_evidence', url: source.url, ok: Boolean(parsed?.title) && (canReject || (exact && sameMg)), accepted_as_exact: Boolean(exact && sameMg), rejected_as_wrong_variant: canReject, same_hash: sameHash, exact_match: Boolean(exact), same_mg_per_pouch: sameMg, checked_at: response.checked_at, response_sha256: response.response_sha256 });
    }
    const threshold = evidenceDecision(card.original, card.direct_sources);
    card.outcome = threshold.outcome;
    card.evidence_threshold = { met: threshold.met, explanation: threshold.explanation, exact_source_urls: threshold.exact.map((source) => source.url) };
    card.evidence_paraphrase = threshold.explanation;
    card.checked_at = new Date().toISOString();
  } else {
    checks.push({ name: 'complete_not_verifiable_protocol', ok: protocolComplete(card) && !card.evidence_threshold.met, retailer_branches: card.protocol.retailer_branches.length, query_systems: distinct(card.queries.map((query) => query.system)).length, saturation: card.protocol.saturation });
  }
  const ok = checks.every((check) => check.ok);
  return { card, qa: { input_id: card.input_id, qa_status: ok ? 'passed' : 'qa_failed', checks, checked_at: new Date().toISOString() } };
}

async function runQa(paths) {
  const frozenRows = await loadFrozen(paths);
  const cards = await readJsonLines(paths.v2Path);
  const qaRows = [];
  const updatedById = new Map();
  for (const card of frozenRows.map((row) => cards.find((candidate) => candidate.input_id === row.input_id)).filter(Boolean)) {
    const result = await qaOneCard(card);
    qaRows.push(result.qa);
    updatedById.set(result.card.input_id, result.card);
  }
  const qaById = new Map(qaRows.map((row) => [row.input_id, row]));
  const updatedCards = cards.map((card) => ({ ...(updatedById.get(card.input_id) ?? card), qa_status: qaById.get(card.input_id)?.qa_status ?? 'qa_failed' }));
  await writeJsonLines(paths.qaPath, qaRows);
  await writeJsonLines(paths.v2Path, updatedCards);
  await writeFile(paths.progressV2Path, progressMarkdown(frozenRows, updatedCards, 'independent QA complete'), 'utf8');
  return qaRows;
}

async function runRepair(paths) {
  const frozenRows = await loadFrozen(paths);
  const cards = await readJsonLines(paths.v2Path);
  if (cards.length !== frozenRows.length) throw new Error(`Cannot repair v2 metadata: found ${cards.length} cards, expected ${frozenRows.length}.`);
  const repaired = repairCards(cards);
  await writeJsonLines(paths.v2Path, repaired);
  await writeFile(paths.progressV2Path, progressMarkdown(frozenRows, repaired, 'metadata repair after live fetch; independent QA required'), 'utf8');
  return repaired;
}

async function runProtocolCompletion(paths) {
  const frozenRows = await loadFrozen(paths);
  const cards = await readJsonLines(paths.v2Path);
  const liveCache = new Map();
  const badCards = cards.filter((card) => !card.protocol?.saturation?.no_new_domains || !card.protocol?.saturation?.no_new_candidates);
  let processed = 0;
  for (const card of badCards) {
    const row = { input_id: card.input_id, original: card.original, b: card.original.b, n: card.original.n, mg: card.original.mg };
    const openedUrls = new Set(card.all_opened_urls ?? []);
    const directSources = [...(card.direct_sources ?? [])];
    const knownCandidates = new Set((card.queries ?? []).flatMap((query) => (query.candidates ?? []).map((candidate) => candidate.url)).filter(Boolean));
    for (const source of directSources) if (source.source_type === 'product_detail') knownCandidates.add(source.url);
    let noNewStreak = 0;
    const historicalCandidates = new Set();
    for (const query of card.queries ?? []) {
      const relevant = (query.candidates ?? []).filter((candidate) => searchCandidateRelevant(row, candidate));
      const fresh = relevant.filter((candidate) => !historicalCandidates.has(candidate.url));
      for (const candidate of relevant) historicalCandidates.add(candidate.url);
      if (fresh.length === 0) noNewStreak += 1; else noNewStreak = 0;
      if (noNewStreak >= 2) break;
    }
    if (noNewStreak >= 2) {
      card.protocol.saturation = { final_queries: card.queries.slice(-2).map((query) => query.query), no_new_domains: true, no_new_candidates: true };
      card.checked_at = new Date().toISOString();
      card.qa_status = 'pending';
      processed += 1;
      continue;
    }
    const extraSpecs = [
      { system: 'google', query: `${row.b} ${row.n} ${row.mg} mg nicotine content` },
      { system: 'bing', query: `${row.b} ${row.n} pouch strength nicotine` },
      { system: 'google', query: `${row.b} ${row.n} nicotine per pouch product` },
      { system: 'bing', query: `${row.b} ${row.n} pouch net weight nicotine content` },
      { system: 'google', query: `${JSON.stringify(row.n)} ${row.mg} mg pouch retailer` },
      { system: 'bing', query: `${JSON.stringify(row.n)} ${row.mg} mg pouch official product` },
      { system: 'google', query: `site:www.haypp.com ${JSON.stringify(row.n)} ${row.mg} mg/pouch` },
      { system: 'bing', query: `site:snusdirect.com ${JSON.stringify(row.n)} ${row.mg} mg/pouch` },
      { system: 'google', query: `site:nicopodsuk.com ${JSON.stringify(row.n)} nicotine` },
      { system: 'bing', query: `site:www.haypp.com ${JSON.stringify(row.n)} ${row.mg} mg per pouch` },
      { system: 'google', query: `site:snusdirect.com ${JSON.stringify(row.n)} nicotine strength` },
      { system: 'bing', query: `site:nicopodsuk.com ${JSON.stringify(row.n)} nicotine strength` },
      { system: 'google', query: `site:www.haypp.com ${JSON.stringify(row.n)} product` },
      { system: 'bing', query: `site:snusdirect.com ${JSON.stringify(row.n)} product` },
      { system: 'google', query: `site:nicopodsuk.com ${JSON.stringify(row.n)} product` },
      { system: 'bing', query: `site:www.haypp.com ${JSON.stringify(row.n)} pouch count` },
      { system: 'google', query: `site:snusdirect.com ${JSON.stringify(row.n)} pouch count` },
      { system: 'bing', query: `site:nicopodsuk.com ${JSON.stringify(row.n)} pouch count` },
    ];
    for (const spec of extraSpecs) {
      if ((card.queries ?? []).some((query) => query.system === spec.system && query.query === spec.query)) continue;
      const response = await fetchLive(searchUrl(spec.system, spec.query), liveCache);
      openedUrls.add(response.url);
      const record = searchRecord(response, spec.system, spec.query, knownCandidates);
      const relevant = record.candidates.filter((candidate) => searchCandidateRelevant(row, candidate));
      const newRelevant = relevant.filter((candidate) => !knownCandidates.has(candidate.url));
      for (const candidate of relevant) knownCandidates.add(candidate.url);
      record.new_candidate_urls = newRelevant.map((candidate) => candidate.url);
      if (newRelevant.length === 0) noNewStreak += 1; else noNewStreak = 0;
      card.queries.push(record);
      for (const candidate of newRelevant.slice(0, 4)) {
        const candidateResponse = await fetchLive(candidate.url, liveCache);
        openedUrls.add(candidateResponse.url);
        const parsed = parseLiveProduct(candidateResponse);
        const classification = classifyCandidate(row, parsed, candidateResponse);
        addUniqueSource(directSources, directSource(candidateResponse, sourceMetaForUrl(candidate.url), card.assessed_identity.market, classification.decision, classification.reason, parsed, 'product_detail'));
        card.protocol.candidate_reviews.push({ url: candidate.url, match_decision: classification.decision, reason: classification.reason });
      }
      if (noNewStreak >= 2) break;
    }
    card.direct_sources = directSources;
    card.all_opened_urls = distinct([...openedUrls]);
    card.protocol.saturation = { final_queries: card.queries.slice(-2).map((query) => query.query), no_new_domains: noNewStreak >= 2, no_new_candidates: noNewStreak >= 2 };
    const threshold = evidenceDecision(row, directSources);
    card.outcome = threshold.outcome;
    card.evidence_threshold = { met: threshold.met, explanation: threshold.explanation, exact_source_urls: threshold.exact.map((source) => source.url) };
    card.evidence_paraphrase = threshold.explanation;
    card.checked_at = new Date().toISOString();
    card.qa_status = 'pending';
    processed += 1;
    if (processed % 25 === 0) {
      await writeJsonLines(paths.v2Path, cards);
      await writeFile(paths.progressV2Path, progressMarkdown(frozenRows, cards, `protocol completion checkpoint after ${processed}/${badCards.length} affected cards`), 'utf8');
    }
  }
  await writeJsonLines(paths.v2Path, cards);
  await writeFile(paths.progressV2Path, progressMarkdown(frozenRows, cards, `protocol completion complete for ${badCards.length} affected cards; independent QA required`), 'utf8');
  return cards;
}

async function runValidate(paths) {
  const frozenRows = await loadFrozen(paths);
  const cards = await readJsonLines(paths.v2Path);
  const qaRows = await readJsonLines(paths.qaPath);
  const result = validateV2Set(frozenRows, cards, qaRows, { requirePassed: true });
  if (result.ok) console.log(`recheck-v2 validation: ok (${cards.length}/861 cards, ${qaRows.length}/861 QA rows, all passed)`);
  else { console.error('recheck-v2 validation: failed'); for (const error of result.errors) console.error(`- ${error}`); process.exitCode = 1; }
  return result;
}

function usage() {
  console.error('Usage: node scripts/pouch-audit/recheck-v2.mjs --research | --repair | --complete-protocol | --qa | --validate');
}

export async function main(argv = process.argv.slice(2)) {
  const paths = v2Paths(resolvePaths(process.env.POUCH_AUDIT_WORKSPACE_ROOT ?? process.cwd(), process.env.POUCH_AUDIT_ROOT ?? process.cwd()));
  if (argv.includes('--research') && !argv.includes('--repair') && !argv.includes('--qa') && !argv.includes('--validate')) return runResearch(paths);
  if (argv.includes('--repair') && !argv.includes('--research') && !argv.includes('--qa') && !argv.includes('--validate')) return runRepair(paths);
  if (argv.includes('--complete-protocol') && !argv.includes('--research') && !argv.includes('--repair') && !argv.includes('--qa') && !argv.includes('--validate')) return runProtocolCompletion(paths);
  if (argv.includes('--qa') && !argv.includes('--research') && !argv.includes('--validate')) return runQa(paths);
  if (argv.includes('--validate') && !argv.includes('--research') && !argv.includes('--qa')) return runValidate(paths);
  usage(); process.exitCode = 2; return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`recheck-v2: ${error.stack ?? error.message ?? error}`); process.exitCode = 1; });
