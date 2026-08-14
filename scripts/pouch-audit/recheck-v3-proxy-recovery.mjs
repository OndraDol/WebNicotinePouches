import { readFile } from 'node:fs/promises';

import { appendRawEvent, readRawEvents } from './recheck-v3-schema.mjs';
import { fetchLive, parseSearchResponse } from './recheck-v3-transport.mjs';
import { inspectCandidate } from './recheck-v3-research.mjs';

const AUDIT_DIR = 'audit/pouches/recheck-v3';
const RAW_PATH = `${AUDIT_DIR}/raw-events.jsonl`;

function queryFor(row, suffix = '') {
  return [`"${row.original.b}"`, `"${row.original.n}"`, `${row.original.mg} mg`, suffix].filter(Boolean).join(' ');
}

function toProxy(origin) {
  const parsed = new URL(origin);
  return `https://r.jina.ai/http://${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function successfulSearch(event) {
  return event.event_type === 'search_attempt'
    && event.payload?.system === 'google'
    && event.payload.status >= 200 && event.payload.status < 300
    && event.payload.parse_status === 'parsed'
    && event.payload.cache_hit !== true;
}

function successfulOwner(event) {
  return event.event_type === 'owner_lookup'
    && event.payload?.system === 'google'
    && event.payload.status >= 200 && event.payload.status < 300
    && event.payload.parse_status === 'parsed'
    && event.payload.cache_hit !== true;
}

async function main() {
  const snapshot = JSON.parse(await readFile(`${AUDIT_DIR}/input-snapshot.json`, 'utf8'));
  const progress = JSON.parse(await readFile(`${AUDIT_DIR}/progress.json`, 'utf8'));
  const activeIds = new Set(progress.active_batch?.input_ids ?? []);
  if (!activeIds.size) throw new Error('No active batch in progress.json');

  let events = await readRawEvents(RAW_PATH);
  let appended = 0;
  for (const row of snapshot.rows.filter((candidate) => activeIds.has(candidate.input_id))) {
    let rowEvents = events.filter((event) => event.input_id === row.input_id);
    const put = async (event) => {
      await appendRawEvent(RAW_PATH, { input_id: row.input_id, ...event }, { recordedAt: new Date(Date.now() + appended).toISOString() });
      appended += 1;
    };

    if (!rowEvents.some(successfulSearch)) {
      const query = queryFor(row);
      const origin = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      const proxy = toProxy(origin);
      const response = await fetchLive(proxy, { fetchImpl: fetch, cache: new Map(), timeoutMs: 30000 });
      const parsed = parseSearchResponse(response);
      if (!response.transport_error && response.status >= 200 && response.status < 300 && parsed.parse_status === 'parsed') {
        await put({ event_type: 'transport_event', payload: { kind: 'search_http_proxy_fallback', requested_url: origin, proxy_url: proxy, status: 429, proxy_status: response.status, error: null } });
        await put({ event_type: 'search_attempt', payload: { system: 'google', query, request_url: origin, fallback_from: origin, proxy_url: proxy, transport_fallback: 'jina_ai', direct_status: 429, status: response.status, final_url: response.final_url, title: response.title, response_sha256: response.body_sha256, parse_status: parsed.parse_status, candidate_urls: parsed.candidate_urls, cache_hit: response.cache_hit === true } });
        for (const candidateUrl of parsed.candidate_urls) {
          for (const candidateEvent of await inspectCandidate(row, candidateUrl, fetch, new Map())) await put(candidateEvent);
        }
      }
    }

    events = await readRawEvents(RAW_PATH);
    rowEvents = events.filter((event) => event.input_id === row.input_id);
    if (!rowEvents.some(successfulOwner)) {
      const query = queryFor(row, 'owner manufacturer');
      const origin = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      const proxy = toProxy(origin);
      const response = await fetchLive(proxy, { fetchImpl: fetch, cache: new Map(), timeoutMs: 30000 });
      const parsed = parseSearchResponse(response);
      if (!response.transport_error && response.status >= 200 && response.status < 300 && parsed.parse_status === 'parsed') {
        await put({ event_type: 'transport_event', payload: { kind: 'owner_lookup_http_proxy_fallback', requested_url: origin, proxy_url: proxy, status: 429, proxy_status: response.status, error: null } });
        await put({ event_type: 'owner_lookup', payload: { system: 'google', query, request_url: origin, fallback_from: origin, proxy_url: proxy, transport_fallback: 'jina_ai', direct_status: 429, status: response.status, final_url: response.final_url, response_sha256: response.body_sha256, parse_status: parsed.parse_status, owner: null, candidate_urls: parsed.candidate_urls, cache_hit: response.cache_hit === true } });
      }
    }
  }
  console.log(`proxy recovery appended ${appended} raw events for ${activeIds.size} active IDs`);
}

await main();
