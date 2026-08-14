import { appendRawEvent, readRawEvents, sha256 } from './recheck-v3-schema.mjs';
import { fetchLive, parseSearchResponse, parseProductFacts } from './recheck-v3-1-transport.mjs';
import { compareProductIdentity } from './recheck-v3-1-identity.mjs';
import { sourceForUrl } from './recheck-v3-1-sources.mjs';

const DEFAULT_SEARCH_SYSTEMS = [
  { id: 'bing', base: 'https://www.bing.com/search?q=' },
  { id: 'google', base: 'https://www.google.com/search?q=' },
];

function queryTerms(row) {
  const brand = row.original?.b ?? '';
  const name = row.original?.n ?? '';
  return [
    `${brand} ${name} nicotine pouch product`,
    `${brand} ${name} nicotine pouch mg per pouch`,
    `${brand} ${name} exact product variant`,
    `${brand} ${name} manufacturer owner`,
  ];
}

function validCandidate(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, reason: 'non_http_url' };
    if (/search\.|google\.|bing\.|duckduckgo\.|facebook\.|instagram\.|youtube\./iu.test(parsed.hostname)) return { ok: false, reason: 'obvious_search_or_social_domain' };
    if (/\.(?:pdf|docx?|xlsx?|zip)(?:$|\?)/iu.test(parsed.pathname) || /(?:download|attachment|file)/iu.test(parsed.pathname)) return { ok: false, reason: 'non_product_document_or_forum' };
    return { ok: true };
  } catch { return { ok: false, reason: 'malformed_candidate_url' }; }
}

function proxyUrlFor(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return `https://r.jina.ai/http://${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch { return null; }
}

function duckDuckGoUrl(query) {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

function preliminaryDecision(row, parsed) {
  const identity = compareProductIdentity(row.original, parsed.extracted ?? {});
  const hasStrength = (parsed.extracted?.strength_claims ?? []).some((claim) => ['per_pouch', 'per_g'].includes(claim.basis));
  if (identity.identity_match === 'exact' && hasStrength && parsed.page_kind === 'product_detail') return { match_decision: 'exact_match', reason: 'Raw product facts contain exact canonical identity and labelled strength semantics.' };
  if (identity.identity_match === 'near') return { match_decision: 'near_match', reason: 'Raw product facts are related but contain missing or additional identity fields.' };
  return { match_decision: 'wrong_variant', reason: 'Raw product facts do not match the frozen product identity.' };
}

function clockFor(now) {
  if (typeof now === 'function') return { now };
  return { now: () => new Date().toISOString() };
}

async function append(path, input, clock) {
  return appendRawEvent(path, input, { recordedAt: clock.now() });
}

export async function researchOneInput(row, {
  outputPath,
  fetchImpl = fetch,
  searchSystems = DEFAULT_SEARCH_SYSTEMS,
  productUrls = [],
  responseCache = new Map(),
  now,
} = {}) {
  if (!outputPath) throw new Error('v3.1 research requires caller-provided outputPath');
  const clock = clockFor(now);
  const candidates = new Set(productUrls);
  const terms = queryTerms(row);
  const systems = searchSystems.length ? searchSystems : [];
  if (systems.length === 0) {
    await append(outputPath, { input_id: row.input_id, event_type: 'transport_event', payload: { kind: 'no_search_systems_configured', candidate_count: 0 } }, clock);
  }
  for (let index = 0; index < terms.length; index += 1) {
    const system = systems[index % Math.max(systems.length, 1)];
    if (!system) break;
    const query = terms[index];
    const requestedUrl = `${system.base}${encodeURIComponent(query)}`;
    let response = await fetchLive(requestedUrl, { fetchImpl, cache: responseCache, timeoutMs: 12000 });
    let proxyUrl = null;
    let directStatus = null;
    let fallbackKind = null;
    if ([403, 429].includes(response.status)) {
      proxyUrl = proxyUrlFor(requestedUrl);
      const proxyResponse = await fetchLive(proxyUrl, { fetchImpl, cache: responseCache, timeoutMs: 20000 });
      await append(outputPath, { input_id: row.input_id, event_type: 'transport_event', payload: { kind: 'search_http_proxy_fallback', requested_url: requestedUrl, proxy_url: proxyUrl, status: response.status, proxy_status: proxyResponse.status, error: proxyResponse.transport_error ?? null } }, clock);
      if (!proxyResponse.transport_error && proxyResponse.status >= 200 && proxyResponse.status < 300) { directStatus = response.status; response = proxyResponse; fallbackKind = 'jina_ai'; }
      else {
        const ddgUrl = duckDuckGoUrl(query);
        const ddgResponse = await fetchLive(ddgUrl, { fetchImpl, cache: responseCache, timeoutMs: 12000 });
        await append(outputPath, { input_id: row.input_id, event_type: 'transport_event', payload: { kind: 'search_independent_fallback', requested_url: requestedUrl, fallback_url: ddgUrl, status: response.status, fallback_status: ddgResponse.status, error: ddgResponse.transport_error ?? null } }, clock);
        if (!ddgResponse.transport_error && ddgResponse.status >= 200 && ddgResponse.status < 300) { directStatus = response.status; response = ddgResponse; proxyUrl = ddgUrl; fallbackKind = 'duckduckgo'; } else proxyUrl = null;
      }
    }
    if (response.transport_error || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      await append(outputPath, { input_id: row.input_id, event_type: 'transport_event', payload: { kind: 'search_failure', system: system.id, query, requested_url: requestedUrl, status: response.status, error: response.transport_error ?? null, cache_hit: response.cache_hit === true } }, clock);
      continue;
    }
    const parsed = parseSearchResponse(response);
    const found = parsed.candidate_urls ?? [];
    for (const candidate of found) candidates.add(candidate);
    await append(outputPath, { input_id: row.input_id, event_type: 'search_attempt', payload: { system: fallbackKind === 'duckduckgo' ? 'duckduckgo' : system.id, query, request_url: requestedUrl, proxy_url: proxyUrl, transport_fallback: fallbackKind, direct_status: directStatus, status: response.status, final_url: response.final_url, response_sha256: response.body_sha256, parse_status: parsed.parse_status, cache_hit: response.cache_hit === true, candidate_urls: found } }, clock);
  }

  for (const system of systems) {
    const query = `${row.original?.b ?? ''} manufacturer owner official`;
    const requestedUrl = `${system.base}${encodeURIComponent(query)}`;
    let response = await fetchLive(requestedUrl, { fetchImpl, cache: responseCache, timeoutMs: 12000 });
    let proxyUrl = null;
    let directStatus = null;
    let fallbackKind = null;
    if ([403, 429].includes(response.status)) {
      proxyUrl = proxyUrlFor(requestedUrl);
      const proxyResponse = await fetchLive(proxyUrl, { fetchImpl, cache: responseCache, timeoutMs: 20000 });
      await append(outputPath, { input_id: row.input_id, event_type: 'transport_event', payload: { kind: 'owner_http_proxy_fallback', requested_url: requestedUrl, proxy_url: proxyUrl, status: response.status, proxy_status: proxyResponse.status, error: proxyResponse.transport_error ?? null } }, clock);
      if (!proxyResponse.transport_error && proxyResponse.status >= 200 && proxyResponse.status < 300) { directStatus = response.status; response = proxyResponse; fallbackKind = 'jina_ai'; }
      else {
        const ddgUrl = duckDuckGoUrl(query);
        const ddgResponse = await fetchLive(ddgUrl, { fetchImpl, cache: responseCache, timeoutMs: 12000 });
        await append(outputPath, { input_id: row.input_id, event_type: 'transport_event', payload: { kind: 'owner_independent_fallback', requested_url: requestedUrl, fallback_url: ddgUrl, status: response.status, fallback_status: ddgResponse.status, error: ddgResponse.transport_error ?? null } }, clock);
        if (!ddgResponse.transport_error && ddgResponse.status >= 200 && ddgResponse.status < 300) { directStatus = response.status; response = ddgResponse; proxyUrl = ddgUrl; fallbackKind = 'duckduckgo'; } else proxyUrl = null;
      }
    }
    const parsed = response.transport_error || response.status < 200 || response.status >= 300 ? { parse_status: 'not_parsed', candidate_urls: [] } : parseSearchResponse(response);
    await append(outputPath, { input_id: row.input_id, event_type: 'owner_lookup', payload: { system: system.id, fallback_system: fallbackKind === 'duckduckgo' ? 'duckduckgo' : null, query, request_url: requestedUrl, proxy_url: proxyUrl, transport_fallback: fallbackKind, direct_status: directStatus, status: response.status, final_url: response.final_url, response_sha256: response.body_sha256, parse_status: parsed.parse_status, cache_hit: response.cache_hit === true, owner: null, candidate_urls: parsed.candidate_urls ?? [] } }, clock);
  }

  for (const candidateUrl of candidates) {
    const validity = validCandidate(candidateUrl);
    if (!validity.ok) {
      await append(outputPath, { input_id: row.input_id, event_type: 'candidate_decision', payload: { candidate_url: candidateUrl, match_decision: 'not_product', rejection_rule: validity.reason, reason: 'Deterministic non-product candidate rejection.' } }, clock);
      continue;
    }
    const response = await fetchLive(candidateUrl, { fetchImpl, cache: responseCache, timeoutMs: 12000 });
    const parsed = parseProductFacts(response);
    const source = sourceForUrl(response.final_url ?? candidateUrl);
    await append(outputPath, { input_id: row.input_id, event_type: 'url_opened', payload: { candidate_url: candidateUrl, requested_url: response.requested_url, final_url: response.final_url, status: response.status, parse_status: parsed.parse_status, page_kind: parsed.page_kind, response_sha256: response.body_sha256, content_type: response.content_type, source_class: source.source_class, owner_group_id: source.owner_group_id, extracted: parsed.extracted ?? {}, cache_hit: response.cache_hit === true, transport_error: response.transport_error ?? null } }, clock);
    const decision = preliminaryDecision(row, parsed);
    await append(outputPath, { input_id: row.input_id, event_type: 'candidate_decision', payload: { candidate_url: candidateUrl, final_url: response.final_url, match_decision: decision.match_decision, reason: decision.reason } }, clock);
  }
  return { rawPath: outputPath, events: await readRawEvents(outputPath), input_id: row.input_id, source: sha256(row) };
}

export { DEFAULT_SEARCH_SYSTEMS, preliminaryDecision, validCandidate };
