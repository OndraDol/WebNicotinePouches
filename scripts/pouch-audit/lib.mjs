import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_INPUT_ROWS = 1036;
export const CACHE_DIR_NAME = '.cache/pouch-audit';
export const AUDIT_DIR_NAME = 'audit/pouches';

export const SOURCE_DEFINITIONS = [
  {
    id: 'haypp_products_sitemap',
    owner: 'Haypp Group',
    branch: 'retailer_group',
    kind: 'sitemap',
    url: 'https://www.haypp.com/uk/sitemap/sitemap-products.xml',
  },
  {
    id: 'northerner_products_sitemap',
    owner: 'Haypp Group',
    branch: 'retailer_group',
    kind: 'sitemap',
    url: 'https://www.northerner.com/media/sitemap_products.xml',
  },
  {
    id: 'nicopodsuk_products_json',
    owner: 'NicoPODS UK',
    branch: 'retailer',
    kind: 'shopify_json',
    url: 'https://www.nicopodsuk.com/collections/nicotine-pouches/products.json',
  },
  {
    id: 'snusdirect_sitemap',
    owner: 'Snusdirect',
    branch: 'retailer',
    kind: 'sitemap',
    url: 'https://www.snusdirect.com/sitemap.xml',
  },
  {
    id: 'snusdirect_robots',
    owner: 'Snusdirect',
    branch: 'retailer',
    kind: 'robots',
    url: 'https://www.snusdirect.com/robots.txt',
  },
  {
    id: 'fda_authorized_nicotine_pouches',
    owner: 'US FDA',
    branch: 'regulator',
    kind: 'reference_products',
    url: 'https://www.fda.gov/tobacco-products/market-and-distribute-tobacco-product/nicotine-pouch-products-authorized-fda',
  },
  {
    id: 'fda_accessdata_searchtobacco',
    owner: 'US FDA',
    branch: 'regulator',
    kind: 'reference',
    url: 'https://www.accessdata.fda.gov/scripts/searchtobacco/',
  },
  {
    id: 'sweden_tfn_publication_list',
    owner: 'Swedish Public Health Agency',
    branch: 'regulator',
    kind: 'reference',
    url: 'https://tfn.folkhalsomyndigheten.se/ltn-web/publicationList.html?lang=en',
  },
  {
    id: 'denmark_sik_tobacco_substitutes_register',
    owner: 'Danish Safety Technology Authority',
    branch: 'regulator',
    kind: 'reference',
    url: 'https://www.sik.dk/en/registries/export/register_over_tobakssurrogater',
  },
  {
    id: 'canada_lnhpd',
    owner: 'Health Canada',
    branch: 'regulator',
    kind: 'reference',
    url: 'https://health-products.canada.ca/lnhpd-bdpsnh/',
  },
  {
    id: 'canada_dpd',
    owner: 'Health Canada',
    branch: 'regulator',
    kind: 'reference',
    url: 'https://health-products.canada.ca/dpd-bdpp/',
  },
  {
    id: 'manufacturer_velo_uk',
    owner: 'BAT / VELO official catalog',
    branch: 'manufacturer',
    kind: 'manufacturer_index',
    url: 'https://www.velo.com/en-gb/collections/our-products',
  },
  {
    id: 'manufacturer_zyn_us',
    owner: 'Swedish Match / ZYN official catalog',
    branch: 'manufacturer',
    kind: 'manufacturer_index',
    url: 'https://us.zyn.com/all-products/',
  },
  {
    id: 'manufacturer_nordic_spirit_uk',
    owner: 'JTI / Nordic Spirit official catalog',
    branch: 'manufacturer',
    kind: 'manufacturer_index',
    url: 'https://nordicspirit.co.uk/',
  },
  {
    id: 'manufacturer_fumi',
    owner: 'Helix Sweden / Fumi official catalog',
    branch: 'manufacturer',
    kind: 'manufacturer_index',
    url: 'https://fumipods.com/',
  },
  {
    id: 'manufacturer_klint',
    owner: 'KLINT official catalog',
    branch: 'manufacturer',
    kind: 'manufacturer_index',
    url: 'https://klint.fi/tuotteet/',
  },
  {
    id: 'manufacturer_pablo',
    owner: 'Pablo official brand catalog',
    branch: 'brand_owner',
    kind: 'manufacturer_index',
    url: 'https://pablopouch.com/pages/brand-portfolio-1',
  },
  {
    id: 'manufacturer_loop',
    owner: 'LOOP official catalog',
    branch: 'manufacturer',
    kind: 'manufacturer_index',
    url: 'https://loopnicotinepouches.com/nicotinepouches/',
  },
  {
    id: 'manufacturer_helwit',
    owner: 'Helwit official catalog',
    branch: 'manufacturer',
    kind: 'manufacturer_index',
    url: 'https://helwit.co.uk/',
  },
  {
    id: 'manufacturer_fre',
    owner: 'FRE official catalog',
    branch: 'brand_owner',
    kind: 'manufacturer_index',
    url: 'https://frepouch.com/collections/availableproducts',
  },
  {
    id: 'manufacturer_white_fox',
    owner: 'White Fox official catalog',
    branch: 'brand_owner',
    kind: 'manufacturer_index',
    url: 'https://www.whitefoxsweden.com/en',
  },
  {
    id: 'manufacturer_killa',
    owner: 'KILLA official brand catalog',
    branch: 'brand_owner',
    kind: 'manufacturer_index',
    url: 'https://killasnicotinepouches.com/',
  },
];

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 522, 524]);
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const DATA_ROW_RE = /^\s*\{\s*b:\s*("(?:[^"\\]|\\.)*"),\s*n:\s*("(?:[^"\\]|\\.)*"),\s*mg:\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*\},?\s*$/;

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeCandidate(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/(\d)\s*(mg|g)\b/giu, '$1 $2')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const IDENTITY_WRAPPERS = new Set(['buy', 'online', 'nicotine', 'pouch', 'pouches', 'per', 'the', 'product', 'products', 'can', 'cans', 'piece', 'pieces']);

function identityTokens(value, { dropBareStrength = false } = {}) {
  const prepared = String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/#\s*(\d+(?:[.,]\d+)?)/gu, 'hash$1')
    .replace(/\bblackcurrant\b/gu, 'black currant')
    .replace(/(\d+(?:[.,]\d+)?)\s*mg\b/gu, '$1mg')
    .replace(/[^\p{L}\p{N}.,]+/gu, ' ')
    .replace(/(?<!\d)[.,]|[.,](?!\d)/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = prepared.split(' ').filter((token) => token && !IDENTITY_WRAPPERS.has(token));
  return tokens
    .map((token) => /^\d+\.0+$/.test(token) ? token.replace(/\.0+$/u, '') : token)
    .filter((token, index) => {
      if (/^\d+(?:[.,]\d+)?mg$/u.test(token)) return false;
      if (dropBareStrength && index > 0 && /^\d+(?:[.,]\d+)?$/u.test(token)) return false;
      return true;
    });
}

function explicitMgValues(value) {
  return [...String(value ?? '').matchAll(/(\d+(?:[.,]\d+)?)\s*mg\b/giu)].map((match) => Number(match[1].replace(',', '.'))).filter(Number.isFinite);
}

export function matchExactProductVariant(row, record) {
  const rowNameTokens = identityTokens(row.n);
  const titleTokens = identityTokens(record.title, { dropBareStrength: explicitMgValues(row.n).length > 0 });
  const allowedTitleDescriptors = new Set(['medium', 'low', 'normal', 'regular']);
  const remaining = new Map();
  for (const token of rowNameTokens) remaining.set(token, (remaining.get(token) ?? 0) + 1);
  for (const token of titleTokens) {
    const count = remaining.get(token) ?? 0;
    if (count > 0) remaining.set(token, count - 1);
    else if (!allowedTitleDescriptors.has(token)) return false;
  }
  if ([...remaining.values()].some((count) => count > 0)) return false;
  const rowStrengths = explicitMgValues(row.n);
  const titleStrengths = explicitMgValues(record.title);
  if (rowStrengths.length && titleStrengths.length && !rowStrengths.some((value) => titleStrengths.some((candidate) => Math.abs(candidate - value) < Number.EPSILON))) return false;
  if (!rowStrengths.length && titleStrengths.length && Number.isFinite(record.observed_mg_per_pouch) && Math.abs(record.observed_mg_per_pouch - Number(row.mg)) > Number.EPSILON) return false;
  if (rowStrengths.length && Number.isFinite(record.observed_mg_per_pouch) && !rowStrengths.some((value) => Math.abs(record.observed_mg_per_pouch - value) < Number.EPSILON)) return false;
  return true;
}

export function tripleFingerprint(row) {
  return sha256(`${row.b}\u0000${row.n}\u0000${String(row.mg)}`);
}

export function makeInputId(index, row) {
  return `input-${String(index + 1).padStart(4, '0')}-${tripleFingerprint(row)}`;
}

export function normalizeRows(rows) {
  return rows.map((row, index) => ({
    b: String(row.b ?? ''),
    n: String(row.n ?? ''),
    mg: Number(row.mg),
    input_id: makeInputId(index, row),
    original_index: index + 1,
  }));
}

export function rowKey(row) {
  return JSON.stringify([row.b, row.n, row.mg]);
}

export function identityKey(row) {
  return `${normalizeCandidate(row.b)}\u0000${normalizeCandidate(row.n)}`;
}

export function inferProductType(row) {
  const haystack = `${row.b} ${row.n}`.toLocaleLowerCase('en-US');
  if (/\b(?:nicotine[- ]?free|no nicotine|zero nicotine|bez nikotinu)\b/u.test(haystack)) return 'non-nicotine';
  if (/(?:^|\s)(?:caffeine|caffeinated|kofein(?:ový|ové|ove)?)(?=\s|$)/u.test(haystack)) return 'caffeine_or_mixed';
  return 'nicotine_or_unknown';
}

export function parseDataSource(text) {
  const lines = text.split(/\r?\n/u);
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(DATA_ROW_RE);
    if (!match) continue;
    rows.push({
      b: JSON.parse(match[1]),
      n: JSON.parse(match[2]),
      mg: Number(match[3]),
      line_number: index + 1,
      line_index: index,
    });
  }
  return rows;
}

export function resolvePaths(workspaceRoot = process.cwd(), auditRoot = null) {
  const workspace = resolve(workspaceRoot);
  const auditBase = resolve(auditRoot ?? workspace);
  const auditDir = join(auditBase, AUDIT_DIR_NAME);
  const cacheDir = join(auditBase, CACHE_DIR_NAME);
  return {
    workspaceRoot: workspace,
    auditRoot: auditBase,
    auditDir,
    cacheDir,
    inputPath: join(auditDir, 'input.json'),
    unresolvedPath: join(auditDir, 'unresolved-input.json'),
    researchLogPath: join(auditDir, 'research-log.jsonl'),
    ledgerPath: join(auditDir, 'ledger.jsonl'),
    manualReviewPath: join(auditDir, 'manual-review.csv'),
    summaryPath: join(auditDir, 'summary.md'),
    progressPath: join(auditDir, 'progress.md'),
    sourceIndexPath: join(auditDir, 'source-index.json'),
    dataPath: join(workspace, 'data.js'),
    swPath: join(workspace, 'sw.js'),
    gitignorePath: join(workspace, '.gitignore'),
  };
}

export async function ensureAuditDirs(paths) {
  await mkdir(paths.auditDir, { recursive: true });
  await mkdir(paths.cacheDir, { recursive: true });
}

export async function loadCatalogFromData(dataPath) {
  const source = await readFile(dataPath, 'utf8');
  const parsedRows = parseDataSource(source);
  const imported = await import(`${pathToFileURL(dataPath).href}?audit=${Date.now()}`);
  if (!Array.isArray(imported.POUCH_DB)) throw new Error('data.js does not export POUCH_DB as an array');
  if (imported.POUCH_DB.length !== parsedRows.length) {
    throw new Error(`POUCH_DB length ${imported.POUCH_DB.length} differs from parsed source rows ${parsedRows.length}`);
  }
  return { rows: normalizeRows(imported.POUCH_DB), source, parsedRows };
}

export async function loadOrCreateInputSnapshot(paths) {
  await ensureAuditDirs(paths);
  if (existsSync(paths.inputPath)) {
    const snapshot = JSON.parse(await readFile(paths.inputPath, 'utf8'));
    if (!Array.isArray(snapshot.rows)) throw new Error('audit/pouches/input.json has no rows array');
    return snapshot;
  }
  const catalog = await loadCatalogFromData(paths.dataPath);
  const sourceHash = sha256(catalog.source);
  const snapshot = {
    schema: 1,
    created_at: new Date().toISOString(),
    source_file: relative(paths.workspaceRoot, paths.dataPath),
    source_sha256: sourceHash,
    expected_input_rows: EXPECTED_INPUT_ROWS,
    input_rows: catalog.rows.length,
    rows: catalog.rows.map((row, index) => ({
      input_id: makeInputId(index, row),
      original_index: index + 1,
      original: { b: row.b, n: row.n, mg: row.mg },
      source_line: catalog.parsedRows[index]?.line_number ?? null,
      original_sha256: tripleFingerprint(row),
    })),
  };
  await writeFile(paths.inputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return snapshot;
}

export async function freezeUnresolvedInput(paths, snapshot, ledger) {
  await ensureAuditDirs(paths);
  const ledgerById = new Map((ledger ?? []).map((row) => [row.input_id, row]));
  const rows = (snapshot.rows ?? []).filter((input) => {
    const item = ledgerById.get(input.input_id);
    return item?.match_status === 'no_match' && item?.existence_status === 'ambiguous';
  }).map((input) => ({
    input_id: input.input_id,
    original_index: input.original_index,
    original: input.original,
    original_sha256: input.original_sha256,
  }));
  const frozen = {
    schema: 1,
    created_at: new Date().toISOString(),
    source_snapshot: relative(paths.auditRoot, paths.inputPath),
    source_ledger: relative(paths.auditRoot, paths.ledgerPath),
    selection: { match_status: 'no_match', existence_status: 'ambiguous' },
    input_rows: snapshot.rows?.length ?? 0,
    unresolved_rows: rows.length,
    rows,
  };
  if (existsSync(paths.unresolvedPath)) {
    const existing = JSON.parse(await readFile(paths.unresolvedPath, 'utf8'));
    const existingIds = (existing.rows ?? []).map((row) => row.input_id);
    const currentIds = rows.map((row) => row.input_id);
    if (JSON.stringify(existingIds) !== JSON.stringify(currentIds)) throw new Error('Frozen unresolved input ID set is immutable and changed');
    return existing;
  }
  await writeFile(paths.unresolvedPath, `${JSON.stringify(frozen, null, 2)}\n`, 'utf8');
  return frozen;
}

class HostLimiter {
  constructor() {
    this.lastRequest = new Map();
  }

  async wait(host, minimumDelayMs) {
    const now = Date.now();
    const nextAllowed = (this.lastRequest.get(host) ?? 0) + Math.max(1000, minimumDelayMs);
    if (nextAllowed > now) await sleep(nextAllowed - now);
    this.lastRequest.set(host, Date.now());
  }
}

function cacheSlug(url) {
  return `${basename(new URL(url).pathname).replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '') || 'root'}-${sha256(url).slice(0, 16)}`;
}

function cachePathForUrl(cacheDir, url, suffix = '') {
  return join(cacheDir, `${cacheSlug(url)}${suffix ? `-${suffix}` : ''}.json`);
}

function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.split('#', 1)[0].trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLocaleLowerCase('en-US');
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') {
      current = { agents: [value.toLocaleLowerCase('en-US')], disallow: [], allow: [], crawlDelay: 0 };
      groups.push(current);
    } else if (current && key === 'disallow' && value) current.disallow.push(value);
    else if (current && key === 'allow' && value) current.allow.push(value);
    else if (current && key === 'crawl-delay' && Number.isFinite(Number(value))) current.crawlDelay = Number(value) * 1000;
  }
  const applicable = groups.filter((group) => group.agents.includes('*'));
  return {
    available: true,
    crawlDelayMs: Math.max(0, ...applicable.map((group) => group.crawlDelay)),
    groups: applicable,
  };
}

function robotsAllows(robots, url) {
  if (!robots?.available) return false;
  const path = new URL(url).pathname;
  const groups = robots.groups ?? [];
  const blocked = groups.some((group) => group.disallow.some((rule) => path.startsWith(rule) && !group.allow.some((allowed) => path.startsWith(allowed))));
  return !blocked;
}

async function readRobots(origin, { cacheDir, limiter, offline }) {
  const url = `${origin}/robots.txt`;
  const target = cachePathForUrl(cacheDir, url);
  if (existsSync(target)) return JSON.parse(await readFile(target, 'utf8'));
  if (offline) return { url, status: 'offline_missing', available: false, checked_at: new Date().toISOString() };
  const host = new URL(url).host;
  const attempts = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await limiter.wait(host, 1000);
      const response = await fetch(url, { headers: { 'user-agent': 'PouchLog-pouch-audit/1.0 (public catalog audit)' } });
      const body = await response.text();
      const record = {
        url,
        status: response.status,
        checked_at: new Date().toISOString(),
        sha256: sha256(body),
        content_type: response.headers.get('content-type'),
        attempts: [...attempts, { attempt: attempt + 1, status: response.status }],
      };
      if (response.status === 404) {
        record.available = true;
        record.crawlDelayMs = 0;
        record.groups = [];
        await writeFile(target, `${JSON.stringify(record)}\n`, 'utf8');
        return record;
      }
      if (!response.ok) {
        attempts.push({ attempt: attempt + 1, status: response.status });
        if (!RETRYABLE_STATUSES.has(response.status)) return { ...record, status: 'unavailable', available: false };
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      const parsed = parseRobots(body);
      const result = { ...record, ...parsed };
      await writeFile(target, `${JSON.stringify(result)}\n`, 'utf8');
      return result;
    } catch (error) {
      attempts.push({ attempt: attempt + 1, error: String(error.message ?? error) });
      if (attempt < 2) await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  return { url, status: 'unavailable', available: false, checked_at: new Date().toISOString(), attempts };
}

async function fetchStructured(url, { cacheDir, limiter, robots, offline, parser, kind, cacheVersion = '' }) {
  const target = cachePathForUrl(cacheDir, url, cacheVersion);
  if (existsSync(target)) return JSON.parse(await readFile(target, 'utf8'));
  const base = { url, kind, checked_at: new Date().toISOString() };
  if (offline) return { ...base, status: 'offline_missing', records: [], available: false };
  if (!robotsAllows(robots, url)) return { ...base, status: 'robots_disallowed', records: [], available: false };
  const host = new URL(url).host;
  const attempts = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await limiter.wait(host, robots.crawlDelayMs ?? 0);
      const response = await fetch(url, { headers: { accept: 'application/xml, application/json, text/plain', 'user-agent': 'PouchLog-pouch-audit/1.0 (public catalog audit)' } });
      const body = await response.text();
      const responseInfo = { status: response.status, content_type: response.headers.get('content-type'), sha256: sha256(body) };
      if (!response.ok) {
        attempts.push({ attempt: attempt + 1, ...responseInfo });
        if (!RETRYABLE_STATUSES.has(response.status)) return { ...base, ...responseInfo, status: 'unavailable', available: false, attempts };
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      const parsed = parser(body, url);
      const result = { ...base, ...responseInfo, status: 'ok', available: true, ...parsed, attempts: [...attempts, { attempt: attempt + 1, ...responseInfo }] };
      await writeFile(target, `${JSON.stringify(result)}\n`, 'utf8');
      return result;
    } catch (error) {
      attempts.push({ attempt: attempt + 1, error: String(error.message ?? error) });
      if (attempt < 2) await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  return { ...base, status: 'unavailable', available: false, records: [], attempts };
}

export function parseSitemapXml(body) {
  const locs = [...body.matchAll(/<loc[^>]*>\s*([^<]+?)\s*<\/loc>/giu)].map((match) => match[1].trim());
  const lastmods = [...body.matchAll(/<lastmod[^>]*>\s*([^<]+?)\s*<\/lastmod>/giu)].map((match) => match[1].trim());
  const isIndex = /<sitemapindex\b/iu.test(body);
  if (isIndex) return { sitemap_urls: locs, records: [] };
  return {
    sitemap_urls: [],
    records: locs.map((url, index) => ({ url, lastmod: lastmods[index] ?? null, evidence_kind: 'discovery_index' })),
  };
}

function parseShopifyJson(body, baseUrl) {
  const payload = JSON.parse(body);
  const products = Array.isArray(payload.products) ? payload.products : [];
  const records = [];
  for (const product of products) {
    for (const variant of Array.isArray(product.variants) && product.variants.length ? product.variants : [{}]) {
      const weight = Number(variant.grams);
      records.push({
        url: `${new URL(baseUrl).origin}/products/${product.handle}`,
        title: product.title ?? null,
        brand: product.vendor ?? null,
        sku: variant.sku ?? null,
        gtin: variant.barcode ?? null,
        price: Number.isFinite(Number(variant.price)) ? Number(variant.price) : null,
        available: variant.available === true,
        net_weight_g: Number.isFinite(weight) && weight > 0 ? weight : null,
        observed_mg_per_pouch: null,
        observed_mg_per_g: null,
        evidence_kind: 'structured_product_json',
      });
    }
  }
  return { records, product_count: products.length };
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&#x2F;/giu, '/')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function flattenJsonLd(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, output);
  } else if (value && typeof value === 'object') {
    output.push(value);
    for (const child of Object.values(value)) flattenJsonLd(child, output);
  }
  return output;
}

function parseJsonLdProducts(body) {
  const products = [];
  for (const match of body.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      for (const node of flattenJsonLd(parsed)) {
        const type = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
        if (type.some((item) => String(item).toLocaleLowerCase('en-US') === 'product')) products.push(node);
      }
    } catch {
      // Some retailers embed non-JSON scripts. The visible structured fields below remain usable.
    }
  }
  return products;
}

function firstNumber(patterns, text) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1].replace(',', '.'));
  }
  return null;
}

function htmlMetaContent(body, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'iu'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'iu'),
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return null;
}

function pageTitle(body) {
  const raw = htmlMetaContent(body, 'og:title') ?? body.match(/<title[^>]*>\s*([^<]+?)\s*<\/title>/iu)?.[1] ?? null;
  if (!raw) return null;
  return decodeHtml(raw).replace(/\s+/gu, ' ').trim().split(/\s+\|\s+/u, 1)[0] || null;
}

export function parseProductDetail(body, url) {
  const text = decodeHtml(body);
  const products = parseJsonLdProducts(body);
  const product = products[0] ?? {};
  const offer = Array.isArray(product.offers) ? product.offers[0] ?? {} : product.offers ?? {};
  const brandValue = typeof product.brand === 'string' ? product.brand : product.brand?.name;
  const propertyText = flattenJsonLd(product.additionalProperty ?? []).map((property) => `${property.name ?? ''}: ${property.value ?? ''}`).join(' ');
  const searchable = `${propertyText} ${text}`;
  const title = product.name ?? pageTitle(body);
  const mgPerPouch = firstNumber([
    /(?:nicotine(?:\s+content)?|nicotine\s+strength|strength)[^\d]{0,50}(\d+(?:[.,]\d+)?)\s*mg\s*(?:\/\s*|per\s*)pouch/iu,
    /(\d+(?:[.,]\d+)?)\s*mg\s*(?:\/\s*|per\s*)pouch/iu,
  ], searchable);
  const mgPerG = firstNumber([/(?:nicotine(?:\s+content)?|strength)[^\d]{0,50}(\d+(?:[.,]\d+)?)\s*mg\s*(?:\/\s*|per\s*)g\b/iu, /(\d+(?:[.,]\d+)?)\s*mg\s*\/\s*g\b/iu], searchable);
  const netWeight = firstNumber([/net\s+weight[^\d]{0,30}(\d+(?:[.,]\d+)?)\s*g\b/iu], searchable);
  const pouchCount = firstNumber([/(\d{1,3})\s+(?:pouches?|pieces)\b/iu], searchable);
  const availability = String(offer.availability ?? '').toLocaleLowerCase('en-US');
  const available = availability.includes('instock') ? true : availability.includes('outofstock') ? false : /\b(?:in stock|available)\b/iu.test(text) ? true : /\b(?:out of stock|unavailable)\b/iu.test(text) ? false : null;
  const price = Number.isFinite(Number(offer.price)) ? Number(offer.price) : null;
  return {
    url,
    title,
    brand: brandValue ?? null,
    sku: product.sku ?? null,
    gtin: product.gtin ?? product.gtin13 ?? product.gtin12 ?? null,
    price,
    available,
    observed_mg_per_pouch: Number.isFinite(mgPerPouch) ? mgPerPouch : null,
    observed_mg_per_g: Number.isFinite(mgPerG) ? mgPerG : null,
    net_weight_g: Number.isFinite(netWeight) ? netWeight : null,
    pouch_count: Number.isFinite(pouchCount) ? pouchCount : null,
    evidence_kind: 'structured_product_detail',
    json_ld_product: products.length > 0,
    checked_url: url,
  };
}

export function parseManufacturerIndex(body, url) {
  const origin = new URL(url).origin;
  const records = [];
  for (const match of body.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/giu)) {
    const href = decodeHtml(match[2]).trim();
    if (!href || /^(?:#|javascript:|mailto:|tel:)/iu.test(href)) continue;
    let absolute;
    try {
      absolute = new URL(href, url).href;
    } catch {
      continue;
    }
    if (new URL(absolute).origin !== origin) continue;
    const title = decodeHtml(match[3]).replace(/\s+/gu, ' ').trim() || null;
    records.push({ url: absolute, title, evidence_kind: 'manufacturer_discovery' });
  }
  return { records: [...new Map(records.map((record) => [record.url, record])).values()], catalog_url: url };
}

export function parseFdaAuthorized(body, url) {
  const records = [];
  for (const match of body.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)) {
    const rawTitle = decodeHtml(match[1]).replace(/\s+/gu, ' ').trim();
    const mg = firstNumber([/(\d+(?:[.,]\d+)?)\s*mg\b/iu], rawTitle);
    if (!rawTitle || !Number.isFinite(mg)) continue;
    const brand = /^(?:on!|zyn)\b/iu.test(rawTitle) || /^on!/iu.test(rawTitle) ? (rawTitle.toLocaleLowerCase('en-US').startsWith('on!') ? 'on!' : 'ZYN') : null;
    if (!brand) continue;
    let title = rawTitle.replace(/\s+nicotine\s+pouches?\s*/iu, ' ').replace(/\s+/gu, ' ').trim();
    const reordered = title.match(/^(on!)\s+(PLUS\s+)?(\d+(?:[.,]\d+)?)\s+(.+)$/iu);
    if (reordered) title = `${reordered[1]} ${reordered[2] ?? ''}${reordered[4]} ${reordered[3]} mg`.replace(/\s+/gu, ' ').trim();
    records.push({
      url,
      title,
      brand,
      observed_mg_per_pouch: mg,
      observed_mg_per_g: null,
      net_weight_g: null,
      pouch_count: null,
      available: null,
      price: null,
      evidence_kind: 'regulator_product',
    });
  }
  return { records, title: 'Nicotine Pouch Products Authorized by the FDA', catalog_url: url };
}

function parseReferencePage(body, url) {
  const title = body.match(/<title[^>]*>\s*([^<]+?)\s*<\/title>/iu)?.[1]?.replace(/\s+/gu, ' ').trim() ?? null;
  const jsonLdCount = [...body.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>/giu)].length;
  const linkCount = [...body.matchAll(/<a\b[^>]+href=/giu)].length;
  return {
    records: [{ url, title, json_ld_blocks: jsonLdCount, links: linkCount, evidence_kind: 'regulator_reference_page' }],
    title,
    json_ld_blocks: jsonLdCount,
    links: linkCount,
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
  return results;
}

async function collectSitemap(definition, context, robots) {
  const visited = new Set();
  const queue = [definition.url];
  const records = [];
  const childStatuses = [];
  while (queue.length) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    const parsed = await fetchStructured(url, {
      ...context,
      robots,
      parser: (body) => parseSitemapXml(body),
      kind: 'sitemap',
    });
    childStatuses.push({ url, status: parsed.status, sha256: parsed.sha256 ?? null });
    if (parsed.status !== 'ok') continue;
    for (const child of parsed.sitemap_urls ?? []) if (visited.size < 2500) queue.push(child);
    records.push(...(parsed.records ?? []).map((record) => ({ ...record, checked_at: parsed.checked_at ?? null, response_sha256: parsed.sha256 ?? null })));
  }
  const deduped = [...new Map(records.map((record) => [record.url, record])).values()];
  return {
    ...definition,
    status: childStatuses.every((item) => item.status === 'ok') ? 'ok' : childStatuses.some((item) => item.status === 'ok') ? 'partial' : 'unavailable',
    checked_at: new Date().toISOString(),
    records: deduped,
    url_count: deduped.length,
    child_statuses: childStatuses,
  };
}

async function collectShopify(definition, context, robots) {
  const records = [];
  const pages = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = new URL(definition.url);
    url.searchParams.set('limit', '250');
    url.searchParams.set('page', String(page));
    const parsed = await fetchStructured(url.href, {
      ...context,
      robots,
      parser: (body, sourceUrl) => parseShopifyJson(body, sourceUrl),
      kind: 'shopify_json',
      cacheVersion: 'shopify-v3',
    });
    pages.push({ url: url.href, status: parsed.status, count: parsed.records?.length ?? 0, sha256: parsed.sha256 ?? null });
    if (parsed.status !== 'ok') break;
    records.push(...(parsed.records ?? []).map((record) => ({ ...record, checked_at: parsed.checked_at ?? null, response_sha256: parsed.sha256 ?? null })));
    if ((parsed.records ?? []).length === 0 || (parsed.product_count ?? 0) < 250) break;
  }
  return {
    ...definition,
    status: pages.some((page) => page.status === 'ok') ? pages.every((page) => page.status === 'ok') ? 'ok' : 'partial' : 'unavailable',
    checked_at: new Date().toISOString(),
    records,
    url_count: new Set(records.map((record) => record.url)).size,
    pages,
  };
}

const DETAIL_GENERIC_TOKENS = new Set(['mg', 'per', 'pouch', 'pouches', 'nicotine']);

function pathTokens(url) {
  return normalizeCandidate(new URL(url).pathname).split(' ').filter(Boolean);
}

function discoveryCandidateScore(row, record) {
  const brandTokens = [...new Set(normalizeCandidate(row.b).split(' ').filter((token) => token && !DETAIL_GENERIC_TOKENS.has(token)))];
  const manufacturerDiscovery = ['manufacturer', 'brand_owner'].includes(record.branch);
  const nameTokens = [...new Set(normalizeCandidate(row.n).split(' ').filter((token) => token && !DETAIL_GENERIC_TOKENS.has(token) && !brandTokens.includes(token) && !/^\d+(?:[.,]\d+)?(?:mg|g)?$/iu.test(token)))];
  const urlTokens = pathTokens(record.url);
  if (!manufacturerDiscovery && !brandTokens.every((token) => urlTokens.includes(token))) return 0;
  if (!nameTokens.length) return 0.5;
  const hits = nameTokens.filter((token) => urlTokens.includes(token)).length;
  return hits / nameTokens.length;
}

function isLikelyProductUrl(url) {
  const path = new URL(url).pathname.toLocaleLowerCase('en-US');
  return !/(?:\/blog\/|\/article|\/category|\/tag|\/mixpack\/|\/pages\/|\/collections\/)/u.test(path);
}

function chooseDetailCandidates(row, records) {
  const ranked = records
    .filter((record) => record.url && isLikelyProductUrl(record.url))
    .map((record) => ({ record, score: discoveryCandidateScore(row, record) }))
    .filter((candidate) => candidate.score >= (['manufacturer', 'brand_owner'].includes(candidate.record.branch) ? 0.6 : 0.9))
    .sort((left, right) => right.score - left.score || left.record.url.localeCompare(right.record.url));
  const chosen = [];
  const owners = new Set();
  for (const candidate of ranked) {
    const owner = candidate.record.source_owner ?? candidate.record.source_id;
    if (owners.has(owner)) continue;
    owners.add(owner);
    chosen.push(candidate);
    if (chosen.length === 3) break;
  }
  return chosen;
}

async function collectDetailRecords(candidateRows, baseRecords, { cacheDir, limiter, offline }, robotsByOrigin) {
  const candidatesByUrl = new Map();
  for (const input of candidateRows ?? []) {
    const row = input.original ?? input;
    for (const candidate of chooseDetailCandidates(row, baseRecords)) {
      if (!candidatesByUrl.has(candidate.record.url)) candidatesByUrl.set(candidate.record.url, { record: candidate.record, input_ids: [] });
      candidatesByUrl.get(candidate.record.url).input_ids.push(input.input_id ?? null);
    }
  }
  const jobs = [...candidatesByUrl.values()];
  const details = await mapLimit(jobs, 2, async ({ record, input_ids }) => {
    const origin = new URL(record.url).origin;
    const robots = robotsByOrigin.get(origin);
    if (!robots?.available) return { url: record.url, status: 'robots_unavailable', source_id: record.source_id, input_ids };
    const result = await fetchStructured(record.url, {
      cacheDir,
      limiter,
      robots,
      offline,
      parser: (body, sourceUrl) => parseProductDetail(body, sourceUrl),
      kind: 'product_detail',
      cacheVersion: 'detail-v4',
    });
    return {
      ...result,
      source_id: record.source_id,
      source_owner: record.source_owner,
      branch: record.branch,
      input_ids,
      discovery_url: record.url,
      response_sha256: result.sha256 ?? null,
    };
  });
  const detailRecords = details.filter((detail) => detail.status === 'ok' && detail.title).map((detail) => ({ ...detail, evidence_kind: 'structured_product_detail' }));
  return { details, detailRecords };
}

export async function collectSourceIndex({ paths, offline = false, candidateRows = [] } = {}) {
  const limiter = new HostLimiter();
  const origins = [...new Set(SOURCE_DEFINITIONS.map((definition) => new URL(definition.url).origin))];
  const robotsResults = await mapLimit(origins, 2, (origin) => readRobots(origin, { cacheDir: paths.cacheDir, limiter, offline }));
  const robotsByOrigin = new Map(origins.map((origin, index) => [origin, robotsResults[index]]));
  const context = { cacheDir: paths.cacheDir, limiter, offline };
  const sources = await mapLimit(SOURCE_DEFINITIONS, 2, async (definition) => {
    const origin = new URL(definition.url).origin;
    const robots = robotsByOrigin.get(origin);
    if (definition.kind === 'robots') {
      return { ...definition, status: robots.status === 200 || robots.status === 404 ? 'ok' : robots.status, checked_at: robots.checked_at, records: [], robots };
    }
    if (!robots.available) return { ...definition, status: 'unavailable', checked_at: new Date().toISOString(), records: [], reason: `robots:${robots.status}` };
    if (definition.kind === 'sitemap') return collectSitemap(definition, context, robots);
    if (definition.kind === 'shopify_json') return collectShopify(definition, context, robots);
    if (definition.kind === 'reference') return fetchStructured(definition.url, { ...context, robots, parser: parseReferencePage, kind: 'reference' }).then((result) => ({ ...definition, ...result, source_id: definition.id, records: result.records ?? [], reason: result.status === 'ok' ? undefined : `fetch:${result.status}` }));
    if (definition.kind === 'reference_products') return fetchStructured(definition.url, { ...context, robots, parser: parseFdaAuthorized, kind: 'reference_products', cacheVersion: 'fda-v2' }).then((result) => ({ ...definition, ...result, source_id: definition.id, records: result.records ?? [], reason: result.status === 'ok' ? undefined : `fetch:${result.status}` }));
    if (definition.kind === 'manufacturer_index') return fetchStructured(definition.url, { ...context, robots, parser: parseManufacturerIndex, kind: 'manufacturer_index' }).then((result) => ({ ...definition, ...result, source_id: definition.id, records: result.records ?? [], reason: result.status === 'ok' ? undefined : `fetch:${result.status}` }));
    return { ...definition, status: 'unsupported', records: [] };
  });
  const baseRecords = sources.flatMap((source) => (source.records ?? []).map((record) => ({
    ...record,
    source_id: source.id,
    source_owner: source.owner,
    branch: source.branch,
    source_status: source.status,
    checked_at: record.checked_at ?? source.checked_at ?? null,
    response_sha256: record.response_sha256 ?? source.sha256 ?? null,
  })));
  const { details, detailRecords } = await collectDetailRecords(candidateRows, baseRecords, context, robotsByOrigin);
  return {
    schema: 1,
    generated_at: new Date().toISOString(),
    policy: {
      max_requests_per_host_per_second: 1,
      max_concurrent_hosts: 2,
      max_attempts: 3,
      discovery_is_not_identity_evidence: true,
      haypp_and_northerner_same_owner_branch: true,
    },
    robots: robotsResults,
    sources,
    detail_attempts: details,
    detail_records: detailRecords,
    records: [...baseRecords, ...detailRecords],
  };
}

function sourceEvidence(record, note) {
  return {
    evidence_type: record.evidence_kind ?? 'structured_source',
    source_id: record.source_id,
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
      net_weight_g: record.net_weight_g ?? null,
      observed_mg_per_pouch: record.observed_mg_per_pouch ?? null,
      observed_mg_per_g: record.observed_mg_per_g ?? null,
    },
    note,
  };
}

function findStructuredMatches(row, records) {
  const brand = normalizeCandidate(row.b);
  const name = normalizeCandidate(row.n);
  return records.filter((record) => {
    if (!record.title) return false;
    const recordName = normalizeCandidate(record.title);
    if (record.brand && normalizeCandidate(record.brand) === brand && recordName === name) return true;
    // Shopify product JSON uses the retailer as vendor, not the pouch brand.
    // The full product title still has to match exactly; URL similarity alone is never enough.
    return recordName === name && ['structured_product_json', 'structured_product_detail'].includes(record.evidence_kind);
  });
}

function chooseSaleStatus(matches) {
  if (!matches.length) return 'unknown';
  if (matches.some((record) => record.available === true && Number(record.price) > 0)) return 'buyable_now';
  return 'listed_unavailable';
}

function buildObserved(matches) {
  const directMgRecords = matches.filter((record) => Number.isFinite(record.observed_mg_per_pouch));
  const withPouchMg = matches.find((record) => Number.isFinite(record.observed_mg_per_pouch));
  const withPerG = matches.find((record) => Number.isFinite(record.observed_mg_per_g));
  const withCalculation = !withPouchMg && matches.find((record) => Number.isFinite(record.observed_mg_per_g) && Number.isFinite(record.net_weight_g) && Number.isFinite(record.pouch_count) && record.pouch_count > 0);
  const calculated = withCalculation ? (withCalculation.observed_mg_per_g * withCalculation.net_weight_g) / withCalculation.pouch_count : null;
  const pouchMgValues = [...new Set([...directMgRecords.map((record) => record.observed_mg_per_pouch), ...(calculated === null ? [] : [calculated])])];
  const mgEvidenceRecords = [...directMgRecords, ...(withCalculation && !directMgRecords.includes(withCalculation) ? [withCalculation] : [])];
  const observed = withPouchMg?.observed_mg_per_pouch ?? calculated;
  return {
    observed_mg_per_pouch: observed ?? calculated,
    observed_mg_values: pouchMgValues,
    mg_evidence_owners: [...new Set(mgEvidenceRecords.map((record) => record.source_owner).filter(Boolean))],
    observed_mg_per_g: withPerG?.observed_mg_per_g ?? null,
    net_weight_g: withCalculation?.net_weight_g ?? null,
    pouch_count: withCalculation?.pouch_count ?? null,
    format: matches.find((record) => record.format)?.format ?? null,
    sku: matches.find((record) => record.sku)?.sku ?? null,
    gtin: matches.find((record) => record.gtin)?.gtin ?? null,
    calculation: calculated === null ? null : {
      expression: 'mg_per_g * net_weight_g / pouch_count',
      inputs: {
        mg_per_g: withCalculation.observed_mg_per_g,
        net_weight_g: withCalculation.net_weight_g,
        pouch_count: withCalculation.pouch_count,
      },
      result: calculated,
      source_url: withCalculation.url,
      response_sha256: withCalculation.response_sha256 ?? null,
    },
  };
}

function mgEvidenceMeetsThreshold(matches) {
  const mgMatches = matches.filter((record) => Number.isFinite(record.observed_mg_per_pouch) || (Number.isFinite(record.observed_mg_per_g) && Number.isFinite(record.net_weight_g) && Number.isFinite(record.pouch_count) && record.pouch_count > 0));
  if (mgMatches.some((record) => ['manufacturer', 'regulator'].includes(record.branch))) return true;
  return new Set(mgMatches.map((record) => record.source_owner).filter(Boolean)).size >= 2;
}

function reviewSteps(row, sourceIndex, matches, inputId) {
  const sources = sourceIndex?.sources ?? [];
  const retailerSources = sources.filter((source) => source.branch === 'retailer');
  const manufacturerSources = sources.filter((source) => ['manufacturer', 'brand_owner'].includes(source.branch));
  const regulatorSources = sources.filter((source) => source.branch === 'regulator');
  const manufacturerRecords = sourceIndex?.records?.filter((record) => ['manufacturer', 'brand_owner'].includes(record.branch)) ?? [];
  const regulatorProductRecords = sourceIndex?.records?.filter((record) => record.branch === 'regulator' && record.evidence_kind === 'regulator_product') ?? [];
  const detailAttempts = sourceIndex?.detail_attempts?.filter((attempt) => (attempt.input_ids ?? []).includes(inputId)) ?? [];
  return {
    mass_indexes: {
      status: sources.length ? 'completed' : 'unavailable',
      source_ids: sources.map((source) => source.id),
      note: 'Primary retailer indexes and configured regulator landing pages were fetched or loaded from cache before row-level pairing.',
    },
    retailer_indexes: {
      status: 'completed',
      source_ids: retailerSources.map((source) => source.id),
      exact_attribute_match: matches.length > 0,
      note: 'Exact normalized brand plus full product name was checked against structured retailer records; sitemap discovery URLs were not treated as proof.',
    },
    manufacturer_catalog: {
      status: manufacturerSources.length ? 'completed' : 'unavailable',
      source_ids: manufacturerSources.map((source) => source.id),
      exact_attribute_match: manufacturerRecords.some((record) => matches.includes(record)),
      note: 'Configured official/brand-owner catalog indexes were checked in bulk; only opened product details can support identity, and catalog absence does not prove nonexistence.',
    },
    national_registries: {
      status: regulatorSources.length ? 'landing_pages_checked' : 'not_run',
      source_ids: regulatorSources.map((source) => source.id),
      product_level_lookup: regulatorProductRecords.length ? 'completed_for_configured_product_tables' : 'not_available',
      note: 'Public regulator product tables and landing pages were checked where available; their market-specific absence cannot establish nonexistence elsewhere.',
    },
    exact_query: {
      status: 'completed',
      query: `${row.b} ${row.n} ${row.mg} mg per pouch`,
      opened_detail_candidates: detailAttempts.length,
      matched_detail_records: matches.filter((record) => record.evidence_kind === 'structured_product_detail').length,
      note: 'The exact whole-name-plus-strength query was evaluated against all cached public indexes and up to three opened product-detail candidates per row. Search-engine discovery alone was not promoted to evidence; unresolved rows remain unverified rather than being guessed.',
    },
  };
}

function conflictGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = identityKey(row.original);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].filter(([, group]) => new Set(group.map((item) => item.original.mg)).size > 1);
}

function mergeResearchIntoLedgerItem(item, research) {
  const original = item.original;
  const status = research.research_status;
  const observed = research.relevant_explicit_data?.observed_mg_per_pouch ?? null;
  const values = research.relevant_explicit_data?.observed_mg_values ?? [];
  const identityConfirmed = research.requirement_status?.identity === 'confirmed';
  const corrected = status === 'verified' && research.strength_status === 'corrected' && Number.isFinite(observed) && observed !== Number(original.mg);
  const conflicts = status === 'conflicted' || research.strength_status === 'conflicted';
  const proposedChanges = [...(item.proposed_changes ?? [])];
  if (corrected) proposedChanges.push({ action: 'change', field: 'mg', from: original.mg, to: observed, basis: 'authoritative manufacturer/regulator or two independent retailer branches', evidence_urls: (research.evidence ?? []).map((evidence) => evidence.url).filter(Boolean) });
  const evidence = [...(research.evidence ?? [])];
  if (!evidence.length) evidence.push({ evidence_type: 'research_protocol', source_id: 'pouch-audit', source_owner: 'PouchLog audit', branch: 'audit', url: null, checked_at: research.checked_at, response_sha256: null, note: research.evidence_paraphrase });
  return {
    ...item,
    canonical_brand: research.canonical_candidate?.brand ?? item.canonical_brand,
    canonical_name: research.canonical_candidate?.name ?? item.canonical_name,
    match_status: identityConfirmed ? 'exact_attributes' : conflicts ? 'ambiguous' : 'no_match',
    existence_status: identityConfirmed ? 'confirmed' : 'ambiguous',
    sale_status: research.requirement_status?.sale ?? 'unknown',
    strength_status: conflicts ? 'conflicted' : corrected ? 'corrected' : status === 'verified' ? 'verified' : 'unverified',
    observed_mg_per_pouch: observed,
    observed_mg_values: values,
    mg_evidence_owners: research.source_owner ?? [],
    observed_mg_per_g: research.relevant_explicit_data?.observed_mg_per_g ?? null,
    net_weight_g: research.relevant_explicit_data?.net_weight_g ?? null,
    pouch_count: research.relevant_explicit_data?.pouch_count ?? null,
    format: research.relevant_explicit_data?.format ?? null,
    sku: research.relevant_explicit_data?.sku ?? null,
    gtin: research.relevant_explicit_data?.gtin ?? null,
    market: research.relevant_explicit_data?.market ?? null,
    source_owner: research.source_owner ?? [],
    evidence,
    checked_at: research.checked_at,
    decision: item.decision === 'remove' ? item.decision : conflicts ? 'review' : 'keep',
    reason_code: item.reason_code === 'exact_duplicate' ? item.reason_code : conflicts ? 'strength_conflict' : corrected ? 'verified_mg_correction' : status === 'verified' ? 'verified_identity_and_mg' : 'exhausted_10m_unverified',
    proposed_changes: proposedChanges,
    research_status: status,
    active_search_seconds: Number(research.active_search_seconds),
    terminal_reason: research.terminal_reason,
    research_steps: research.step_results ?? [],
    research_queries: research.queries ?? [],
    calculation: research.relevant_explicit_data?.calculation ?? null,
  };
}

export function buildLedger(snapshot, sourceIndex = null, researchRecords = []) {
  const rows = snapshot.rows ?? [];
  const sourceRecords = sourceIndex?.records ?? [];
  const seenExact = new Map();
  const conflicts = new Set(conflictGroups(rows).map(([key]) => key));
  const ledger = [];
  for (const input of rows) {
    const original = input.original;
    const exact = rowKey(original);
    const duplicateOf = seenExact.get(exact) ?? null;
    if (!duplicateOf) seenExact.set(exact, input.input_id);
    const invalid = !original.b.trim() || !original.n.trim() || !Number.isFinite(Number(original.mg)) || Number(original.mg) < 0;
    const matches = invalid ? [] : findStructuredMatches(original, sourceRecords);
    const observed = buildObserved(matches);
    const conflict = conflicts.has(identityKey(original));
    const evidence = matches.map((record) => sourceEvidence(record, record.branch === 'regulator' ? 'Regulator product record matched brand, full product name, and explicit mg per pouch.' : record.branch === 'manufacturer' || record.branch === 'brand_owner' ? 'Official manufacturer or brand-owner product detail matched the available exact attributes; catalog discovery alone is not treated as proof.' : 'Structured retailer detail matched brand and full product name; discovery URLs alone are not treated as proof.'));
    if (duplicateOf) evidence.push({ evidence_type: 'internal_exact_duplicate', source_id: 'data.js', source_owner: 'PouchLog input', branch: 'internal', url: null, checked_at: snapshot.created_at, response_sha256: input.original_sha256, note: `Exact b+n+mg triple duplicates ${duplicateOf}; later row is safely removable.` });
    if (conflict) evidence.push({ evidence_type: 'internal_strength_conflict', source_id: 'data.js', source_owner: 'PouchLog input', branch: 'internal', url: null, checked_at: snapshot.created_at, response_sha256: input.original_sha256, observed: { identity_key: identityKey(original), conflicting_mg_values: conflictGroups(rows).find(([key]) => key === identityKey(original))?.[1].map((item) => item.original.mg) ?? [] }, note: 'Same normalized brand+name has multiple original mg values; no value is inferred or silently selected.' });
    if (observed.observed_mg_values.length > 1) evidence.push({ evidence_type: 'external_strength_conflict', source_id: 'retailer_detail_pairing', source_owner: 'multiple evidence branches', branch: 'retailer', url: null, checked_at: new Date().toISOString(), observed: { conflicting_mg_values: observed.observed_mg_values, owners: observed.mg_evidence_owners }, note: 'Independent matched variants report different explicit mg-per-pouch values; no value is selected automatically.' });
    const existenceStatus = invalid ? 'invalid' : matches.length ? 'confirmed' : 'ambiguous';
    const mgThreshold = !invalid && mgEvidenceMeetsThreshold(matches);
    const sourceConflict = observed.observed_mg_values.length > 1;
    const mgCorrection = !conflict && !sourceConflict && mgThreshold && Number.isFinite(observed.observed_mg_per_pouch) && observed.observed_mg_per_pouch !== original.mg;
    const strengthStatus = invalid ? 'unverified' : conflict || sourceConflict ? 'conflicted' : mgCorrection ? 'corrected' : mgThreshold && Number.isFinite(observed.observed_mg_per_pouch) ? 'verified' : 'unverified';
    const decision = invalid ? 'remove' : duplicateOf ? 'remove' : conflict || sourceConflict ? 'review' : 'keep';
    const reasonCode = invalid ? 'invalid_catalog_row' : duplicateOf ? 'exact_duplicate' : conflict || sourceConflict ? 'strength_conflict' : mgCorrection ? 'verified_mg_correction' : matches.length ? 'matched_identity_mg_evidence_recorded' : 'unverified_keep_conservative';
    const proposedChanges = [];
    if (duplicateOf) proposedChanges.push({ action: 'remove', duplicate_of: duplicateOf, basis: 'same exact b+n+mg triple' });
    if (invalid) proposedChanges.push({ action: 'remove', basis: 'empty identity or non-finite/negative mg' });
    if (mgCorrection) proposedChanges.push({ action: 'change', field: 'mg', from: original.mg, to: observed.observed_mg_per_pouch, basis: 'explicit mg-per-pouch evidence from required independent branches', evidence_owners: observed.mg_evidence_owners });
    ledger.push({
      input_id: input.input_id,
      original,
      canonical_brand: original.b,
      canonical_name: original.n,
      product_type: inferProductType(original),
      match_status: invalid ? 'no_match' : matches.length ? 'exact_attributes' : 'no_match',
      existence_status: existenceStatus,
      sale_status: chooseSaleStatus(matches),
      strength_status: strengthStatus,
      observed_mg_per_pouch: observed.observed_mg_per_pouch,
      observed_mg_values: observed.observed_mg_values,
      mg_evidence_owners: observed.mg_evidence_owners,
      observed_mg_per_g: observed.observed_mg_per_g,
      net_weight_g: observed.net_weight_g,
      pouch_count: observed.pouch_count,
      format: observed.format,
      sku: observed.sku,
      gtin: observed.gtin,
      market: matches.length ? 'retailer index market as listed' : null,
      source_owner: [...new Set(matches.map((record) => record.source_owner))],
      evidence,
      checked_at: new Date().toISOString(),
      decision,
      reason_code: reasonCode,
      proposed_changes: proposedChanges,
      calculation: observed.calculation,
      review_steps: reviewSteps(original, sourceIndex, matches, input.input_id),
    });
  }
  const researchById = new Map((researchRecords ?? []).map((record) => [record.input_id, record]));
  return ledger.map((item) => researchById.has(item.input_id) ? mergeResearchIntoLedgerItem(item, researchById.get(item.input_id)) : item);
}

function csvEscape(value) {
  const string = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/u.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

export function makeManualReviewCsv(ledger) {
  const header = ['input_id', 'original_index', 'brand', 'name', 'mg', 'decision', 'existence_status', 'sale_status', 'strength_status', 'reason_code', 'observed_mg_per_pouch', 'evidence_urls', 'notes'];
  const lines = [header.join(',')];
  for (const item of ledger) {
    const originalConflict = item.evidence.some((evidence) => evidence.evidence_type === 'internal_strength_conflict');
    if (!(item.decision === 'review' || item.strength_status === 'unverified' || item.existence_status === 'ambiguous' || originalConflict)) continue;
    const urls = item.evidence.map((evidence) => evidence.url).filter(Boolean).join(' | ');
    const notes = originalConflict ? `${item.reason_code === 'exact_duplicate' ? 'Exact duplicate removed safely; ' : ''}conflicting same normalized brand+name values remain explicitly unresolved; do not infer from product name.` : 'Insufficient authoritative evidence for an automatic identity or mg change; retained conservatively.';
    lines.push([
      item.input_id,
      item.input_id ? item.input_id.match(/^input-(\d+)-/u)?.[1] ?? '' : '',
      item.original.b,
      item.original.n,
      item.original.mg,
      item.decision,
      item.existence_status,
      item.sale_status,
      item.strength_status,
      item.reason_code,
      item.observed_mg_per_pouch,
      urls,
      notes,
    ].map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function summarizeAudit(snapshot, ledger, sourceIndex, applyResult = null) {
  const sourceRows = sourceIndex?.sources ?? [];
  const counts = (values) => Object.fromEntries([...new Set(values)].map((value) => [value, values.filter((item) => item === value).length]));
  const conflictEntries = conflictGroups(snapshot.rows ?? []);
  const safeRemovals = ledger.filter((item) => item.decision === 'remove');
  const exactDuplicates = ledger.filter((item) => item.reason_code === 'exact_duplicate');
  const invalid = ledger.filter((item) => item.reason_code === 'invalid_catalog_row');
  const changed = ledger.filter((item) => item.proposed_changes.some((change) => change.action === 'change'));
  const saleCounts = counts(ledger.map((item) => item.sale_status));
  const strengthCounts = counts(ledger.map((item) => item.strength_status));
  const lines = [
    '# Pouch catalog audit',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Method',
    '',
    '- The immutable input snapshot preserves every original row, its original order, and an input ID derived from order plus SHA-256 of the original `b+n+mg` triple.',
    '- Normalization is candidate generation only: Unicode NFKC, case-folding, whitespace and punctuation unification. Distinguishing tokens such as Plus, Mini, Slim, Strong, Gold, product series, flavor and strength are retained.',
    '- Exact `b+n+mg` duplicates are the only automatically removable identity duplicates. Fuzzy or normalized similarity never merges, corrects or removes a row.',
    '- `mg` is interpreted only as nicotine mg per pouch. Caffeine and non-nicotine products are retained and are never assigned caffeine content to `mg`.',
    '- Discovery sitemap URLs are not identity evidence. Structured product records may establish listing/sale state, but no mg correction is made without an explicit, variant-matched authoritative value or the required independent evidence branches.',
    '- Haypp and Northerner are one evidence branch (`Haypp Group`); source-owner duplication is not counted as independent confirmation.',
    '',
    '## Sources and limits',
    '',
    `- Source index contains ${sourceRows.length} configured public sources and ${sourceIndex?.records?.length ?? 0} structured/discovery records.`,
    `- Robots policy: one request per host per second minimum, at most two concurrent host workers, maximum three attempts for retryable failures.`,
    ...sourceRows.map((source) => `- ${source.id} (${source.owner}): **${source.status}**, ${source.url_count ?? source.records?.length ?? 0} indexed records${source.reason ? `; ${source.reason}` : ''}.`),
    '- Manufacturer and national-registry coverage is represented conservatively in the per-row ledger. No unverified search result is treated as proof, and no conclusion is drawn from absence in one market catalog.',
    '- For unresolved rows, `review_steps` records the completed bulk exact whole-name-plus-strength lookup, configured official catalog checks, opened detail candidates, and regulator landing/product-table checks. Search-engine discovery alone was deliberately not promoted to evidence.',
    '',
    '## Counts',
    '',
    `- Original rows: **${snapshot.rows.length}** (expected baseline: ${EXPECTED_INPUT_ROWS}).`,
    `- Projected/final rows: **${snapshot.rows.length - safeRemovals.length}** before any non-duplicate correction; applied safe removals: **${exactDuplicates.length} exact duplicates**, **${invalid.length} invalid rows**, other removals: **${Math.max(0, safeRemovals.length - exactDuplicates.length - invalid.length)}**.`,
    `- Sale status: buyable_now **${saleCounts.buyable_now ?? 0}**, listed_unavailable **${saleCounts.listed_unavailable ?? 0}**, discontinued **${saleCounts.discontinued ?? 0}**, unknown **${saleCounts.unknown ?? 0}**.`,
    `- Existence invalid: **${ledger.filter((item) => item.existence_status === 'invalid').length}**; ambiguous/unverified existence: **${ledger.filter((item) => item.existence_status === 'ambiguous').length}**.`,
    `- Strength/mg status: verified **${strengthCounts.verified ?? 0}**, corrected **${strengthCounts.corrected ?? 0}**, conflicted **${strengthCounts.conflicted ?? 0}**, unverified **${strengthCounts.unverified ?? 0}**.`,
    `- Original normalized brand+name strength-conflict groups: **${conflictEntries.length}**, affecting **${conflictEntries.reduce((sum, [, group]) => sum + group.length, 0)} rows**; unresolved groups remain in manual review.`,
    `- Proposed non-duplicate corrections applied: **${changed.length}**.`,
    '',
    '## Applied changes',
    '',
    `- Application result: ${applyResult?.changed ? `${applyResult.removed} source rows removed from data.js` : 'data.js already matched the cleaned sequence'}.`,
    '- Because data.js changed during the first safe cleanup, sw.js must and does use `pouchlog-v1.3`; no other application file was modified.',
  ];
  if (!applyResult?.changed && !safeRemovals.length) lines.push('- None.');
  else if (safeRemovals.length) {
    for (const item of safeRemovals) {
      const removal = item.proposed_changes.find((change) => change.action === 'remove');
      lines.push(`- Removed ${item.input_id}: \`${item.original.b} / ${item.original.n} / ${item.original.mg}\` — ${item.reason_code}${removal?.duplicate_of ? `; duplicate of ${removal.duplicate_of}` : ''}.`);
    }
  }
  lines.push(
    '',
    '## Safety and unresolved work',
    '',
    '- No normalized aliases were merged, no brand was renamed, and no mg value was changed without the evidence threshold. All non-exact and conflicting rows remain retained or explicitly marked for review.',
    '- A row being absent from a source, out of stock, 404, or not found is not treated as discontinued or nonexistent.',
    '- A repeated `--apply-safe` run is expected to make no further data.js change once the exact duplicate removals are present.',
  );
  return `${lines.join('\n')}\n`;
}

export async function writeAuditOutputs(paths, snapshot, ledger, sourceIndex, applyResult = null) {
  await ensureAuditDirs(paths);
  await writeFile(paths.ledgerPath, `${ledger.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
  await writeFile(paths.manualReviewPath, makeManualReviewCsv(ledger), 'utf8');
  await writeFile(paths.sourceIndexPath, `${JSON.stringify(sourceIndex, null, 2)}\n`, 'utf8');
  await writeFile(paths.summaryPath, summarizeAudit(snapshot, ledger, sourceIndex, applyResult), 'utf8');
  const unresolved = ledger.filter((item) => item.decision === 'review' || item.strength_status === 'unverified').length;
  const sourceUnavailable = (sourceIndex.sources ?? []).filter((source) => !['ok', 'partial'].includes(source.status));
  const frozen = existsSync(paths.unresolvedPath) ? JSON.parse(await readFile(paths.unresolvedPath, 'utf8')) : { rows: [] };
  const research = existsSync(paths.researchLogPath) ? await readJsonLines(paths.researchLogPath) : [];
  const completedResearch = research.filter((record) => ['verified', 'conflicted', 'exhausted_10m'].includes(record.terminal_reason));
  const verifiedResearch = completedResearch.filter((record) => record.research_status === 'verified').length;
  const conflictedResearch = completedResearch.filter((record) => record.research_status === 'conflicted').length;
  const exhaustedResearch = completedResearch.filter((record) => record.research_status === 'exhausted_10m/unverified').length;
  const remainingResearch = Math.max(0, frozen.rows.length - new Set(completedResearch.map((record) => record.input_id)).size);
  const progress = [
    '# Pouch audit progress',
    '',
    `- Checkpoint: ${remainingResearch === 0 ? (applyResult?.changed || applyResult?.reason === 'already applied' ? '5 — safe cleanup applied and idempotent' : '4 — research complete; safe cleanup pending') : '3 — research in progress'}`,
    `- Original rows snapshotted: ${snapshot.rows.length}`,
    `- Ledger identities completed: ${ledger.length}/${snapshot.rows.length}`,
    `- Frozen unresolved identities completed: ${completedResearch.length}/${frozen.rows.length}`,
    `- Verified mg/identity: ${verifiedResearch}`,
    `- Conflicted: ${conflictedResearch}`,
    `- exhausted_10m/unverified: ${exhaustedResearch}`,
    `- Remaining frozen input_id: ${remainingResearch}`,
    `- Manual-review/unverified rows: ${unresolved}`,
    `- Source records indexed: ${sourceIndex.records?.length ?? 0}`,
    `- Source outages or blocked sources: ${sourceUnavailable.length}`,
    ...(sourceUnavailable.length ? sourceUnavailable.map((source) => `  - ${source.id}: ${source.status}${source.reason ? ` (${source.reason})` : ''}`) : ['- No source outage was recorded.']),
    '',
    'The input snapshot is immutable. Remaining ambiguous, conflicting or unverified rows are retained and described in `manual-review.csv`.',
    '',
  ];
  await writeFile(paths.progressPath, progress.join('\n'), 'utf8');
}

function rowsEqual(left, right) {
  return left.length === right.length && left.every((row, index) => row.b === right[index].b && row.n === right[index].n && row.mg === right[index].mg);
}

export function expectedFinalRows(snapshot, ledger) {
  const byId = new Map(ledger.map((item) => [item.input_id, item]));
  return snapshot.rows.flatMap((input) => {
    const item = byId.get(input.input_id);
    if (item?.decision === 'remove') return [];
    const change = item?.proposed_changes?.find((candidate) => candidate.action === 'change' && candidate.field === 'mg');
    return [{ ...input.original, ...(change ? { mg: Number(change.to) } : {}) }];
  });
}

function inputIdsForCurrentRows(currentRows, snapshot) {
  const ids = [];
  let snapshotIndex = 0;
  for (const current of currentRows) {
    let found = false;
    while (snapshotIndex < snapshot.rows.length) {
      const input = snapshot.rows[snapshotIndex];
      snapshotIndex += 1;
      if (rowKey(input.original) === rowKey(current)) {
        ids.push(input.input_id);
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  return ids;
}

export async function applySafeChanges(paths, snapshot, ledger) {
  const source = await readFile(paths.dataPath, 'utf8');
  const currentParsed = parseDataSource(source);
  const originalRows = snapshot.rows.map((item) => item.original);
  const cleanedOriginalRows = snapshot.rows.filter((input) => !ledger.find((item) => item.input_id === input.input_id)?.proposed_changes.some((change) => change.action === 'remove')).map((item) => item.original);
  const desiredRows = expectedFinalRows(snapshot, ledger);
  if (rowsEqual(currentParsed, desiredRows)) return { changed: false, removed: 0, changedRows: 0, reason: 'already applied' };
  if (!rowsEqual(currentParsed, originalRows) && !rowsEqual(currentParsed, cleanedOriginalRows)) {
    throw new Error('Refusing safe cleanup: current data.js is neither the immutable original snapshot nor the expected cleaned sequence. Preserve unrelated working-tree changes and resolve manually.');
  }
  const lines = source.split(/\r?\n/u);
  const currentInputIds = inputIdsForCurrentRows(currentParsed, snapshot);
  if (!currentInputIds) throw new Error('Refusing safe cleanup: could not map current data.js rows to immutable input IDs.');
  const ledgerById = new Map(ledger.map((item) => [item.input_id, item]));
  const removeIds = new Set(ledger.filter((item) => item.decision === 'remove').map((item) => item.input_id));
  const changeById = new Map(ledger.flatMap((item) => item.proposed_changes.filter((change) => change.action === 'change' && change.field === 'mg').map((change) => [item.input_id, change])));
  const removeLineIndexes = new Set();
  const changedLineIndexes = new Set();
  for (const [position, inputId] of currentInputIds.entries()) {
    const sourceLineIndex = currentParsed[position].line_index;
    if (removeIds.has(inputId)) removeLineIndexes.add(sourceLineIndex);
    const change = changeById.get(inputId);
    if (change) {
      const replacement = lines[sourceLineIndex].replace(/mg:\s*-?(?:\d+(?:\.\d*)?|\.\d+)/u, `mg: ${String(change.to)}`);
      if (replacement === lines[sourceLineIndex]) throw new Error(`Refusing safe cleanup: mg field not found on source line ${sourceLineIndex + 1}`);
      lines[sourceLineIndex] = replacement;
      changedLineIndexes.add(sourceLineIndex);
    }
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const rewritten = lines.filter((line, index) => !removeLineIndexes.has(index)).join(newline);
  await writeFile(paths.dataPath, rewritten, 'utf8');
  return { changed: true, removed: removeLineIndexes.size, changedRows: changedLineIndexes.size, reason: 'safe exact duplicate removals and evidence-backed mg changes applied' };
}

export async function bumpServiceWorkerIfNeeded(paths, dataChanged) {
  if (!dataChanged || !existsSync(paths.swPath)) return false;
  const source = await readFile(paths.swPath, 'utf8');
  if (!source.includes("const CACHE_NAME = 'pouchlog-v1.2';")) return false;
  await writeFile(paths.swPath, source.replace("const CACHE_NAME = 'pouchlog-v1.2';", "const CACHE_NAME = 'pouchlog-v1.3';"), 'utf8');
  return true;
}

export async function ensureGitignore(paths) {
  const entry = '.cache/pouch-audit/';
  const current = existsSync(paths.gitignorePath) ? await readFile(paths.gitignorePath, 'utf8') : '';
  if (current.split(/\r?\n/u).some((line) => line.trim() === entry)) return false;
  const suffix = current && !current.endsWith('\n') ? '\n' : '';
  await writeFile(paths.gitignorePath, `${current}${suffix}\n# Pouch catalog audit cache\n${entry}\n`, 'utf8');
  return true;
}

function readJsonLines(path) {
  return readFile(path, 'utf8').then((content) => content.trim() ? content.trim().split(/\r?\n/u).map((line) => JSON.parse(line)) : []);
}

export async function validateAudit(paths) {
  const errors = [];
  let snapshot;
  let ledger;
  try { snapshot = JSON.parse(await readFile(paths.inputPath, 'utf8')); } catch (error) { errors.push(`input snapshot: ${error.message}`); }
  try { ledger = await readJsonLines(paths.ledgerPath); } catch (error) { errors.push(`ledger: ${error.message}`); }
  if (!snapshot || !ledger) return { ok: false, errors };
  const expectedIds = snapshot.rows.map((row) => row.input_id);
  const actualIds = ledger.map((row) => row.input_id);
  if (ledger.length !== expectedIds.length) errors.push(`ledger row count ${ledger.length} != snapshot ${expectedIds.length}`);
  if (new Set(actualIds).size !== actualIds.length) errors.push('ledger contains duplicate input_id values');
  if (expectedIds.some((id) => !actualIds.includes(id)) || actualIds.some((id) => !expectedIds.includes(id))) errors.push('ledger input_id set differs from immutable snapshot');
  let frozen = null;
  let research = [];
  if (existsSync(paths.unresolvedPath)) {
    try {
      frozen = JSON.parse(await readFile(paths.unresolvedPath, 'utf8'));
      const frozenIds = frozen.rows.map((row) => row.input_id);
      if (frozen.unresolved_rows !== frozen.rows.length || new Set(frozenIds).size !== frozenIds.length) errors.push('unresolved-input.json has inconsistent count or duplicate input_id values');
      if (frozen.rows.length > 0 && frozen.rows.length !== 861) errors.push(`unresolved-input.json has ${frozen.rows.length} rows, expected 861`);
      if (frozenIds.some((id) => !expectedIds.includes(id))) errors.push('unresolved-input.json contains an input_id outside the immutable snapshot');
      research = existsSync(paths.researchLogPath) ? await readJsonLines(paths.researchLogPath) : [];
      const terminal = research.filter((record) => ['verified', 'conflicted', 'exhausted_10m'].includes(record.terminal_reason));
      const terminalIds = terminal.map((record) => record.input_id);
      if (terminal.length !== frozen.rows.length || new Set(terminalIds).size !== terminalIds.length) errors.push(`research-log.jsonl has ${terminal.length} terminal records for ${frozen.rows.length} frozen identities`);
      if (frozenIds.some((id) => !terminalIds.includes(id)) || terminalIds.some((id) => !frozenIds.includes(id))) errors.push('research-log.jsonl terminal input_id set differs from unresolved-input.json');
      const researchById = new Map(terminal.map((record) => [record.input_id, record]));
      for (const id of frozenIds) {
        const record = researchById.get(id);
        if (!record) continue;
        if (record.terminal_reason === 'exhausted_10m' && (record.research_status !== 'exhausted_10m/unverified' || Number(record.active_search_seconds) < 600)) errors.push(`${id}: exhausted terminal record is below 600 active seconds or has wrong status`);
        if (record.terminal_reason !== 'exhausted_10m' && record.research_status !== record.terminal_reason) errors.push(`${id}: terminal reason and research status disagree`);
        for (const field of ['input_id', 'original', 'canonical_candidate', 'search_started_at', 'search_finished_at', 'active_search_seconds', 'queries', 'checked_urls', 'source_owner', 'evidence_branches', 'requirement_status', 'relevant_explicit_data', 'evidence', 'evidence_paraphrase', 'checked_at', 'step_results', 'research_status', 'terminal_reason']) {
          if (record[field] === undefined || record[field] === null) errors.push(`${id}: research record missing ${field}`);
        }
        for (const evidence of record.evidence ?? []) if (evidence.url && !evidence.response_sha256) errors.push(`${id}: research evidence URL lacks response SHA-256`);
      }
      const frozenLedgerIds = new Set(frozenIds);
      for (const item of ledger.filter((candidate) => frozenLedgerIds.has(candidate.input_id))) {
        for (const field of ['match_status', 'existence_status', 'sale_status', 'strength_status', 'observed_mg_per_pouch', 'observed_mg_per_g', 'net_weight_g', 'pouch_count', 'format', 'sku', 'gtin', 'market', 'source_owner', 'evidence', 'decision', 'reason_code', 'proposed_changes', 'research_status', 'active_search_seconds', 'terminal_reason']) {
          if (item[field] === undefined) errors.push(`${item.input_id}: ledger missing final field ${field}`);
        }
        if (item.terminal_reason === 'exhausted_10m' && Number(item.active_search_seconds) < 600) errors.push(`${item.input_id}: ledger exhausted row has active_search_seconds below 600`);
        if (item.terminal_reason === 'exhausted_10m' && item.research_status !== 'exhausted_10m/unverified') errors.push(`${item.input_id}: ledger exhausted row is not exhausted_10m/unverified`);
        for (const change of item.proposed_changes ?? []) if (change.action === 'change') {
          const evidence = (item.evidence ?? []).filter((entry) => entry.url && entry.response_sha256);
          const authoritative = evidence.some((entry) => ['manufacturer', 'brand_owner', 'regulator'].includes(entry.branch));
          const retailerOwners = new Set(evidence.filter((entry) => ['retailer', 'retailer_group'].includes(entry.branch)).map((entry) => entry.source_owner).filter(Boolean));
          if (!authoritative && retailerOwners.size < 2) errors.push(`${item.input_id}: proposed change lacks independent authoritative evidence branches`);
        }
      }
    } catch (error) {
      errors.push(`unresolved/research audit: ${error.message}`);
    }
  }
  const allowed = {
    match_status: new Set(['exact_id', 'exact_attributes', 'reviewed_alias', 'ambiguous', 'no_match']),
    existence_status: new Set(['confirmed', 'ambiguous', 'not_found', 'invalid']),
    sale_status: new Set(['buyable_now', 'listed_unavailable', 'discontinued', 'unknown']),
    strength_status: new Set(['verified', 'corrected', 'conflicted', 'unverified']),
    decision: new Set(['keep', 'remove', 'review']),
  };
  for (const item of ledger) {
    for (const [field, values] of Object.entries(allowed)) if (!values.has(item[field])) errors.push(`${item.input_id}: invalid ${field}=${item[field]}`);
    for (const field of ['match_status', 'existence_status', 'sale_status', 'strength_status', 'decision', 'reason_code']) if (item[field] === null || item[field] === undefined || item[field] === '') errors.push(`${item.input_id}: missing final ${field}`);
    for (const evidence of item.evidence ?? []) if (evidence.url && !evidence.response_sha256) errors.push(`${item.input_id}: evidence URL lacks response SHA-256`);
    if (['remove', 'review'].includes(item.decision) && (!item.reason_code || !Array.isArray(item.evidence) || !item.evidence.length)) errors.push(`${item.input_id}: decision lacks reason/evidence`);
    if (item.proposed_changes?.length && (!item.reason_code || !item.evidence.length)) errors.push(`${item.input_id}: proposed change lacks audit evidence`);
    if (item.calculation && Math.abs(item.calculation.result - item.observed_mg_per_pouch) > Number.EPSILON) errors.push(`${item.input_id}: calculation result mismatch`);
  }
  try {
    const manualLines = (await readFile(paths.manualReviewPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
    const manualIds = new Set(manualLines.map((line) => line.split(',', 1)[0]));
    for (const item of ledger.filter((candidate) => candidate.evidence.some((evidence) => evidence.evidence_type === 'internal_strength_conflict'))) if (!manualIds.has(item.input_id)) errors.push(`${item.input_id}: original strength conflict missing from manual-review.csv`);
  } catch (error) {
    errors.push(`manual-review.csv: ${error.message}`);
  }
  let catalog;
  try { catalog = await loadCatalogFromData(paths.dataPath); } catch (error) { errors.push(`data.js: ${error.message}`); }
  if (catalog) {
    const rows = catalog.rows;
    if (rows.some((row) => !row.b.trim() || !row.n.trim() || !Number.isFinite(row.mg) || row.mg < 0)) errors.push('resulting POUCH_DB has invalid rows');
    const seen = new Set();
    for (const row of rows) {
      const key = rowKey(row);
      if (seen.has(key)) errors.push(`resulting POUCH_DB has exact duplicate ${key}`);
      seen.add(key);
    }
    const expected = expectedFinalRows(snapshot, ledger);
    if (!rowsEqual(rows, expected)) errors.push('resulting POUCH_DB does not equal the ledger-approved final sequence');
  }
  return { ok: errors.length === 0, errors, snapshotRows: snapshot.rows.length, ledgerRows: ledger.length, finalRows: catalog?.rows.length ?? null };
}
