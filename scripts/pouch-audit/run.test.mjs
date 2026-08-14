import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freezeUnresolvedInput, inferProductType, matchExactProductVariant, normalizeCandidate, parseFdaAuthorized, parseManufacturerIndex, parseProductDetail, resolvePaths } from './lib.mjs';
import { buildResearchQueries, hasTerminalResearchState, independentEvidenceBranches, parseSearchResults, runResearch } from './research.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('./run.mjs', import.meta.url));

test('product type recognizes Czech caffeine labels without changing mg semantics', () => {
  assert.equal(inferProductType({ b: 'R4VE kofeinové', n: 'R4VE Energy Bubble Gun', mg: 0 }), 'caffeine_or_mixed');
});

test('product detail parser extracts explicit nicotine per pouch and sale fields', () => {
  const html = `
    <script type="application/ld+json">
      {"@type":"Product","name":"Killa Cold Mint","brand":{"@type":"Brand","name":"KILLA"},"sku":"KILLA-COLD-MINT","offers":{"price":"4.29","availability":"https://schema.org/InStock"},"additionalProperty":[{"name":"Nicotine per pouch","value":"13.2 mg/pouch"}]}
    </script>
    <div>Nicotine per pouch: 13.2 mg/pouch</div>
  `;
  const parsed = parseProductDetail(html, 'https://example.test/products/killa-cold-mint');
  assert.equal(parsed.title, 'Killa Cold Mint');
  assert.equal(parsed.brand, 'KILLA');
  assert.equal(parsed.observed_mg_per_pouch, 13.2);
  assert.equal(parsed.available, true);
  assert.equal(parsed.price, 4.29);
});

test('product detail parser uses visible product title when JSON-LD is absent', () => {
  const html = `
    <meta property="og:title" content="ZYN Citrus 6mg">
    <title>ZYN Citrus 6mg | Product page</title>
    <div>Nicotine: 12 mg/g · Net weight: 0.7 g · 20 pouches</div>
  `;
  const parsed = parseProductDetail(html, 'https://example.test/products/zyn-citrus-6mg');
  assert.equal(parsed.title, 'ZYN Citrus 6mg');
  assert.equal(parsed.observed_mg_per_g, 12);
  assert.equal(parsed.net_weight_g, 0.7);
  assert.equal(parsed.pouch_count, 20);
});

test('official catalog index parser keeps product links as discovery records', () => {
  const html = '<a href="/products/zyn-citrus-6mg">ZYN Citrus 6mg</a><a href="/collections/mint">Mint</a>';
  const parsed = parseManufacturerIndex(html, 'https://brand.example/catalog');
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].url, 'https://brand.example/products/zyn-citrus-6mg');
  assert.equal(parsed.records[0].evidence_kind, 'manufacturer_discovery');
});

test('FDA table parser exposes authorized product strength as regulator evidence', () => {
  const html = '<table><tr><td><strong>Swedish Match USA, Inc.</strong></td><td>ZYN Citrus 3 mg</td><td>ZYN Citrus 6 mg</td></tr></table>';
  const parsed = parseFdaAuthorized(html, 'https://fda.example/authorized');
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].title, 'ZYN Citrus 3 mg');
  assert.equal(parsed.records[0].brand, 'ZYN');
  assert.equal(parsed.records[0].observed_mg_per_pouch, 3);
});

test('candidate normalization preserves distinguishing strength tokens while normalizing unit spacing', () => {
  assert.equal(normalizeCandidate('ZYN Citrus 3mg'), normalizeCandidate('ZYN Citrus 3 mg'));
  assert.notEqual(normalizeCandidate('ZYN Citrus 3mg'), normalizeCandidate('ZYN Citrus 6mg'));
});

test('mg per gram conversion rejects pack weight and can count without exact pouch inputs', () => {
  const parsed = parseProductDetail('<div>Nicotine strength: 16 mg/g · Weight: 38 g · 2 cans</div>', 'https://example.test/products/pack');
  assert.equal(parsed.net_weight_g, null);
  assert.equal(parsed.pouch_count, null);
});

test('freezing unresolved input IDs is immutable across reruns', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pouch-audit-freeze-'));
  try {
    const paths = resolvePaths(temp, temp);
    const snapshot = {
      rows: [
        { input_id: 'input-0001-a', original_index: 1, original: { b: 'A', n: 'A One', mg: 1 }, original_sha256: 'a' },
        { input_id: 'input-0002-b', original_index: 2, original: { b: 'B', n: 'B Two', mg: 2 }, original_sha256: 'b' },
      ],
    };
    const firstLedger = [
      { input_id: 'input-0001-a', match_status: 'no_match', existence_status: 'ambiguous' },
      { input_id: 'input-0002-b', match_status: 'exact_attributes', existence_status: 'confirmed' },
    ];
    const first = await freezeUnresolvedInput(paths, snapshot, firstLedger);
    assert.equal(first.unresolved_rows, 1);
    const secondLedger = [
      { input_id: 'input-0001-a', match_status: 'exact_attributes', existence_status: 'confirmed' },
      { input_id: 'input-0002-b', match_status: 'no_match', existence_status: 'ambiguous' },
    ];
    await assert.rejects(() => freezeUnresolvedInput(paths, snapshot, secondLedger), /immutable|changed|frozen/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('exact product matching preserves variant and strength tokens', () => {
  const row = { b: '77 Pouches', n: '77 Black Currant Ice', mg: 10.4 };
  assert.equal(matchExactProductVariant(row, {
    title: 'Buy 77 Black Currant Ice 10.4mg Online',
    observed_mg_per_pouch: 10.4,
    source_owner: 'Haypp Group',
  }), true);
  assert.equal(matchExactProductVariant({ b: '77 Pouches', n: '77 Blueberry', mg: 10.4 }, {
    title: 'Killa Blueberry Nicotine Pouches',
    observed_mg_per_pouch: 12.8,
    source_owner: 'KILLA official brand catalog',
  }), false);
  assert.equal(matchExactProductVariant({ b: 'LOOP', n: 'LOOP Red Chili Mini', mg: 9.4 }, {
    title: 'Buy Loop Red Chili Melon Mini Online',
    observed_mg_per_pouch: 6.3,
    source_owner: 'Haypp Group',
  }), false);
  assert.equal(matchExactProductVariant({ b: '77 Pouches', n: '77 Black Currant Ice', mg: 10.4 }, {
    title: 'Blackcurrant Ice 77 Nicotine Pouches',
    observed_mg_per_pouch: 10.4,
    source_owner: 'electronicigar.com',
  }), true);
});

test('research contract creates exact bilingual queries and enforces terminal states', () => {
  const queries = buildResearchQueries({ b: 'ZYN', n: 'ZYN Citrus 6mg', mg: 6 });
  assert.ok(queries.some((query) => query.includes('"ZYN"') && query.includes('"ZYN Citrus 6mg"') && query.includes('"6 mg/pouch"')));
  assert.ok(queries.some((query) => query.includes('mg/sáček')));
  assert.equal(hasTerminalResearchState({ terminal_reason: 'verified', research_status: 'verified', active_search_seconds: 0 }), true);
  assert.equal(hasTerminalResearchState({ terminal_reason: 'conflicted', research_status: 'conflicted', active_search_seconds: 1 }), true);
  assert.equal(hasTerminalResearchState({ terminal_reason: 'exhausted_10m', research_status: 'exhausted_10m/unverified', active_search_seconds: 599 }), false);
  assert.equal(hasTerminalResearchState({ terminal_reason: 'exhausted_10m', research_status: 'exhausted_10m/unverified', active_search_seconds: 600 }), true);
});

test('Google discovery parser keeps result pages as discovery only', () => {
  const html = '<a href="https://example.test/pouches/blueberry"><h3>77 Blueberry 10.4 mg</h3></a>';
  const results = parseSearchResults(html, 'https://www.google.com/search?q=77');
  assert.deepEqual(results, [{ url: 'https://example.test/pouches/blueberry', title: '77 Blueberry 10.4 mg', evidence_kind: 'discovery_search' }]);
});

test('Bing discovery parser unwraps redirect URLs', () => {
  const encoded = Buffer.from('https://example.test/pouches/blueberry').toString('base64');
  const html = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/?u=a1${encoded}">77 Blueberry 10.4 mg</a></h2></li>`;
  const results = parseSearchResults(html, 'https://www.bing.com/search?q=77');
  assert.deepEqual(results, [{ url: 'https://example.test/pouches/blueberry', title: '77 Blueberry 10.4 mg', evidence_kind: 'discovery_search' }]);
});

test('Haypp and Northerner share one evidence branch', () => {
  assert.deepEqual(independentEvidenceBranches([
    { source_owner: 'Haypp Group', branch: 'retailer_group' },
    { source_owner: 'Haypp Group', branch: 'retailer_group' },
    { source_owner: 'Snusdirect', branch: 'retailer' },
    { source_owner: 'ZYN official', branch: 'manufacturer' },
  ]), ['manufacturer', 'retailer', 'retailer_group']);
});

test('research runner closes an offline unresolved row without continuation scope errors', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pouch-audit-research-runner-'));
  try {
    const paths = resolvePaths(temp, temp);
    const frozen = { rows: [{ input_id: 'input-0001-a', original_index: 1, original: { b: 'A', n: 'A One', mg: 1 } }] };
    const records = await runResearch({ paths, frozen, sourceIndex: { sources: [], records: [], detail_attempts: [] }, offline: true });
    assert.equal(records.length, 1);
    assert.equal(records[0].terminal_reason, 'exhausted_10m');
    assert.equal(records[0].active_search_seconds, 600);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function isolatedEnv(temp) {
  writeFileSync(join(temp, 'data.js'), execFileSync('git', ['show', 'HEAD:data.js'], { cwd: root, encoding: 'utf8' }));
  writeFileSync(join(temp, 'sw.js'), readFileSync(join(root, 'sw.js')));
  const auditDir = join(temp, 'audit', 'pouches');
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(auditDir, 'input.json'), readFileSync(join(root, 'audit', 'pouches', 'input.json')));
  return { POUCH_AUDIT_ROOT: temp, POUCH_AUDIT_WORKSPACE_ROOT: temp };
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('offline validation reports a complete audit contract', () => {
  const temp = mkdtempSync(join(tmpdir(), 'pouch-audit-validation-'));
  try {
    const env = isolatedEnv(temp);
    const refresh = run(['--refresh', '--offline', '--apply-safe'], env);
    assert.equal(refresh.status, 0, refresh.stderr || refresh.stdout);
    const result = run(['--validate', '--offline'], env);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /validation: ok/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('refresh creates a resumable snapshot and structured audit outputs', () => {
  const temp = mkdtempSync(join(tmpdir(), 'pouch-audit-test-'));
  try {
    const result = run(['--refresh', '--offline'], isolatedEnv(temp));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const file of ['input.json', 'ledger.jsonl', 'manual-review.csv', 'summary.md', 'progress.md']) {
      assert.equal(existsSync(join(temp, 'audit', 'pouches', file)), true, file);
    }
    const input = JSON.parse(readFileSync(join(temp, 'audit', 'pouches', 'input.json'), 'utf8'));
    const ledger = readFileSync(join(temp, 'audit', 'pouches', 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(input.rows.length, 1036);
    assert.equal(ledger.length, 1036);
    const firstLedgerRow = JSON.parse(ledger[0]);
    assert.deepEqual(Object.keys(firstLedgerRow.review_steps), ['mass_indexes', 'retailer_indexes', 'manufacturer_catalog', 'national_registries', 'exact_query']);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('safe application is idempotent after the first run', () => {
  const temp = mkdtempSync(join(tmpdir(), 'pouch-audit-idempotence-'));
  try {
    const env = isolatedEnv(temp);
    const first = run(['--refresh', '--offline', '--apply-safe'], env);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const second = run(['--refresh', '--offline', '--apply-safe'], env);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /no further data\.js change|already applied|idempotent/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
