import test from 'node:test';
import assert from 'node:assert/strict';
import { V2_OUTCOMES, classifyCandidate, repairDirectSourceMetadata, validateCard, validateV2Set, v2CardToLedger } from './recheck-v2.mjs';

function validCard(overrides = {}) {
  return {
    schema: 2,
    input_id: 'input-0001-example',
    original: { b: 'Example', n: 'Example Mint', mg: 10 },
    assessed_identity: {
      brand: 'Example',
      full_name: 'Example Mint',
      variant: 'Mint',
      strength_mg_per_pouch: 10,
      market: 'UK retail',
      market_basis: 'The frozen input has no market field; UK retail is the documented reference market for this catalog.',
    },
    owner_resolution: {
      status: 'not_identified',
      owner: null,
      attempts: [{ method: 'brand-search', query: 'Example official nicotine pouch manufacturer', url: 'https://www.google.com/search?q=Example', status: 200, title: 'Google', checked_at: '2026-08-14T00:00:00.000Z', response_sha256: 'a'.repeat(64), note: 'No owner identified.' }],
    },
    outcome: 'not_verifiable_after_protocol',
    queries: [
      { system: 'google', query: '"Example" "Example Mint" "10 mg/pouch"', url: 'https://www.google.com/search?q=example1', status: 200, title: 'Google', checked_at: '2026-08-14T00:00:00.000Z', response_sha256: 'b'.repeat(64), result: 'discovery_only', new_domains: [], candidates: [] },
      { system: 'bing', query: 'Example Mint nicotine pouch 10 mg per pouch', url: 'https://www.bing.com/search?q=example2', status: 200, title: 'Bing', checked_at: '2026-08-14T00:00:00.000Z', response_sha256: 'c'.repeat(64), result: 'discovery_only', new_domains: [], candidates: [] },
      { system: 'google', query: '"Example Mint" "10 mg per pouch" official', url: 'https://www.google.com/search?q=example3', status: 200, title: 'Google', checked_at: '2026-08-14T00:00:00.000Z', response_sha256: 'd'.repeat(64), result: 'discovery_only', new_domains: [], candidates: [] },
      { system: 'bing', query: 'Example Mint nicotine pouch 10mg product', url: 'https://www.bing.com/search?q=example4', status: 200, title: 'Bing', checked_at: '2026-08-14T00:00:00.000Z', response_sha256: 'e'.repeat(64), result: 'discovery_only', new_domains: [], candidates: [] },
    ],
    direct_sources: [
      { url: 'https://retailer-a.example/catalog', source_owner: 'Retailer A', evidence_branch: 'retailer_a', source_type: 'catalog_index', status: 200, title: 'Retailer A', checked_at: '2026-08-14T00:00:00.000Z', response_sha256: 'f'.repeat(64), explicit: { brand: null, name: null, variant: null, strength_mg_per_pouch: null, mg_per_g: null, net_weight_g: null, pouch_count: null, sku: null, gtin: null, market: 'UK retail' }, match_decision: 'near_match', match_reason: 'Catalog page opened; no exact product detail was found.', evidence_paraphrase: 'Catalog was checked without an exact product detail.' },
      { url: 'https://retailer-b.example/catalog', source_owner: 'Retailer B', evidence_branch: 'retailer_b', source_type: 'catalog_index', status: 200, title: 'Retailer B', checked_at: '2026-08-14T00:00:00.000Z', response_sha256: '1'.repeat(64), explicit: { brand: null, name: null, variant: null, strength_mg_per_pouch: null, mg_per_g: null, net_weight_g: null, pouch_count: null, sku: null, gtin: null, market: 'UK retail' }, match_decision: 'near_match', match_reason: 'Catalog page opened; no exact product detail was found.', evidence_paraphrase: 'Catalog was checked without an exact product detail.' },
      { url: 'https://retailer-c.example/catalog', source_owner: 'Retailer C', evidence_branch: 'retailer_c', source_type: 'catalog_index', status: 200, title: 'Retailer C', checked_at: '2026-08-14T00:00:00.000Z', response_sha256: '2'.repeat(64), explicit: { brand: null, name: null, variant: null, strength_mg_per_pouch: null, mg_per_g: null, net_weight_g: null, pouch_count: null, sku: null, gtin: null, market: 'UK retail' }, match_decision: 'near_match', match_reason: 'Catalog page opened; no exact product detail was found.', evidence_paraphrase: 'Catalog was checked without an exact product detail.' },
    ],
    protocol: {
      official_catalog: { status: 'not_identified_after_lookup', urls: [] },
      relevant_registry: { market: 'UK retail', status: 'not_applicable_to_unidentified_owner', urls: [] },
      retailer_branches: ['Retailer A', 'Retailer B', 'Retailer C'],
      candidate_reviews: [{ url: 'https://retailer-a.example/catalog', match_decision: 'near_match', reason: 'Catalog index only.' }],
      saturation: { final_queries: ['Example Mint nicotine pouch 10 mg per pouch official', 'Example Mint nicotine pouch 10mg product'], no_new_domains: true, no_new_candidates: true },
    },
    evidence_threshold: { met: false, explanation: 'No exact direct source with nicotine per pouch and no conflicting exact pair.' },
    evidence_paraphrase: 'The required owner, market, search, and three-retailer protocol was completed, but it did not produce evidence at the permitted threshold.',
    all_opened_urls: [
      'https://www.google.com/search?q=example1', 'https://www.bing.com/search?q=example2', 'https://www.google.com/search?q=example3', 'https://www.bing.com/search?q=example4',
      'https://retailer-a.example/catalog', 'https://retailer-b.example/catalog', 'https://retailer-c.example/catalog',
    ],
    checked_at: '2026-08-14T00:00:00.000Z',
    qa_status: 'pending',
    ...overrides,
  };
}

test('v2 validator rejects the forbidden exhausted_10m outcome', () => {
  const errors = validateCard({ ...validCard(), outcome: 'exhausted_10m' }, { expectedId: 'input-0001-example' });
  assert.ok(errors.some((error) => /outcome|exhausted/i.test(error)));
  assert.deepEqual(V2_OUTCOMES, ['verified', 'conflicted', 'not_verifiable_after_protocol']);
});

test('v2 validator accepts a complete not-verifiable card before QA', () => {
  assert.deepEqual(validateCard(validCard(), { expectedId: 'input-0001-example' }), []);
});

test('v2 set validator rejects duplicate IDs and set drift', () => {
  const card = validCard();
  const result = validateV2Set(
    [{ input_id: 'input-0001-example' }, { input_id: 'input-0002-example' }],
    [card, { ...card }],
    [],
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /duplicate|set/i.test(error)));
});

test('repair maps live catalog URLs to their real owner branches without changing response evidence', () => {
  const source = {
    url: 'https://www.snusdirect.com/sitemap.xml',
    source_type: 'product_detail',
    status: 200,
    title: null,
    checked_at: '2026-08-14T00:00:00.000Z',
    response_sha256: 'a'.repeat(64),
    explicit: { market: 'near_match' },
    match_decision: 'Retailer catalog/index was opened; a catalog hit is not promoted to product-level evidence.',
    match_reason: null,
  };
  const repaired = repairDirectSourceMetadata(source, 'UK/EU retail reference market');
  assert.equal(repaired.source_owner, 'Snusdirect');
  assert.equal(repaired.evidence_branch, 'retailer_snusdirect');
  assert.equal(repaired.source_type, 'retailer_catalog');
  assert.equal(repaired.match_decision, 'near_match');
  assert.equal(repaired.response_sha256, source.response_sha256);
  assert.equal(repaired.checked_at, source.checked_at);
});

test('candidate with an explicit different title strength is wrong_variant even when the frozen name omits mg', () => {
  const result = classifyCandidate(
    { b: '77 Pouches', n: '77 Cola & Vanilla', mg: 10.4 },
    { title: '77 Cola & Vanilla 16MG', observed_mg_per_pouch: null },
    { status: 200 },
  );
  assert.equal(result.decision, 'wrong_variant');
});

test('v2 ledger adapter keeps not-verifiable rows conservative and proposes no mg change', () => {
  const card = validCard();
  const old = { input_id: card.input_id, original: card.original, decision: 'keep', reason_code: 'unverified_keep_conservative', proposed_changes: [], review_steps: {} };
  const row = v2CardToLedger(card, old);
  assert.equal(row.research_status, 'not_verifiable_after_protocol');
  assert.equal(row.terminal_reason, 'not_verifiable_after_protocol');
  assert.equal(row.observed_mg_per_pouch, null);
  assert.deepEqual(row.proposed_changes, []);
  assert.equal(row.decision, 'keep');
});
