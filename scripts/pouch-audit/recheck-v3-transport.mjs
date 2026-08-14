import { sha256 } from './recheck-v3-schema.mjs';

function decodeHtml(value) {
  return String(value ?? '').replace(/<[^>]+>/gu, ' ').replace(/&amp;/gu, '&').replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/\s+/gu, ' ').trim();
}

function titleFromBody(body) {
  return decodeHtml(body.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? '') || null;
}

export async function fetchLive(url, { fetchImpl = fetch, timeoutMs = 12000, cache = null } = {}) {
  const cached = cache?.get?.(url);
  if (cached) return { ...cached, requested_url: cached.requested_url ?? url, cache_hit: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { 'user-agent': 'PouchLog-audit-v3/1.0', accept: 'text/html,application/xhtml+xml,application/json' } });
    const body = await response.text();
    const result = {
      requested_url: url,
      final_url: response.url || url,
      status: response.status,
      title: titleFromBody(body),
      body_sha256: sha256(body),
      body,
      content_type: response.headers?.get?.('content-type') ?? null,
      cache_hit: false,
    };
    cache?.set?.(url, result);
    return result;
  } catch (error) {
    return {
      requested_url: url,
      final_url: null,
      status: null,
      title: null,
      body_sha256: null,
      body: null,
      cache_hit: false,
      transport_error: { name: error.name, message: error.message },
    };
  } finally {
    clearTimeout(timer);
  }
}

function candidateUrlsFromHtml(body) {
  const urls = [];
  for (const match of String(body ?? '').matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/giu)) {
    const href = match[1].replaceAll('&amp;', '&');
    try {
      const url = new URL(href, 'https://search.invalid/');
      if (['http:', 'https:'].includes(url.protocol)
        && !/search\.|google\.|bing\.|duckduckgo\./iu.test(url.hostname)
        && !/(?:^|\.)naver\.com$/iu.test(url.hostname)) urls.push(url.toString());
    } catch { /* malformed search links stay out of raw candidates */ }
  }
  return [...new Set(urls)];
}

export function parseSearchResponse(response) {
  if (!response || response.status < 200 || response.status >= 300 || response.cache_hit === true || response.transport_error) return { parse_status: 'not_parsed', title: response?.title ?? null, candidate_urls: [] };
  const body = String(response.body ?? '');
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed.candidates)) return { parse_status: 'parsed', title: parsed.title ?? response.title ?? null, candidate_urls: parsed.candidates.map((item) => typeof item === 'string' ? item : item?.url).filter(Boolean) };
  } catch { /* HTML search response */ }
  const candidates = candidateUrlsFromHtml(body);
  return { parse_status: candidates.length || body.length > 0 ? 'parsed' : 'not_parsed', title: response.title, candidate_urls: candidates };
}

function firstNumber(pattern, body) {
  const match = String(body ?? '').match(pattern);
  return match ? Number(match[1]) : null;
}

export function parseProductResponse(response) {
  if (!response || response.status < 200 || response.status >= 300 || response.cache_hit === true || response.transport_error) return { parse_status: 'not_parsed', page_kind: 'unknown', extracted: {} };
  const body = String(response.body ?? '');
  const title = response.title ?? titleFromBody(body);
  const strength = firstNumber(/\b(\d+(?:[.,]\d+)?)\s*mg\s*(?:per\s*pouch|\/\s*pouch)\b/iu, body) ?? firstNumber(/\b(\d+(?:[.,]\d+)?)\s*mg\b/iu, body);
  const mgPerG = firstNumber(/\b(\d+(?:[.,]\d+)?)\s*mg\s*\/\s*g\b/iu, body);
  const netWeight = firstNumber(/\b(?:net\s+weight|weight)\s*[:\-]?\s*(\d+(?:[.,]\d+)?)\s*g\b/iu, body);
  const pouchCount = firstNumber(/\b(\d+)\s*(?:pouches|pouch|bags)\b/iu, body);
  const pageKind = /\/products?\b|add\s+to\s+(?:cart|basket)|product\s+details/iu.test(`${response.final_url ?? ''} ${body}`) ? 'product_detail' : 'unknown';
  return {
    parse_status: title || strength || mgPerG ? 'parsed' : 'not_parsed',
    page_kind: pageKind,
    extracted: {
      title,
      name: title,
      strength_mg_per_pouch: Number.isFinite(strength) ? strength : undefined,
      mg_per_g: Number.isFinite(mgPerG) ? mgPerG : undefined,
      net_weight_g: Number.isFinite(netWeight) ? netWeight : undefined,
      pouch_count: Number.isFinite(pouchCount) ? pouchCount : undefined,
    },
  };
}
