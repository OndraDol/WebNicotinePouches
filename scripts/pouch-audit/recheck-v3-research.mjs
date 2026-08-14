import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { appendRawEvent, readRawEvents, sha256, SOURCE_REGISTRY } from './recheck-v3-schema.mjs';
import { fetchLive, parseProductResponse, parseSearchResponse } from './recheck-v3-transport.mjs';

const SEARCH_SYSTEMS = [
  { id: 'google', base: 'https://www.google.com/search?q=' },
  { id: 'bing', base: 'https://www.bing.com/search?q=' },
];

const CATALOGS = [
  { owner: 'Haypp Group', url: 'https://www.haypp.com/uk/search?query=' },
  { owner: 'Haypp Group', url: 'https://www.northerner.com/uk/search?q=' },
];

const CANDIDATE_FETCH_CONCURRENCY = 8;

function queryFor(row, suffix = '') {
  return [`"${row.original.b}"`, `"${row.original.n}"`, `${row.original.mg} mg`, suffix].filter(Boolean).join(' ');
}

function safeExtracted(extracted) {
  return Object.fromEntries(Object.entries(extracted ?? {}).filter(([, value]) => value !== undefined));
}

async function append(path, input, recordedAt) {
  return appendRawEvent(path, input, { recordedAt });
}

function isoClock(now, counter) {
  const base = new Date(now ?? Date.now());
  base.setMilliseconds(base.getMilliseconds() + counter);
  return base.toISOString();
}

function productDecision(row, parsed) {
  const extracted = parsed.extracted ?? {};
  const brandMatch = String(extracted.brand ?? '').toLocaleLowerCase('en-US') === String(row.original.b).toLocaleLowerCase('en-US');
  const name = String(extracted.name ?? extracted.title ?? '').toLocaleLowerCase('en-US');
  const nameMatch = name === String(row.original.n).toLocaleLowerCase('en-US') || name.includes(String(row.original.n).toLocaleLowerCase('en-US'));
  const hasStrength = Number.isFinite(Number(extracted.strength_mg_per_pouch)) || (Number.isFinite(Number(extracted.mg_per_g)) && Number.isFinite(Number(extracted.net_weight_g)) && Number.isFinite(Number(extracted.pouch_count)));
  if (brandMatch && nameMatch && hasStrength && parsed.page_kind === 'product_detail') return { match_decision: 'exact_match', reason: 'Opened product detail contains the exact frozen brand, product identity, and strength semantics.' };
  if (nameMatch || brandMatch) return { match_decision: 'near_match', reason: 'Opened page is related to the frozen identity but does not independently establish every exact variant field.' };
  return { match_decision: 'wrong_variant', reason: 'Opened page does not match the frozen brand and product identity.' };
}

function deterministicCandidateRejection(url) {
  try {
    const parsed = new URL(url);
    if (/(?:^|\.)navercorp\.com$/iu.test(parsed.hostname)
      || /(?:^|\.)papago-plus\.com$/iu.test(parsed.hostname)
      || /bn_redirect/iu.test(parsed.pathname)) {
      return { rejection_rule: 'obvious_search_or_social_domain', reason: 'Candidate URL is a search/navigation/advertising redirect rather than a product-detail source.' };
    }
    if (/\.(?:pdf|docx?|xlsx?)$/iu.test(parsed.pathname)
      || /(?:^|\/)bbs(?:\/|$)|(?:^|\/)forum(?:\/|$)|(?:^|\/)board(?:\/|$)/iu.test(parsed.pathname)
      || /(?:^|\/)bbs(?:[_-]|\/|$)/iu.test(parsed.pathname)
      || /(?:^|\/)paintingpic\/read\.php/iu.test(parsed.pathname)
      || /(?:^|\/)conference\/history_abstract_book(?:\/|$)/iu.test(parsed.pathname)
      || /(?:^|\/)download_attachment(?:_common)?\.php$/iu.test(parsed.pathname)
      || /(?:^|\/)tv\/view\.html$/iu.test(parsed.pathname)
      || /(?:^|\/)article\/[^/]+\.page$/iu.test(parsed.pathname)
      || /(?:^|\/)download_pdf\.php$/iu.test(parsed.pathname)
      || /^(?:www\.)?sec\.gov$/iu.test(parsed.hostname) && /\/Archives\/edgar\//iu.test(parsed.pathname)
      || /(?:filedown|com_trend)\.php$/iu.test(parsed.pathname)
      || /(?:^|[/.])(?:file(?:down|download)|download(?:_[a-z0-9]+)?|nttFileDownload|gongMeFileDown|DownloadServlet|getExcelFile\d*|download_post_attachment|bbsDownload)(?:\.|\/|$)/iu.test(parsed.pathname)
      || /(?:^|\.)jmir\.org$/iu.test(parsed.hostname) && /\/2021\/1\/PDF$/iu.test(parsed.pathname)
      || /(?:^|\/)(?:gastenboek|guestbook)\.php$/iu.test(parsed.pathname)
      || /\/(?:readDownloadFile|downloadFile|file_download)\.(?:do|jsp)$/iu.test(parsed.pathname)
      || /\/UplDownloadFile$/iu.test(parsed.pathname)
      || /(?:^|\/)\w+_download\.(?:do|jsp|php)$/iu.test(parsed.pathname)
      || /(?:^|\/)file\/down(?:load)?(?:\.|\/|$)/iu.test(parsed.pathname)
      || /(?:^|\/)documents?\/download(?:\/|$)/iu.test(parsed.pathname)
      || /(?:^|[?&])documentId=/iu.test(parsed.search)
      || /(?:^|[?&])fn=fileDownload(?:[&#]|$)/iu.test(parsed.search)
      || /(?:^|[?&])fn=(?:down)?File(?:[&#]|$)/iu.test(parsed.search)
      || /(?:^|[?&])com_board_basic=read_form(?:[&#]|$)/iu.test(parsed.search)
      || /(?:^|[?&])picseq=/iu.test(parsed.search)
      || /(?:^|\.)tistory\.com$/iu.test(parsed.hostname)
      || /^(?:docs\.aws\.amazon\.com|www\.worldradiohistory\.com)$/iu.test(parsed.hostname)
      || /(?:^|\.)curia\.europa\.eu$/iu.test(parsed.hostname)
      || /(?:^|\.)kworb\.net$/iu.test(parsed.hostname)
      || /(?:^|\.)bloggang\.com$/iu.test(parsed.hostname)
      || /(?:^|\.)gist\.github\.com$/iu.test(parsed.hostname)
      || /(?:^|\.)camra\.org\.uk$/iu.test(parsed.hostname)
      || /(?:^|\.)thetastingalliance\.com$/iu.test(parsed.hostname) && /^\/results\//iu.test(parsed.pathname)
      || /(?:^|\.)theinternationalman\.com$/iu.test(parsed.hostname) && /\/connoisseur-products-and-services\.php$/iu.test(parsed.pathname)
      || /(?:^|\.)colombopereira\.com$/iu.test(parsed.hostname)
      || /(?:^|\.)edepot\.wur\.nl$/iu.test(parsed.hostname)
      || /^(?:www\.)?nicoleaks\.com$/iu.test(parsed.hostname)
      || /^(?:dl\.)?kotra\.or\.kr$/iu.test(parsed.hostname) && /(?:^|\/)digital-files(?:\/|$)/iu.test(parsed.pathname)
      || /(?:^|\.)teamsi\.co\.kr$/iu.test(parsed.hostname)
      || /^(?:impfood\.)?mfds\.go\.kr$/iu.test(parsed.hostname) && /(?:^|\/)file\/downloadFile$/iu.test(parsed.pathname)
      || /(?:^|\.)theguitar\.co\.kr$/iu.test(parsed.hostname)
      || /(?:^|\.)guitarshop\.co\.kr$/iu.test(parsed.hostname)
      || /(?:^|\.)caffeineinformer\.com$/iu.test(parsed.hostname)
      || /(?:^|\/)collections(?:\/|$)/iu.test(parsed.pathname)
      || /^\/nicotine-pouches\/?$/iu.test(parsed.pathname)
      || (/(?:^|\.)snusexpress\.com$/iu.test(parsed.hostname) && parsed.pathname === '/apres')
      || (/(?:^|\.)kita\.net$/iu.test(parsed.hostname) && /(?:^|\/)tradeNavi\/sps\/spsDetail\.do$/iu.test(parsed.pathname))
      || /(?:^|\.)huggingface\.co$/iu.test(parsed.hostname) && /(?:^|\/)blob(?:\/|$)/iu.test(parsed.pathname)
      || /(?:^|\/)events?_[^/]+\.html?$/iu.test(parsed.pathname)
      || /(?:^|\/)reunions\/[^/]+\.html?$/iu.test(parsed.pathname)
      || /(?:^|\/)journal\/view\.php$/iu.test(parsed.pathname)
      || /(?:^|\/)flDownload\.do$/iu.test(parsed.pathname)
      || /(?:^|\/)down_proc\.asp$/iu.test(parsed.pathname)
      || /(?:^|\/)down_lst_sym\.php$/iu.test(parsed.pathname) && /(?:^|[?&])mode=abook(?:[&#]|$)/iu.test(parsed.search)
      || /^(?:www\.)?gitlab\.com$/iu.test(parsed.hostname) && /(?:^|\/)blob(?:\/|$)/iu.test(parsed.pathname)
      || /(?:^|\/)commune\/view\.php$/iu.test(parsed.pathname)
      || /(?:^|\/)zeroboard\/zboard\.php$/iu.test(parsed.pathname)
      || /(?:^|\/)mibbs\.cgi$/iu.test(parsed.pathname)
      || /(?:^|\/)contentNewFile\.do$/iu.test(parsed.pathname)
      || (/(?:^|[?&])act=board(?:\.[^&#]*)?(?:[&#]|$)/iu.test(parsed.search) && /(?:^|[?&])bbs_mode=view(?:[&#]|$)/iu.test(parsed.search))
      || (/(?:^|[?&])cath=board(?:[&#]|$)/iu.test(parsed.search) && /(?:^|[?&])exec=view(?:[&#]|$)/iu.test(parsed.search))
      || (/(?:^|\/)sub\d+_[^/]+\.php$/iu.test(parsed.pathname) && /(?:^|[?&])(?:mode|bmode)=view(?:[&#]|$)/iu.test(parsed.search))
      || (/(?:^|\/)new(?:\/|$)/iu.test(parsed.pathname) && /(?:mode|bmode)=view/iu.test(parsed.search))) {
      return { rejection_rule: 'non_product_document_or_forum', reason: 'Candidate URL is a document or forum path and is deterministically not a product-detail source.' };
    }
  } catch {
    return { rejection_rule: 'malformed_candidate_url', reason: 'Candidate URL is malformed and cannot be opened as an HTTP product page.' };
  }
  return null;
}

function jinaProxyUrl(candidateUrl) {
  try {
    const parsed = new URL(candidateUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return `https://r.jina.ai/http://${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

async function performSearch(row, path, system, query, fetchImpl, cache, clock) {
  const requestedUrl = `${system.base}${encodeURIComponent(query)}`;
  let response = await fetchLive(requestedUrl, { fetchImpl, cache });
  let fallbackFrom = null;
  let proxyUrl = null;
  let directStatus = null;
  if (system.id === 'naver' && response.status === 403) {
    fallbackFrom = requestedUrl;
    const fallbackUrls = [
      requestedUrl.includes('?') ? `${requestedUrl}&where=web` : `${requestedUrl}?where=web`,
      requestedUrl.replace(/^https:\/\/search\.naver\.com(?=\/)/u, 'https://m.search.naver.com'),
    ];
    let attemptFrom = requestedUrl;
    for (const fallbackUrl of fallbackUrls) {
      await append(path, {
        input_id: row.input_id,
        event_type: 'transport_event',
        payload: { kind: 'search_http_fallback', requested_url: attemptFrom, fallback_url: fallbackUrl, status: response.status },
      }, isoClock(clock.now, clock.count++));
      response = await fetchLive(fallbackUrl, { fetchImpl, cache });
      if (response.status !== 403) break;
      attemptFrom = fallbackUrl;
    }
  }
  if ([403, 429].includes(response.status)) {
    proxyUrl = jinaProxyUrl(response.requested_url ?? requestedUrl);
    if (proxyUrl) {
      const directResponse = response;
      const proxyResponse = await fetchLive(proxyUrl, { fetchImpl, cache, timeoutMs: 20000 });
      await append(path, {
        input_id: row.input_id,
        event_type: 'transport_event',
        payload: { kind: 'search_http_proxy_fallback', requested_url: directResponse.requested_url ?? requestedUrl, proxy_url: proxyUrl, status: directResponse.status, proxy_status: proxyResponse.status, error: proxyResponse.transport_error ?? null },
      }, isoClock(clock.now, clock.count++));
      if (!proxyResponse.transport_error && proxyResponse.status >= 200 && proxyResponse.status < 300) {
        directStatus = directResponse.status;
        response = proxyResponse;
      } else {
        proxyUrl = null;
      }
    }
  }
  if (response.transport_error) {
    await append(path, { input_id: row.input_id, event_type: 'transport_event', payload: { kind: 'network_error', requested_url: response.requested_url ?? requestedUrl, fallback_from: fallbackFrom, error: response.transport_error } }, isoClock(clock.now, clock.count++));
    return { response, candidates: [] };
  }
  const parsed = parseSearchResponse(response);
  await append(path, {
    input_id: row.input_id,
    event_type: 'search_attempt',
    payload: {
      system: system.id,
      query,
      request_url: proxyUrl ? requestedUrl : (response.requested_url ?? requestedUrl),
      fallback_from: fallbackFrom,
      proxy_url: proxyUrl,
      transport_fallback: proxyUrl ? 'jina_ai' : null,
      direct_status: directStatus,
      status: response.status,
      final_url: response.final_url,
      title: response.title,
      response_sha256: response.body_sha256,
      parse_status: parsed.parse_status,
      candidate_urls: parsed.candidate_urls,
      cache_hit: response.cache_hit === true,
    },
  }, isoClock(clock.now, clock.count++));
  return { response, candidates: parsed.candidate_urls };
}

async function performOwnerLookup(row, path, system, query, fetchImpl, cache, clock) {
  const requestedUrl = `${system.base}${encodeURIComponent(query)}`;
  let response = await fetchLive(requestedUrl, { fetchImpl, cache });
  let fallbackFrom = null;
  let proxyUrl = null;
  let directStatus = null;
  if (system.id === 'naver' && response.status === 403) {
    fallbackFrom = requestedUrl;
    const fallbackUrls = [
      requestedUrl.includes('?') ? `${requestedUrl}&where=web` : `${requestedUrl}?where=web`,
      requestedUrl.replace(/^https:\/\/search\.naver\.com(?=\/)/u, 'https://m.search.naver.com'),
    ];
    let attemptFrom = requestedUrl;
    for (const fallbackUrl of fallbackUrls) {
      await append(path, {
        input_id: row.input_id,
        event_type: 'transport_event',
        payload: { kind: 'owner_lookup_http_fallback', requested_url: attemptFrom, fallback_url: fallbackUrl, status: response.status },
      }, isoClock(clock.now, clock.count++));
      response = await fetchLive(fallbackUrl, { fetchImpl, cache });
      if (response.status !== 403) break;
      attemptFrom = fallbackUrl;
    }
  }
  if ([403, 429].includes(response.status)) {
    proxyUrl = jinaProxyUrl(response.requested_url ?? requestedUrl);
    if (proxyUrl) {
      const directResponse = response;
      const proxyResponse = await fetchLive(proxyUrl, { fetchImpl, cache, timeoutMs: 20000 });
      await append(path, {
        input_id: row.input_id,
        event_type: 'transport_event',
        payload: { kind: 'owner_lookup_http_proxy_fallback', requested_url: directResponse.requested_url ?? requestedUrl, proxy_url: proxyUrl, status: directResponse.status, proxy_status: proxyResponse.status, error: proxyResponse.transport_error ?? null },
      }, isoClock(clock.now, clock.count++));
      if (!proxyResponse.transport_error && proxyResponse.status >= 200 && proxyResponse.status < 300) {
        directStatus = directResponse.status;
        response = proxyResponse;
      } else {
        proxyUrl = null;
      }
    }
  }
  if (response.transport_error) {
    await append(path, { input_id: row.input_id, event_type: 'transport_event', payload: { kind: 'owner_lookup_network_error', requested_url: response.requested_url ?? requestedUrl, fallback_from: fallbackFrom, error: response.transport_error } }, isoClock(clock.now, clock.count++));
    return;
  }
  const parsed = parseSearchResponse(response);
  await append(path, {
    input_id: row.input_id,
    event_type: 'owner_lookup',
    payload: { system: system.id, query, request_url: proxyUrl ? requestedUrl : (response.requested_url ?? requestedUrl), fallback_from: fallbackFrom, proxy_url: proxyUrl, transport_fallback: proxyUrl ? 'jina_ai' : null, direct_status: directStatus, status: response.status, final_url: response.final_url, response_sha256: response.body_sha256, parse_status: parsed.parse_status, owner: null, candidate_urls: parsed.candidate_urls, cache_hit: response.cache_hit === true },
  }, isoClock(clock.now, clock.count++));
}

async function performCatalogLookup(row, path, catalog, fetchImpl, cache, clock) {
  const lookupKey = `${row.original.b} ${row.original.n} ${row.original.mg} mg`;
  const requestedUrl = `${catalog.url}${encodeURIComponent(lookupKey)}`;
  const response = await fetchLive(requestedUrl, { fetchImpl, cache });
  if (response.transport_error) {
    await append(path, { input_id: row.input_id, event_type: 'transport_event', payload: { kind: 'catalog_network_error', requested_url: requestedUrl, owner: catalog.owner, error: response.transport_error } }, isoClock(clock.now, clock.count++));
    return [];
  }
  const parsed = parseSearchResponse(response);
  if (response.status >= 200 && response.status < 300 && parsed.parse_status === 'parsed') {
    const payload = { catalog: catalog.owner, lookup_key: lookupKey, result: parsed.candidate_urls.length ? 'found' : 'no_match', candidate_urls: parsed.candidate_urls, snapshot_sha256: response.body_sha256, status: response.status, parse_status: parsed.parse_status, requested_url: requestedUrl, final_url: response.final_url };
    await append(path, { input_id: row.input_id, event_type: 'catalog_lookup', payload }, isoClock(clock.now, clock.count++));
    return parsed.candidate_urls;
  }
  await append(path, { input_id: row.input_id, event_type: 'transport_event', payload: { kind: 'catalog_unavailable', requested_url: requestedUrl, owner: catalog.owner, status: response.status, response_sha256: response.body_sha256 } }, isoClock(clock.now, clock.count++));
  return [];
}

async function inspectCandidate(row, candidateUrl, fetchImpl, cache) {
  const events = [];
  const response = await fetchLive(candidateUrl, { fetchImpl, cache });
  if (response.transport_error) {
    events.push({ event_type: 'transport_event', payload: { kind: 'candidate_open_network_error', requested_url: candidateUrl, error: response.transport_error } });
    const rejection = deterministicCandidateRejection(candidateUrl);
    if (rejection) {
      events.push({ event_type: 'candidate_decision', payload: { candidate_url: candidateUrl, match_decision: 'wrong_variant', ...rejection } });
      return events;
    }
    const proxyUrl = jinaProxyUrl(candidateUrl);
    if (proxyUrl) {
      const proxyResponse = await fetchLive(proxyUrl, { fetchImpl, cache, timeoutMs: 20000 });
      if (!proxyResponse.transport_error && proxyResponse.status >= 200 && proxyResponse.status < 300) {
        const parsed = parseProductResponse(proxyResponse);
        events.push({
          event_type: 'url_opened',
          payload: {
            candidate_url: candidateUrl,
            requested_url: candidateUrl,
            final_url: proxyResponse.final_url,
            proxy_url: proxyUrl,
            transport_fallback: 'jina_ai',
            direct_transport_error: response.transport_error,
            status: proxyResponse.status,
            title: proxyResponse.title,
            response_sha256: proxyResponse.body_sha256,
            parse_status: parsed.parse_status,
            page_kind: parsed.page_kind,
            extracted: safeExtracted(parsed.extracted),
          },
        });
        events.push({ event_type: 'candidate_decision', payload: { candidate_url: candidateUrl, ...productDecision(row, parsed) } });
        return events;
      }
      events.push({ event_type: 'transport_event', payload: { kind: 'candidate_proxy_network_error', requested_url: candidateUrl, proxy_url: proxyUrl, error: proxyResponse.transport_error ?? { status: proxyResponse.status } } });
    }
    return events;
  }
  const parsed = parseProductResponse(response);
  events.push({
    event_type: 'url_opened',
    payload: { candidate_url: candidateUrl, requested_url: candidateUrl, final_url: response.final_url, status: response.status, title: response.title, response_sha256: response.body_sha256, parse_status: parsed.parse_status, page_kind: parsed.page_kind, extracted: safeExtracted(parsed.extracted) },
  });
  events.push({ event_type: 'candidate_decision', payload: { candidate_url: candidateUrl, ...productDecision(row, parsed) } });
  return events;
}

async function mapConcurrent(values, limit, worker) {
  const results = new Array(values.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => run()));
  return results;
}

export async function researchOneInput(row, { outputPath, fetchImpl = fetch, cache = new Map(), now = '2026-08-14T00:00:00.000Z', searchSystems = SEARCH_SYSTEMS, catalogs = CATALOGS } = {}) {
  if (!row?.input_id || !outputPath) throw new Error('researchOneInput requires an input row and outputPath');
  await mkdir(dirname(outputPath), { recursive: true });
  const clock = { now, count: 0 };
  const discovered = new Set();
  for (const system of searchSystems) {
    const result = await performSearch(row, outputPath, system, queryFor(row), fetchImpl, cache, clock);
    result.candidates.forEach((url) => discovered.add(url));
    const strengthResult = await performSearch(row, outputPath, system, queryFor(row, 'strength'), fetchImpl, cache, clock);
    strengthResult.candidates.forEach((url) => discovered.add(url));
  }
  for (const system of searchSystems) await performOwnerLookup(row, outputPath, system, `"${row.original.b}" owner manufacturer ${row.original.n}`, fetchImpl, cache, clock);
  for (const catalog of catalogs) for (const url of await performCatalogLookup(row, outputPath, catalog, fetchImpl, cache, clock)) discovered.add(url);

  for (const system of searchSystems) {
    const result = await performSearch(row, outputPath, system, queryFor(row, 'ingredients'), fetchImpl, cache, clock);
    result.candidates.forEach((url) => discovered.add(url));
  }

  const candidateResults = await mapConcurrent([...discovered], CANDIDATE_FETCH_CONCURRENCY, (candidateUrl) => inspectCandidate(row, candidateUrl, fetchImpl, cache));
  for (const eventsForCandidate of candidateResults) {
    for (const event of eventsForCandidate) await append(outputPath, { input_id: row.input_id, ...event }, isoClock(clock.now, clock.count++));
  }
  const events = await readRawEvents(outputPath);
  return { rawPath: outputPath, input_id: row.input_id, event_count: events.filter((event) => event.input_id === row.input_id).length };
}

export async function researchPilot({ snapshot, outputPath, progressPath, fetchImpl = fetch, now = '2026-08-14T00:00:00.000Z' } = {}) {
  if (!snapshot?.rows || !outputPath || !progressPath) throw new Error('researchPilot requires snapshot, outputPath, and progressPath');
  const rows = snapshot.rows.filter((row) => row.original.b === '77 Pouches');
  if (rows.length !== 5) throw new Error(`Pilot requires exactly five 77 Pouches rows, found ${rows.length}`);
  const processed = [];
  for (const row of rows) {
    await researchOneInput(row, { outputPath, fetchImpl, now });
    processed.push(row.input_id);
  }
  await mkdir(dirname(progressPath), { recursive: true });
  await writeFile(progressPath, `${JSON.stringify({ schema: 3, mode: 'pilot', processed_input_ids: processed, expected_input_ids: processed, snapshot_sha256: snapshot.snapshot_sha256 }, null, 2)}\n`, 'utf8');
  return { processed_input_ids: processed, rawPath: outputPath, progressPath };
}

export { SEARCH_SYSTEMS, CATALOGS, inspectCandidate, performSearch, performOwnerLookup };
