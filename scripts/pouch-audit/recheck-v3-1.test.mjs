import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync as readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('77 alias and marketing title resolve to the exact frozen identity', async () => {
  const { compareProductIdentity } = await import('./recheck-v3-1-identity.mjs');
  const result = compareProductIdentity(
    { b: '77 Pouches', n: '77 Cola & Cherry', mg: 10.4 },
    { brand_raw: '77', product_name_raw: '77 Cola & Cherry 10.4mg 🛒 Next Day Shipping' },
  );
  assert.equal(result.identity_match, 'exact');
  assert.equal(result.brand_key, '77 pouches');
  assert.equal(result.product_core, 'cola cherry');
});

test('an unexplained variant token is not exact', async () => {
  const { compareProductIdentity } = await import('./recheck-v3-1-identity.mjs');
  const result = compareProductIdentity(
    { b: 'FUMI', n: 'Fumi Freezy Mint', mg: 8 },
    { brand_raw: 'FUMI', product_name_raw: 'FUMI Freezy Mint Mini 4mg' },
  );
  assert.equal(result.identity_match, 'near');
  assert.deepEqual(result.extra_variant_tokens, ['mini']);
});

test('unknown brand never inherits the frozen brand', async () => {
  const { compareProductIdentity } = await import('./recheck-v3-1-identity.mjs');
  const result = compareProductIdentity(
    { b: '77 Pouches', n: '77 Cola & Cherry', mg: 10.4 },
    { product_name_raw: '77 Cola & Cherry 10.4mg' },
  );
  assert.equal(result.identity_match, 'near');
  assert.equal(result.brand_key, null);
});

test('parser extracts JSON-LD product facts and labelled mg per pouch', async () => {
  const { parseProductFacts } = await import('./recheck-v3-1-transport.mjs');
  const body = readSync(new URL('./fixtures/v3-1/77-cola-cherry.html', import.meta.url), 'utf8');
  const parsed = parseProductFacts({ status: 200, body, final_url: 'https://www.northerner.com/uk/77/cola-cherry' });
  assert.equal(parsed.page_kind, 'product_detail');
  assert.equal(parsed.extracted.brand_raw, '77');
  assert.equal(parsed.extracted.product_name_raw, '77 Cola & Cherry');
  assert.deepEqual(parsed.extracted.strength_claims[0], {
    value: 10.4, unit: 'mg', basis: 'per_pouch',
    raw_label: 'Nicotine per pouch', raw_value: '10.4 mg', method: 'json_ld',
  });
});

test('mg per gram is not relabelled as mg per pouch', async () => {
  const { parseProductFacts } = await import('./recheck-v3-1-transport.mjs');
  const body = readSync(new URL('./fixtures/v3-1/77-cola-vanilla-wrong-variant.html', import.meta.url), 'utf8');
  const parsed = parseProductFacts({ status: 200, body, final_url: 'https://pouches.eu/products/77-cola-vanilla-20mg-g' });
  assert.equal(parsed.extracted.strength_claims.some((claim) => claim.basis === 'per_pouch'), false);
  assert.equal(parsed.extracted.strength_claims.some((claim) => claim.basis === 'per_g' && claim.value === 20), true);
});

test('parser cannot receive a frozen card to synthesize identity', async () => {
  const { parseProductFacts } = await import('./recheck-v3-1-transport.mjs');
  assert.equal(parseProductFacts.length, 1);
  const parsed = parseProductFacts({ status: 200, body: '<html><title>10mg</title></html>', final_url: 'https://example.test/product' });
  assert.equal(parsed.extracted.brand_raw, undefined);
});

test('Haypp and Northerner resolve to one owner branch', async () => {
  const { sourceForUrl, independentSourceBranches } = await import('./recheck-v3-1-sources.mjs');
  const sources = independentSourceBranches([
    sourceForUrl('https://www.haypp.com/uk/product-a'),
    sourceForUrl('https://www.northerner.com/uk/product-a'),
  ]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].owner_group_id, 'haypp-group');
});

test('unknown retailer-looking host remains unknown', async () => {
  const { sourceForUrl } = await import('./recheck-v3-1-sources.mjs');
  assert.equal(sourceForUrl('https://cheap-pouches.example/product').source_class, 'unknown');
});

function exactEvents({ writerDecision = 'exact_match', urls = ['https://www.northerner.com/uk/77/cola-cherry'], sources = urls } = {}) {
  const opened = urls.map((url, index) => ({
    event_id: `event-${index + 1}`,
    input_id: 'fixture-77-cola-cherry', event_type: 'url_opened', sequence: index + 10,
    recorded_at: new Date(0).toISOString(), previous_event_sha256: null,
    event_sha256: '0'.repeat(64),
    payload: {
      candidate_url: url, final_url: url, status: 200, parse_status: 'parsed', page_kind: 'product_detail',
      extracted: { brand_raw: '77', product_name_raw: '77 Cola & Cherry', strength_claims: [{ value: 10.4, unit: 'mg', basis: 'per_pouch', raw_label: 'Nicotine per pouch', raw_value: '10.4 mg', method: 'json_ld' }] },
      source_url: sources[index] ?? url,
    },
  }));
  const searchEvents = [
    ['bing', '77 Cola Cherry nicotine pouch product'],
    ['google', '77 Cola Cherry nicotine pouch mg per pouch'],
    ['bing', '77 Cola Cherry exact product variant'],
    ['google', '77 Cola Cherry pouch strength source'],
  ].map(([system, query], index) => ({
    event_id: `search-${index + 1}`, input_id: 'fixture-77-cola-cherry', event_type: 'search_attempt', sequence: index + 1,
    recorded_at: new Date(0).toISOString(), previous_event_sha256: null, event_sha256: '0'.repeat(64),
    payload: { system, query, status: 200, parse_status: 'parsed', cache_hit: false, candidate_urls: urls },
  }));
  const ownerEvents = ['bing', 'google'].map((system, index) => ({
    event_id: `owner-${index + 1}`, input_id: 'fixture-77-cola-cherry', event_type: 'owner_lookup', sequence: index + 20,
    recorded_at: new Date(0).toISOString(), previous_event_sha256: null, event_sha256: '0'.repeat(64),
    payload: { system, query: `77 Pouches owner ${system}`, status: 200, parse_status: 'parsed', cache_hit: false, owner: 'fixture owner' },
  }));
  const decisions = urls.map((url, index) => ({ event_id: `decision-${index + 1}`, input_id: 'fixture-77-cola-cherry', event_type: 'candidate_decision', sequence: index + 30, recorded_at: new Date(0).toISOString(), previous_event_sha256: null, event_sha256: '0'.repeat(64), payload: { candidate_url: url, match_decision: writerDecision, reason: 'fixture' } }));
  return [...searchEvents, ...opened, ...ownerEvents, ...decisions];
}

function fixtureRow() {
  return { input_id: 'fixture-77-cola-cherry', original_index: 0, original: { b: '77 Pouches', n: '77 Cola & Cherry', mg: 10.4 }, input_card_sha256: '0'.repeat(64) };
}

test('validator independently derives identity and ignores writer decision', async () => {
  const { deriveInputResult } = await import('./recheck-v3-1-validator.mjs');
  const row = deriveInputResult(fixtureRow(), exactEvents({ writerDecision: 'wrong_variant' }));
  assert.equal(row.gates.exact_evidence_count, 1);
  assert.equal(row.outcome, 'unresolved_after_complete_search');
});

test('deriveStrength converts mg per gram only with same-page weight and count', async () => {
  const { deriveStrength } = await import('./recheck-v3-1-validator.mjs');
  assert.equal(deriveStrength({ strength_claims: [{ value: 16, unit: 'mg', basis: 'per_g' }], net_weight_g: 13, pouch_count: 20 }).value, 10.4);
  assert.equal(deriveStrength({ strength_claims: [{ value: 16, unit: 'mg', basis: 'per_g' }] }).value, null);
});

test('one official exact source verifies a product', async () => {
  const { deriveInputResult } = await import('./recheck-v3-1-validator.mjs');
  const row = deriveInputResult(fixtureRow(), exactEvents({ urls: ['https://www.zyn.com/products/fixture'] }));
  assert.equal(row.outcome, 'verified');
});

test('two Haypp-owned retailer URLs are one evidence branch', async () => {
  const { deriveInputResult } = await import('./recheck-v3-1-validator.mjs');
  const result = deriveInputResult(fixtureRow(), exactEvents({ urls: ['https://www.haypp.com/a', 'https://www.northerner.com/b'] }));
  assert.notEqual(result.outcome, 'verified');
});

test('validator source does not import research or QA', async () => {
  const source = await readFile(new URL('./recheck-v3-1-validator.mjs', import.meta.url), 'utf8').catch(() => '');
  assert.doesNotMatch(source, /recheck-v3-1-(?:research|qa)/u);
});

test('QA rejects a stored verified result unsupported by raw facts', async () => {
  const { qaInput } = await import('./recheck-v3-1-qa.mjs');
  const qa = qaInput(fixtureRow(), [], { ...fixtureRow(), outcome: 'verified' });
  assert.equal(qa.qa_status, 'qa_failed');
  assert.match(qa.errors.join('\n'), /exact|source|strength/iu);
});

test('QA source imports neither research nor validator', async () => {
  const source = await readFile(new URL('./recheck-v3-1-qa.mjs', import.meta.url), 'utf8').catch(() => '');
  assert.doesNotMatch(source, /recheck-v3-1-(?:research|validator)/u);
});

test('deterministic gzip round-trips and report includes all sections', async () => {
  const { deterministicGzip, verifyGzip, buildReport } = await import('./recheck-v3-1-artifacts.mjs');
  const bytes = Buffer.from('raw evidence\n');
  const first = deterministicGzip(bytes);
  const second = deterministicGzip(bytes);
  assert.deepEqual(first, second);
  assert.equal(verifyGzip(first, (await import('./recheck-v3-schema.mjs')).sha256(bytes)), true);
  const report = buildReport({ rows: [{ input_id: 'fixture-1' }] }, [{ event_type: 'search_attempt', input_id: 'fixture-1' }], [{ input_id: 'fixture-1', outcome: 'unresolved_after_complete_search' }], [{ input_id: 'fixture-1', qa_status: 'qa_passed' }]);
  for (const heading of ['Raw queries', 'Candidates', 'Opened URLs', 'Decisions', 'Derived result', 'QA hashes']) assert.match(report, new RegExp(heading));
  assert.match(report, /fixture-1/u);
});

test('manifest fallback summary records actual transport fallbacks and catalog avoidance', async () => {
  const { summarizeFallbacks } = await import('./recheck-v3-1-artifacts.mjs');
  const summary = summarizeFallbacks([
    { event_type: 'transport_event', payload: { kind: 'search_http_proxy_fallback', proxy_url: 'https://r.jina.ai/http://www.google.com/search?q=x' } },
    { event_type: 'transport_event', payload: { kind: 'search_independent_fallback', fallback_url: 'https://html.duckduckgo.com/html/?q=x' } },
  ]);
  assert.deepEqual(summary, [
    'Jina AI proxy fallback used: 1',
    'DuckDuckGo independent fallback used: 1',
    'No catalog endpoints used; repeated catalog 404s were avoided by direct search/owner lookup.',
  ]);
});

test('safe apply is restricted to verified corrections and is idempotent', async () => {
  const { applyVerifiedChanges } = await import('./recheck-v3-1-apply.mjs');
  const data = 'export const POUCH_DB = [{ b: "77 Pouches", n: "77 Cola & Cherry", mg: 8 }];\n';
  const applyRow = { ...fixtureRow(), original: { ...fixtureRow().original, mg: 8 } };
  const gate = { snapshot: { rows: [applyRow] }, results: [{ ...applyRow, outcome: 'verified', verified_sources: [{ url: 'https://www.zyn.com/products/fixture', strength_mg_per_pouch: 10.4 }] }], qaRows: [{ input_id: applyRow.input_id, qa_status: 'qa_passed' }], validator: { ok: true, summary: { pending: 0, unreviewed: 0 } } };
  const once = applyVerifiedChanges(data, gate);
  const twice = applyVerifiedChanges(once.text, gate);
  assert.equal(once.changedRows.length, 1);
  assert.equal(twice.changedRows.length, 0);
  assert.equal(twice.text, once.text);
});

test('v3.1 raw writer writes only to caller-provided new log', async () => {
  const { researchOneInput } = await import('./recheck-v3-1-research.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'pouch-v31-'));
  const outputPath = join(dir, 'raw-events.jsonl');
  try {
    const fixture = readSync(new URL('./fixtures/v3-1/77-cola-cherry.html', import.meta.url), 'utf8');
    await researchOneInput(fixtureRow(), { outputPath, fetchImpl: async (url) => new Response(fixture, { status: 200, headers: { 'content-type': 'text/html' } }), searchSystems: [] });
    assert.equal(existsSync(outputPath), true);
    assert.doesNotMatch(readSync(outputPath, 'utf8'), /protocol_complete|qa_status|verified_sources/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('v3.1 snapshot builder freezes exactly 861 IDs and five pilot rows', async () => {
  const { buildSnapshot } = await import('./recheck-v3-1.mjs');
  const input = JSON.parse(await readFile(new URL('../../audit/pouches/input.json', import.meta.url), 'utf8'));
  const unresolved = JSON.parse(await readFile(new URL('../../audit/pouches/unresolved-input.json', import.meta.url), 'utf8'));
  const dataText = await readFile(new URL('../../data.js', import.meta.url), 'utf8');
  const snapshot = buildSnapshot({ input, unresolved, dataText });
  assert.equal(snapshot.rows.length, 861);
  assert.equal(new Set(snapshot.rows.map((row) => row.input_id)).size, 861);
  assert.equal(snapshot.rows.filter((row) => row.original.b === '77 Pouches').length, 5);
});

test('v3.1 CLI resolves a Windows workspace path without a duplicated drive prefix', async () => {
  const { PATHS } = await import('./recheck-v3-1.mjs');
  assert.match(PATHS.snapshot, /[\\/]audit[\\/]pouches[\\/]recheck-v3\.1[\\/]input-snapshot\.json$/u);
  assert.doesNotMatch(PATHS.snapshot, /^C:\\C:/iu);
});

test('v3.1 CLI prioritizes validation and QA flags over the pilot flag', async () => {
  const { selectCommand } = await import('./recheck-v3-1.mjs');
  assert.equal(selectCommand(['--validate', '--pilot']), 'validate');
  assert.equal(selectCommand(['--qa', '--pilot']), 'qa');
});

test('v3.1 research uses a transparent proxy fallback for blocked search and owner lookup', async () => {
  const { researchOneInput } = await import('./recheck-v3-1-research.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'pouch-v31-proxy-'));
  const outputPath = join(dir, 'raw-events.jsonl');
  try {
    await researchOneInput(fixtureRow(), {
      outputPath,
      searchSystems: [{ id: 'google', base: 'https://www.google.com/search?q=' }],
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.hostname === 'www.google.com') return new Response('blocked', { status: 429 });
        if (parsed.hostname === 'r.jina.ai') return new Response(JSON.stringify({ title: 'Proxy search', candidates: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        throw new Error(`unexpected URL: ${url}`);
      },
    });
    const events = (await readFile(outputPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    const search = events.find((event) => event.event_type === 'search_attempt');
    const owner = events.find((event) => event.event_type === 'owner_lookup');
    assert.equal(search.payload.status, 200);
    assert.equal(search.payload.transport_fallback, 'jina_ai');
    assert.equal(owner.payload.status, 200);
    assert.equal(owner.payload.transport_fallback, 'jina_ai');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('v3.1 research uses an independent DuckDuckGo fallback when the proxy is blocked', async () => {
  const { researchOneInput } = await import('./recheck-v3-1-research.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'pouch-v31-ddg-'));
  const outputPath = join(dir, 'raw-events.jsonl');
  try {
    await researchOneInput(fixtureRow(), {
      outputPath,
      searchSystems: [{ id: 'google', base: 'https://www.google.com/search?q=' }],
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.hostname === 'www.google.com') return new Response('blocked', { status: 429 });
        if (parsed.hostname === 'r.jina.ai') return new Response('blocked', { status: 403 });
        if (parsed.hostname === 'html.duckduckgo.com') return new Response(JSON.stringify({ title: 'DDG fallback', candidates: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        throw new Error(`unexpected URL: ${url}`);
      },
    });
    const events = (await readFile(outputPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    const search = events.find((event) => event.event_type === 'search_attempt');
    const owner = events.find((event) => event.event_type === 'owner_lookup');
    assert.equal(search.payload.system, 'duckduckgo');
    assert.equal(search.payload.transport_fallback, 'duckduckgo');
    assert.equal(owner.payload.system, 'google');
    assert.equal(owner.payload.fallback_system, 'duckduckgo');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
