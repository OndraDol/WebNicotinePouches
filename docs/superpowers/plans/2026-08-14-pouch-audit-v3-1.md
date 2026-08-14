# Pouch Audit v3.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opravit live produktovou extrakci a nezávislé důkazní odvození, provést nový izolovaný audit všech 861 pouch karet, bezpečně aplikovat pouze ověřené opravy a zveřejnit auditní commit na `origin/main`.

**Architecture:** V3.1 používá nové `recheck-v3-1-*` moduly a nový append-only adresář `audit/pouches/recheck-v3.1`; existující v2 a v3 artefakty jsou pouze hashově chráněný historický záznam. Research zapisuje raw fakta, validator a QA je odvozují nezávisle a globální gate povolí řádkovou změnu `data.js` jen pro přímo doložený `verified` výsledek.

**Tech Stack:** Node.js 24 ESM, `node:test`, standardní `fetch`, `node:crypto`, `node:zlib`, JSON/JSONL, PowerShell, Git/GitHub.

**Execution note:** Uživatel výslovně požaduje práci na aktuální větvi `main` a push na `origin/main`; tento požadavek nahrazuje obvyklé doporučení samostatného worktree. Force push je zakázán.

---

## File map

- Create `scripts/pouch-audit/recheck-v3-1-identity.mjs` — HTML/Unicode kanonizace, explicitní aliasy značek, porovnání produktového jádra a variantních tokenů.
- Create `scripts/pouch-audit/recheck-v3-1-transport.mjs` — live fetch wrapper a strukturovaná extrakce JSON-LD/labelled product facts.
- Create `scripts/pouch-audit/recheck-v3-1-sources.mjs` — immutable registry domén, source class a owner-group evidence.
- Create `scripts/pouch-audit/recheck-v3-1-research.mjs` — append-only discovery, owner lookup, kandidátní open a raw decision events.
- Create `scripts/pouch-audit/recheck-v3-1-validator.mjs` — read-only fail-closed derivace bez importu research/QA.
- Create `scripts/pouch-audit/recheck-v3-1-qa.mjs` — samostatná QA bez importu research/validator.
- Create `scripts/pouch-audit/recheck-v3-1-apply.mjs` — globální gate a řádková idempotentní aplikace.
- Create `scripts/pouch-audit/recheck-v3-1-artifacts.mjs` — report, manifest, deterministický gzip a kontrola rozbalených hashů.
- Create `scripts/pouch-audit/recheck-v3-1.mjs` — CLI pro freeze, pilot, full run, validate, QA, report, package a apply.
- Create `scripts/pouch-audit/recheck-v3-1.test.mjs` — jednotkové, integrační a CLI testy v3.1.
- Create `scripts/pouch-audit/fixtures/v3-1/77-cola-cherry.html` — minimální reálný tvar JSON-LD/title/product facts pro regresi.
- Create `scripts/pouch-audit/fixtures/v3-1/77-cola-vanilla-wrong-variant.html` — negativní variantní fixture.
- Modify `.gitignore` — commitnout malé v3.1 artefakty a gzip archivy, ignorovat nekomprimovaný raw log/report.
- Create `docs/superpowers/goals/2026-08-14-pouch-audit-v3-1-goal.md` — nový copy-paste `/goal` prompt.
- Generate `audit/pouches/recheck-v3.1/*` — nový snapshot, raw log, results, QA, report, manifest, summary a gzip archivy.

### Task 1: Preserve and checkpoint the completed v3 implementation

**Files:**
- Modify: `.gitignore`
- Modify: `scripts/pouch-audit/recheck-v3-research.mjs`
- Modify: `scripts/pouch-audit/recheck-v3.mjs`
- Modify: `scripts/pouch-audit/recheck-v3.test.mjs`
- Create: `scripts/pouch-audit/recheck-v3-proxy-recovery.mjs`

- [ ] **Step 1: Verify the existing v3 diff is limited to the completed audit scope**

Run:

```powershell
git status --short
git diff -- .gitignore scripts/pouch-audit/recheck-v3-research.mjs scripts/pouch-audit/recheck-v3.mjs scripts/pouch-audit/recheck-v3.test.mjs
node --test scripts/pouch-audit/recheck-v3.test.mjs
```

Expected: only the listed v3 files plus untracked v3 artifacts/helper are in scope; all 84 existing tests pass.

- [ ] **Step 2: Stage only the v3 implementation, not generated v3 artifacts**

```powershell
git add -- .gitignore scripts/pouch-audit/recheck-v3-research.mjs scripts/pouch-audit/recheck-v3.mjs scripts/pouch-audit/recheck-v3.test.mjs scripts/pouch-audit/recheck-v3-proxy-recovery.mjs
git diff --cached --check
git diff --cached --name-only
```

Expected staged paths: exactly five files; no `audit/pouches/recheck-v3/*` path.

- [ ] **Step 3: Commit the preserved v3 implementation**

```powershell
git commit -m "feat: preserve pouch audit v3 pipeline"
```

Expected: commit succeeds and generated v3 artifacts remain untracked and unchanged.

### Task 2: Add v3.1 identity canonicalization

**Files:**
- Create: `scripts/pouch-audit/recheck-v3-1-identity.mjs`
- Create: `scripts/pouch-audit/recheck-v3-1.test.mjs`

- [ ] **Step 1: Write failing canonical identity tests**

Add tests that import the wished-for API:

```js
import {
  canonicalBrand,
  canonicalProductCore,
  compareProductIdentity,
} from './recheck-v3-1-identity.mjs';

test('77 alias and marketing title resolve to the exact frozen identity', () => {
  const result = compareProductIdentity(
    { b: '77 Pouches', n: '77 Cola & Cherry', mg: 10.4 },
    { brand_raw: '77', product_name_raw: '77 Cola & Cherry 10.4mg 🛒 Next Day Shipping' },
  );
  assert.equal(result.identity_match, 'exact');
  assert.equal(result.brand_key, '77 pouches');
  assert.equal(result.product_core, 'cola cherry');
});

test('an unexplained variant token is not exact', () => {
  const result = compareProductIdentity(
    { b: 'FUMI', n: 'Fumi Freezy Mint', mg: 8 },
    { brand_raw: 'FUMI', product_name_raw: 'FUMI Freezy Mint Mini 4mg' },
  );
  assert.equal(result.identity_match, 'near');
  assert.deepEqual(result.extra_variant_tokens, ['mini']);
});

test('unknown brand never inherits the frozen brand', () => {
  const result = compareProductIdentity(
    { b: '77 Pouches', n: '77 Cola & Cherry', mg: 10.4 },
    { product_name_raw: '77 Cola & Cherry 10.4mg' },
  );
  assert.equal(result.identity_match, 'near');
  assert.equal(result.brand_key, null);
});
```

- [ ] **Step 2: Run the identity tests and observe RED**

Run:

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs --test-name-pattern "77 alias|variant token|inherits"
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `recheck-v3-1-identity.mjs`.

- [ ] **Step 3: Implement minimal deterministic identity helpers**

Create the module with these exports and rules:

```js
const BRAND_ALIASES = new Map([
  ['77 pouches', new Set(['77 pouches', '77'])],
]);

const MARKETING_TOKENS = new Set([
  'buy', 'from', 'online', 'order', 'save', 'shipping', 'delivery',
  'next', 'day', 'fast', 'stock', 'now',
]);

const decodeEntities = (value) => String(value ?? '')
  .replace(/&amp;|&#x26;/giu, '&')
  .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
  .replace(/&#(\d+);/gu, (_, decimal) => String.fromCodePoint(Number(decimal)));

export function normalizeIdentityText(value) {
  return decodeEntities(value).normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/\b\d+(?:[.,]\d+)?\s*mg(?:\s*\/\s*(?:g|pouch))?\b/giu, ' ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim().replace(/\s+/gu, ' ');
}

export function canonicalBrand(rawBrand) {
  const normalized = normalizeIdentityText(rawBrand);
  for (const [key, aliases] of BRAND_ALIASES) if (aliases.has(normalized)) return key;
  return normalized || null;
}

export function canonicalProductCore(rawName, brandKey) {
  const tokens = normalizeIdentityText(rawName).split(' ').filter(Boolean);
  const aliases = BRAND_ALIASES.get(brandKey) ?? new Set([brandKey]);
  const aliasTokens = [...aliases].sort((a, b) => b.length - a.length)
    .find((alias) => tokens.join(' ').startsWith(`${alias} `) || tokens.join(' ') === alias)?.split(' ') ?? [];
  const withoutBrand = aliasTokens.length ? tokens.slice(aliasTokens.length) : tokens;
  return withoutBrand.filter((token) => !MARKETING_TOKENS.has(token) && !/^\d+$/u.test(token)).join(' ');
}

export function compareProductIdentity(frozen, extracted) {
  const expectedBrand = canonicalBrand(frozen.b);
  const actualBrand = extracted.brand_raw ? canonicalBrand(extracted.brand_raw) : null;
  const expectedCore = canonicalProductCore(frozen.n, expectedBrand);
  const actualCore = canonicalProductCore(extracted.product_name_raw, actualBrand ?? expectedBrand);
  const expected = new Set(expectedCore.split(' ').filter(Boolean));
  const actual = new Set(actualCore.split(' ').filter(Boolean));
  const missing = [...expected].filter((token) => !actual.has(token));
  const extra = [...actual].filter((token) => !expected.has(token));
  const brandMatches = actualBrand !== null && actualBrand === expectedBrand;
  return {
    identity_match: brandMatches && missing.length === 0 && extra.length === 0 ? 'exact' : missing.length === 0 ? 'near' : 'wrong',
    brand_key: actualBrand,
    product_core: actualCore,
    missing_variant_tokens: missing,
    extra_variant_tokens: extra,
  };
}
```

- [ ] **Step 4: Run identity tests GREEN and the v3 regression suite**

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs --test-name-pattern "77 alias|variant token|inherits"
node --test scripts/pouch-audit/recheck-v3.test.mjs
```

Expected: selected v3.1 tests pass; all v3 tests pass.

- [ ] **Step 5: Commit identity canonicalization**

```powershell
git add -- scripts/pouch-audit/recheck-v3-1-identity.mjs scripts/pouch-audit/recheck-v3-1.test.mjs
git commit -m "feat: add pouch v3.1 identity matching"
```

### Task 3: Parse structured product facts without input leakage

**Files:**
- Create: `scripts/pouch-audit/recheck-v3-1-transport.mjs`
- Create: `scripts/pouch-audit/fixtures/v3-1/77-cola-cherry.html`
- Create: `scripts/pouch-audit/fixtures/v3-1/77-cola-vanilla-wrong-variant.html`
- Modify: `scripts/pouch-audit/recheck-v3-1.test.mjs`

- [ ] **Step 1: Add sanitized real-shaped HTML fixtures**

The positive fixture must contain only the minimum product facts:

```html
<!doctype html><html><head>
<title>77 Cola &amp; Cherry 10.4mg &#x1F6D2; Next Day Shipping</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"77 Cola & Cherry","brand":{"@type":"Brand","name":"77"},"sku":"77-CC-104","additionalProperty":[{"@type":"PropertyValue","name":"Nicotine per pouch","value":"10.4 mg"},{"@type":"PropertyValue","name":"Pouches","value":"20"},{"@type":"PropertyValue","name":"Net weight","value":"13 g"}]}
</script></head><body><h1>77 Cola &amp; Cherry</h1></body></html>
```

The negative fixture uses `77 Cola & Vanilla` and `20 mg/g`; it must not resolve as Cola & Cherry or as 20 mg/pouch.

- [ ] **Step 2: Write failing parser tests**

```js
import { parseProductFacts } from './recheck-v3-1-transport.mjs';

test('structured parser extracts brand name and labelled mg per pouch', () => {
  const body = readFileSync(new URL('./fixtures/v3-1/77-cola-cherry.html', import.meta.url), 'utf8');
  const parsed = parseProductFacts({ status: 200, body, final_url: 'https://www.northerner.com/uk/77/cola-cherry' });
  assert.equal(parsed.page_kind, 'product_detail');
  assert.equal(parsed.extracted.brand_raw, '77');
  assert.equal(parsed.extracted.product_name_raw, '77 Cola & Cherry');
  assert.deepEqual(parsed.extracted.strength_claims[0], {
    value: 10.4, unit: 'mg', basis: 'per_pouch',
    raw_label: 'Nicotine per pouch', raw_value: '10.4 mg', method: 'json_ld',
  });
});

test('mg per gram is not relabelled as mg per pouch', () => {
  const body = readFileSync(new URL('./fixtures/v3-1/77-cola-vanilla-wrong-variant.html', import.meta.url), 'utf8');
  const parsed = parseProductFacts({ status: 200, body, final_url: 'https://pouches.eu/products/77-cola-vanilla-20mg-g' });
  assert.equal(parsed.extracted.strength_claims.some((claim) => claim.basis === 'per_pouch'), false);
  assert.equal(parsed.extracted.strength_claims.some((claim) => claim.basis === 'per_g' && claim.value === 20), true);
});

test('parser cannot receive a frozen card to synthesize identity', () => {
  assert.equal(parseProductFacts.length, 1);
});
```

- [ ] **Step 3: Run parser tests and observe RED**

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs --test-name-pattern "structured parser|per gram|synthesize"
```

Expected: FAIL because `recheck-v3-1-transport.mjs` does not exist.

- [ ] **Step 4: Implement JSON-LD and labelled fact extraction**

Create `parseProductFacts(response)` with these exact boundaries:

```js
import { fetchLive, parseSearchResponse } from './recheck-v3-transport.mjs';

const numeric = (value) => {
  const match = String(value ?? '').match(/-?\d+(?:[.,]\d+)?/u);
  return match ? Number(match[0].replace(',', '.')) : null;
};

function jsonLdObjects(body) {
  const objects = [];
  for (const match of String(body).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
    try {
      const parsed = JSON.parse(match[1]);
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== 'object') continue;
        objects.push(item);
        if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
      }
    } catch {}
  }
  return objects;
}

function propertyClaims(product) {
  const claims = [];
  for (const property of product.additionalProperty ?? []) {
    const label = String(property.name ?? '');
    const rawValue = String(property.value ?? '');
    const value = numeric(rawValue);
    if (!Number.isFinite(value)) continue;
    if (/nicotine.*(?:per\s*)?pouch|mg\s*\/\s*pouch/iu.test(`${label} ${rawValue}`)) claims.push({ value, unit: 'mg', basis: 'per_pouch', raw_label: label, raw_value: rawValue, method: 'json_ld' });
    else if (/nicotine.*(?:per\s*)?g|mg\s*\/\s*g/iu.test(`${label} ${rawValue}`)) claims.push({ value, unit: 'mg', basis: 'per_g', raw_label: label, raw_value: rawValue, method: 'json_ld' });
  }
  return claims;
}

export function parseProductFacts(response) {
  if (!response || response.status < 200 || response.status >= 300 || response.transport_error) return { parse_status: 'not_parsed', page_kind: 'unknown', extracted: {} };
  const products = jsonLdObjects(response.body).filter((item) => item['@type'] === 'Product' || (Array.isArray(item['@type']) && item['@type'].includes('Product')));
  const product = products[0] ?? null;
  const properties = product?.additionalProperty ?? [];
  const propertyValue = (pattern) => properties.find((item) => pattern.test(String(item.name ?? '')))?.value;
  const extracted = product ? {
    brand_raw: typeof product.brand === 'string' ? product.brand : product.brand?.name,
    brand_method: product.brand ? 'json_ld' : undefined,
    product_name_raw: product.name,
    product_name_method: product.name ? 'json_ld' : undefined,
    product_id: product.sku ?? product.gtin ?? product.productID,
    strength_claims: propertyClaims(product),
    net_weight_g: numeric(propertyValue(/net\s*weight/iu)),
    pouch_count: numeric(propertyValue(/pouches?|portion\s*count/iu)),
  } : {};
  return { parse_status: product ? 'parsed' : 'not_parsed', page_kind: product ? 'product_detail' : 'unknown', extracted };
}

export { fetchLive, parseSearchResponse };
```

Do not add a generic first-`mg` fallback. Add narrow labelled HTML extraction only in a later RED→GREEN cycle if a live pilot page lacks JSON-LD.

- [ ] **Step 5: Run parser and full v3.1 tests GREEN**

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs
```

Expected: all current v3.1 tests pass.

- [ ] **Step 6: Commit structured extraction**

```powershell
git add -- scripts/pouch-audit/recheck-v3-1-transport.mjs scripts/pouch-audit/recheck-v3-1.test.mjs scripts/pouch-audit/fixtures/v3-1
git commit -m "feat: extract structured pouch product facts"
```

### Task 4: Add audited source and owner-group resolution

**Files:**
- Create: `scripts/pouch-audit/recheck-v3-1-sources.mjs`
- Modify: `scripts/pouch-audit/recheck-v3-1.test.mjs`

- [ ] **Step 1: Write failing source-group tests**

```js
import { sourceForUrl, independentSourceBranches } from './recheck-v3-1-sources.mjs';

test('Haypp and Northerner resolve to one owner branch', () => {
  const sources = independentSourceBranches([
    sourceForUrl('https://www.haypp.com/uk/product-a'),
    sourceForUrl('https://www.northerner.com/uk/product-a'),
  ]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].owner_group_id, 'haypp-group');
});

test('unknown retailer-looking host remains unknown', () => {
  assert.equal(sourceForUrl('https://cheap-pouches.example/product').source_class, 'unknown');
});
```

- [ ] **Step 2: Run source tests RED**

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs --test-name-pattern "owner branch|remains unknown"
```

Expected: FAIL with missing source module.

- [ ] **Step 3: Verify every new registry row before coding**

For each candidate domain, record its official legal/about URL, observed owner, access date, and owner group in a local planning table. Use current primary pages; do not infer independence from hostnames. Keep only rows whose ownership can be established. At minimum carry forward the already audited v3 rows for Haypp, Northerner, Snusdirect, VELO, ZYN, Nordic Spirit, FUMI, Pablo and regulators.

- [ ] **Step 4: Implement immutable registry and branch grouping**

```js
const rows = [
  { host: 'haypp.com', source_class: 'retailer', owner: 'Haypp Group', owner_group_id: 'haypp-group' },
  { host: 'northerner.com', source_class: 'retailer', owner: 'Haypp Group', owner_group_id: 'haypp-group' },
  { host: 'snusdirect.com', source_class: 'retailer', owner: 'Snusdirect', owner_group_id: 'snusdirect' },
  { host: 'velo.com', source_class: 'official', owner: 'BAT / VELO', owner_group_id: 'bat-velo' },
  { host: 'zyn.com', source_class: 'official', owner: 'Swedish Match / ZYN', owner_group_id: 'swedish-match-zyn' },
  { host: 'nordicspirit.co.uk', source_class: 'official', owner: 'JTI / Nordic Spirit', owner_group_id: 'jti-nordic-spirit' },
  { host: 'fumipods.com', source_class: 'official', owner: 'Helix Sweden / FUMI', owner_group_id: 'helix-fumi' },
  { host: 'pablopouch.com', source_class: 'official', owner: 'Pablo', owner_group_id: 'pablo' },
  { host: 'fda.gov', source_class: 'regulator', owner: 'US FDA', owner_group_id: 'us-fda' },
];

export const SOURCE_REGISTRY = Object.freeze(rows.map((row) => Object.freeze({ ...row })));

export function sourceForUrl(url) {
  let host;
  try { host = new URL(url).hostname.toLocaleLowerCase('en-US').replace(/^www\./u, ''); }
  catch { return { host: null, source_class: 'unknown', owner: null, owner_group_id: null }; }
  const row = SOURCE_REGISTRY.find((item) => host === item.host || host.endsWith(`.${item.host}`));
  return row ? { ...row, host } : { host, source_class: 'unknown', owner: null, owner_group_id: null };
}

export function independentSourceBranches(sources) {
  const branches = new Map();
  for (const source of sources) {
    const key = source.owner_group_id ?? `unknown:${source.host}`;
    if (!branches.has(key)) branches.set(key, source);
  }
  return [...branches.values()];
}
```

- [ ] **Step 5: Run source tests GREEN and commit**

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs --test-name-pattern "owner branch|remains unknown"
git add -- scripts/pouch-audit/recheck-v3-1-sources.mjs scripts/pouch-audit/recheck-v3-1.test.mjs
git commit -m "feat: add audited pouch source groups"
```

### Task 5: Build the append-only v3.1 research writer

**Files:**
- Create: `scripts/pouch-audit/recheck-v3-1-research.mjs`
- Modify: `scripts/pouch-audit/recheck-v3-1.test.mjs`

- [ ] **Step 1: Write failing raw-only research tests**

Test a fixture fetch map that returns two parsed search systems and the positive product fixture:

```js
test('v3.1 research writes extracted raw facts into only the new log', async () => {
  const result = await researchOneInput(frozen77ColaCherry(), {
    outputPath: tempPath('recheck-v3.1/raw-events.jsonl'),
    fetchImpl: fixtureFetchFor77(),
  });
  const events = await readRawEvents(result.rawPath);
  const opened = events.find((event) => event.event_type === 'url_opened');
  assert.equal(opened.payload.extracted.brand_raw, '77');
  assert.equal(opened.payload.extracted.strength_claims[0].basis, 'per_pouch');
  assert.doesNotMatch(readFileSync(result.rawPath, 'utf8'), /protocol_complete|qa_status|verified_sources/);
  assert.equal(existsSync('audit/pouches/recheck-v3/raw-events.jsonl'), true);
});
```

- [ ] **Step 2: Run research test RED**

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs --test-name-pattern "extracted raw facts"
```

Expected: FAIL because the research module/API is missing.

- [ ] **Step 3: Implement research using v3 hash-chain primitives**

The module must:

- import only `appendRawEvent`, `readRawEvents`, `sha256` from `recheck-v3-schema.mjs`;
- use `fetchLive`/`parseSearchResponse` and `parseProductFacts` from the v3.1 transport;
- use two independent search systems and materially distinct identity/strength queries;
- perform owner-specific queries before saturation;
- open every candidate or append an explicit deterministic non-product rejection;
- append `url_opened` with `brand_raw`, `product_name_raw`, `strength_claims`, methods and response hash;
- append a preliminary `candidate_decision`, but never a derived result;
- share a response cache only inside one run and mark every cache hit so it cannot count as transport success;
- write exclusively to the caller-provided v3.1 output path.

The preliminary decision must be computed as:

```js
function preliminaryDecision(row, parsed) {
  const identity = compareProductIdentity(row.original, parsed.extracted ?? {});
  const hasStrength = (parsed.extracted?.strength_claims ?? []).some((claim) => ['per_pouch', 'per_g'].includes(claim.basis));
  if (identity.identity_match === 'exact' && hasStrength && parsed.page_kind === 'product_detail') {
    return { match_decision: 'exact_match', reason: 'Raw product facts contain exact canonical identity and labelled strength semantics.' };
  }
  if (identity.identity_match === 'near') return { match_decision: 'near_match', reason: 'Raw product facts are related but contain missing or additional identity fields.' };
  return { match_decision: 'wrong_variant', reason: 'Raw product facts do not match the frozen product identity.' };
}
```

- [ ] **Step 4: Run research test GREEN and all v3.1 tests**

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs
```

Expected: all v3.1 tests pass.

- [ ] **Step 5: Commit research writer**

```powershell
git add -- scripts/pouch-audit/recheck-v3-1-research.mjs scripts/pouch-audit/recheck-v3-1.test.mjs
git commit -m "feat: record pouch v3.1 raw research"
```

### Task 6: Derive exact evidence in an independent validator

**Files:**
- Create: `scripts/pouch-audit/recheck-v3-1-validator.mjs`
- Modify: `scripts/pouch-audit/recheck-v3-1.test.mjs`

- [ ] **Step 1: Write failing validator evidence tests**

```js
test('validator ignores a writer decision and independently derives exact evidence', () => {
  const events = exact77Events({ writerDecision: 'wrong_variant', sources: ['https://www.northerner.com/uk/77/cola-cherry'] });
  const row = deriveInputResult(frozen77ColaCherry(), events);
  assert.equal(row.gates.exact_evidence_count, 1);
  assert.equal(row.outcome, 'unresolved_after_complete_search');
});

test('one official exact source verifies a product', () => {
  const row = deriveInputResult(frozenZynFixture(), exactOfficialEvents('https://www.zyn.com/products/fixture'));
  assert.equal(row.outcome, 'verified');
});

test('two independent exact retailers verify but one owner group does not', () => {
  assert.equal(deriveInputResult(frozenFixture(), exactRetailerEvents(['haypp.com', 'northerner.com'])).outcome, 'unresolved_after_complete_search');
  assert.equal(deriveInputResult(frozenFixture(), exactRetailerEvents(['northerner.com', 'snusdirect.com'])).outcome, 'verified');
});

test('mg per gram converts only with same-page weight and pouch count', () => {
  assert.equal(deriveStrength({ strength_claims: [{ value: 16, unit: 'mg', basis: 'per_g' }], net_weight_g: 13, pouch_count: 20 }).value, 10.4);
  assert.equal(deriveStrength({ strength_claims: [{ value: 16, unit: 'mg', basis: 'per_g' }] }).value, null);
});

test('validator source does not import research or QA', () => {
  const source = readFileSync(new URL('./recheck-v3-1-validator.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /recheck-v3-1-(?:research|qa)/u);
});
```

- [ ] **Step 2: Run validator tests RED**

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs --test-name-pattern "independently derives|official exact|owner group|converts only|does not import"
```

Expected: FAIL with missing validator exports.

- [ ] **Step 3: Implement independent strength and evidence derivation**

Implement these complete rules:

```js
export function deriveStrength(extracted) {
  const direct = (extracted.strength_claims ?? []).find((claim) => claim.basis === 'per_pouch' && Number.isFinite(Number(claim.value)));
  if (direct) return { value: Number(direct.value), calculation: 'direct_mg_per_pouch', inputs: [direct] };
  const perG = (extracted.strength_claims ?? []).find((claim) => claim.basis === 'per_g' && Number.isFinite(Number(claim.value)));
  const weight = Number(extracted.net_weight_g);
  const count = Number(extracted.pouch_count);
  if (!perG || !Number.isFinite(weight) || !Number.isInteger(count) || weight <= 0 || count <= 0) return { value: null, calculation: null, inputs: [] };
  return { value: Number(perG.value) * weight / count, calculation: 'mg_per_g_x_net_weight_div_pouches', inputs: [perG, weight, count] };
}
```

For each opened candidate, validator must independently call `compareProductIdentity`, `deriveStrength` and `sourceForUrl`. It counts exact evidence only when the page is successful, parsed, `product_detail`, canonical identity is exact and strength is finite. It groups by `owner_group_id`, derives conflicts from differing values, and sets `verified` for one official/regulator branch or two independent exact branches.

Retain v3 protocol gates for two successful systems, materially distinct queries, owner attempts, saturation, candidate accounting, global event-chain validation and zero unreviewed candidates. Never read the writer's `match_decision` to establish identity or strength.

- [ ] **Step 4: Run validator tests GREEN and full suites**

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs
node --test scripts/pouch-audit/recheck-v3.test.mjs
```

Expected: both suites pass.

- [ ] **Step 5: Commit validator**

```powershell
git add -- scripts/pouch-audit/recheck-v3-1-validator.mjs scripts/pouch-audit/recheck-v3-1.test.mjs
git commit -m "feat: validate pouch v3.1 evidence independently"
```

### Task 7: Add independent QA

**Files:**
- Create: `scripts/pouch-audit/recheck-v3-1-qa.mjs`
- Modify: `scripts/pouch-audit/recheck-v3-1.test.mjs`

- [ ] **Step 1: Write failing QA independence and hash tests**

```js
test('v3.1 QA rechecks exact facts and calculates all hashes', () => {
  const qa = qaInput(frozen77ColaCherry(), exact77Events(), validDerived77());
  assert.equal(qa.qa_status, 'qa_passed');
  assert.match(qa.input_card_sha256, /^[a-f0-9]{64}$/u);
  assert.match(qa.raw_events_sha256, /^[a-f0-9]{64}$/u);
  assert.match(qa.derived_result_sha256, /^[a-f0-9]{64}$/u);
});

test('QA rejects a stored verified result unsupported by raw facts', () => {
  const qa = qaInput(frozen77ColaCherry(), nearOnly77Events(), { ...validDerived77(), outcome: 'verified' });
  assert.equal(qa.qa_status, 'qa_failed');
  assert.match(qa.errors.join('\n'), /exact|source|strength/iu);
});

test('QA source imports neither research nor validator', () => {
  const source = readFileSync(new URL('./recheck-v3-1-qa.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /recheck-v3-1-(?:research|validator)/u);
});
```

- [ ] **Step 2: Run QA tests RED**

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs --test-name-pattern "QA rechecks|unsupported|imports neither"
```

Expected: FAIL with missing QA module.

- [ ] **Step 3: Implement independent QA checks**

`qaInput(snapshotRow, events, derived)` must independently verify:

- input card hash;
- global and scoped event-chain integrity;
- two search systems and transport success semantics;
- owner-attempt coverage;
- every candidate opened/decided or deterministically rejected;
- canonical identity and strength from raw `extracted` values;
- source class and owner-group independence;
- equality between recomputed result and stored derived result;
- the three SHA-256 audit hashes.

The module may import only shared v3 schema primitives plus v3.1 identity and source registry. It must not import research or validator.

- [ ] **Step 4: Run QA tests GREEN and commit**

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs
git add -- scripts/pouch-audit/recheck-v3-1-qa.mjs scripts/pouch-audit/recheck-v3-1.test.mjs
git commit -m "feat: add independent pouch v3.1 QA"
```

### Task 8: Add full-run CLI and safe application gate

**Files:**
- Create: `scripts/pouch-audit/recheck-v3-1-apply.mjs`
- Create: `scripts/pouch-audit/recheck-v3-1.mjs`
- Modify: `scripts/pouch-audit/recheck-v3-1.test.mjs`

- [ ] **Step 1: Write failing CLI isolation and apply tests**

```js
test('v3.1 CLI freezes exactly 861 IDs into its own directory', async () => {
  const result = await runCliFixture(['--freeze']);
  assert.equal(result.snapshot.rows.length, 861);
  assert.equal(new Set(result.snapshot.rows.map((row) => row.input_id)).size, 861);
  assert.match(result.snapshotPath, /recheck-v3\.1[\\/]input-snapshot\.json$/u);
});

test('preapproved pilot continues all 861 only after a passed pilot gate', async () => {
  const result = await runCliFixture(['--run-all', '--preapproved']);
  assert.equal(result.pilot.total, 5);
  assert.equal(result.global.total, 861);
  assert.equal(result.global.pending, 0);
});

test('safe apply changes only verified row-local mg values and is idempotent', () => {
  const once = applyVerifiedChanges(dataFixture(), globalFixture({ verifiedCorrection: 10.4 }));
  const twice = applyVerifiedChanges(once.text, globalFixture({ verifiedCorrection: 10.4 }));
  assert.equal(once.changedRows.length, 1);
  assert.equal(twice.changedRows.length, 0);
  assert.equal(twice.text, once.text);
});
```

- [ ] **Step 2: Run CLI/apply tests RED**

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs --test-name-pattern "freezes exactly|preapproved pilot|idempotent"
```

Expected: FAIL with missing CLI/apply modules.

- [ ] **Step 3: Implement CLI paths and approval record**

The CLI must use these fixed paths under `audit/pouches/recheck-v3.1` and expose:

```text
--freeze
--pilot
--record-preapproval
--batch --limit 1..25
--run-all --preapproved
--validate [--pilot]
--qa [--pilot]
--report
--package
--apply-safe
```

`--record-preapproval` writes `approval.json` with the snapshot hash, validator source hash, QA source hash, exactly five pilot IDs, approval date and basis `explicit user preapproval for all 861 and main push`. `--run-all --preapproved` first runs/validates/QA-checks the five pilot rows. It continues only if the pilot has no systemic extraction failure, zero pending and zero unreviewed candidates.

- [ ] **Step 4: Implement fail-closed safe apply**

`applyVerifiedChanges(dataText, { snapshot, results, qaRows, validator })` must refuse unless:

- snapshot has exactly 861 unique IDs;
- validator is globally `ok` with zero pending/unreviewed;
- QA has exactly 861 passed rows with matching hashes;
- every proposed change comes from `verified` evidence;
- each source URL and strength derivation is present;
- row identity and original index still match `data.js`;
- no conflicted/unresolved result changes data.

Return `{ text, changedRows }` without writing. The CLI writes `data.js` only when `changedRows.length > 0`, then reparses it and reruns the affected integrity checks.

- [ ] **Step 5: Run CLI/apply tests GREEN and commit**

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs
git add -- scripts/pouch-audit/recheck-v3-1-apply.mjs scripts/pouch-audit/recheck-v3-1.mjs scripts/pouch-audit/recheck-v3-1.test.mjs
git commit -m "feat: orchestrate full pouch v3.1 audit"
```

### Task 9: Add report, manifest, deterministic packaging and goal prompt

**Files:**
- Create: `scripts/pouch-audit/recheck-v3-1-artifacts.mjs`
- Modify: `scripts/pouch-audit/recheck-v3-1.mjs`
- Modify: `scripts/pouch-audit/recheck-v3-1.test.mjs`
- Modify: `.gitignore`
- Create: `docs/superpowers/goals/2026-08-14-pouch-audit-v3-1-goal.md`

- [ ] **Step 1: Write failing artifact tests**

```js
test('report contains every raw query candidate open decision result and QA hash', () => {
  const report = buildReport(snapshotFixture(), rawFixture(), resultsFixture(), qaFixture());
  for (const id of snapshotFixture().rows.map((row) => row.input_id)) assert.match(report, new RegExp(id));
  for (const heading of ['Raw queries', 'Candidates', 'Opened URLs', 'Decisions', 'Derived result', 'QA hashes']) assert.match(report, new RegExp(heading));
});

test('gzip package is deterministic and expands to the manifested hash', () => {
  const first = deterministicGzip(Buffer.from('raw evidence\n'));
  const second = deterministicGzip(Buffer.from('raw evidence\n'));
  assert.deepEqual(first, second);
  assert.equal(gunzipSync(first).toString('utf8'), 'raw evidence\n');
});
```

- [ ] **Step 2: Run artifact tests RED**

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs --test-name-pattern "report contains|gzip package"
```

Expected: FAIL with missing artifact module.

- [ ] **Step 3: Implement report and deterministic package**

```js
import { gzipSync, gunzipSync } from 'node:zlib';
import { sha256 } from './recheck-v3-schema.mjs';

export function deterministicGzip(bytes) {
  return gzipSync(bytes, { level: 9, mtime: 0 });
}

export function verifyGzip(gzipBytes, expectedUncompressedSha256) {
  const plain = gunzipSync(gzipBytes);
  if (sha256(plain) !== expectedUncompressedSha256) throw new Error('Gzip payload hash mismatch');
  return true;
}
```

`buildReport` must render every event without candidate truncation. `buildManifest` must hash snapshot, raw, results, QA, report, gzip files, `data.js` before/after, validator/QA/research sources, previous-v3 artifact set and record unavailable sources/fallbacks/result counts/data changes.

- [ ] **Step 4: Add precise artifact ignore rules**

Append after the general pouch audit rule:

```gitignore
!audit/pouches/recheck-v3.1/
audit/pouches/recheck-v3.1/*
!audit/pouches/recheck-v3.1/input-snapshot.json
!audit/pouches/recheck-v3.1/derived-results.jsonl
!audit/pouches/recheck-v3.1/qa.jsonl
!audit/pouches/recheck-v3.1/progress.json
!audit/pouches/recheck-v3.1/approval.json
!audit/pouches/recheck-v3.1/manifest.json
!audit/pouches/recheck-v3.1/summary.md
!audit/pouches/recheck-v3.1/raw-events.jsonl.gz
!audit/pouches/recheck-v3.1/report.md.gz
```

Confirm `raw-events.jsonl` and `report.md` remain ignored while gzip files are visible.

- [ ] **Step 5: Write the exact new goal prompt**

Create `docs/superpowers/goals/2026-08-14-pouch-audit-v3-1-goal.md` containing a copy-paste `/goal` prompt that:

- cites the v3.1 spec and this plan by absolute path;
- states explicit preapproval for all 861 and push to `main`;
- requires TDD RED→GREEN;
- preserves v2 and current v3 byte-for-byte;
- runs pilot internally without pausing;
- permits only safe verified `data.js` changes;
- requires complete report, manifest, gzip validation, tests, staged allowlist, non-force push and final commit SHA.

- [ ] **Step 6: Run artifact tests GREEN and commit**

```powershell
node --test scripts/pouch-audit/recheck-v3-1.test.mjs
git add -- .gitignore scripts/pouch-audit/recheck-v3-1-artifacts.mjs scripts/pouch-audit/recheck-v3-1.mjs scripts/pouch-audit/recheck-v3-1.test.mjs docs/superpowers/goals/2026-08-14-pouch-audit-v3-1-goal.md
git commit -m "feat: package pouch v3.1 audit evidence"
```

### Task 10: Run the live pilot and full 861-card audit

**Files:**
- Generate: `audit/pouches/recheck-v3.1/*`
- Potentially modify: `scripts/pouch-audit/recheck-v3-1-transport.mjs`
- Potentially modify: `scripts/pouch-audit/recheck-v3-1-sources.mjs`
- Potentially modify: `scripts/pouch-audit/recheck-v3-1.test.mjs`

- [ ] **Step 1: Capture immutable pre-run hashes**

Run a read-only script that records SHA-256 for `data.js`, every file under `audit/pouches/recheck-v3`, and existing v2 files. Store the map in the v3.1 manifest working state before creating raw events.

- [ ] **Step 2: Freeze and verify exactly 861 IDs**

```powershell
node scripts/pouch-audit/recheck-v3-1.mjs --freeze
```

Expected: snapshot reports 861 rows, 861 unique IDs and exactly five `77 Pouches` pilot rows; `data.js` hash is unchanged.

- [ ] **Step 3: Run the five-card pilot**

```powershell
node scripts/pouch-audit/recheck-v3-1.mjs --pilot
node scripts/pouch-audit/recheck-v3-1.mjs --validate --pilot
node scripts/pouch-audit/recheck-v3-1.mjs --qa --pilot
```

Expected: five rows, zero pending, zero unreviewed, QA 5/5. Inspect every opened pilot product page. If a page contains product brand/name/strength but the parser omits it, stop and add a targeted failing fixture test before changing parser code.

- [ ] **Step 4: Record the already granted full-run approval**

```powershell
node scripts/pouch-audit/recheck-v3-1.mjs --record-preapproval
```

Expected: approval binds the five IDs, snapshot, validator and QA source hashes and states explicit approval for all 861 plus main push.

- [ ] **Step 5: Process all remaining cards in same-brand batches of at most 25**

```powershell
node scripts/pouch-audit/recheck-v3-1.mjs --run-all --preapproved
```

Expected: resumable progress reaches 861/861. Every checkpoint requires fresh validator and QA state with zero pending/unreviewed. Transport failures remain raw events and cannot be rewritten as success.

- [ ] **Step 6: Handle any newly exposed parser/source defect with TDD**

For each systemic failure: save the smallest sanitized response fixture, write one failing test, run it RED, implement one minimal parser/source fix, run it GREEN, rerun full suites, append new research events without mutating previous events, and commit the focused fix. Do not relax identity, strength or independence thresholds to force completion.

### Task 11: Validate, apply, package and audit the complete result

**Files:**
- Modify only if verified: `data.js`
- Generate: `audit/pouches/recheck-v3.1/*`

- [ ] **Step 1: Run global validation and QA**

```powershell
node scripts/pouch-audit/recheck-v3-1.mjs --validate
node scripts/pouch-audit/recheck-v3-1.mjs --qa
```

Expected: total 861, pending 0, unreviewed 0, QA passed 861/861. Record exact `verified`, `conflicted` and `unresolved_after_complete_search` counts.

- [ ] **Step 2: Generate report and package**

```powershell
node scripts/pouch-audit/recheck-v3-1.mjs --report
node scripts/pouch-audit/recheck-v3-1.mjs --package
```

Expected: report contains all 861 IDs and every raw query/candidate/open/decision/result/QA hash; gzip archives expand to bytes matching manifest hashes.

- [ ] **Step 3: Run safe apply twice**

```powershell
node scripts/pouch-audit/recheck-v3-1.mjs --apply-safe
node scripts/pouch-audit/recheck-v3-1.mjs --apply-safe
```

Expected: first run changes only explicitly listed `verified` corrections; second run reports no changes. If no correction is verified, both runs are no-op.

- [ ] **Step 4: Regenerate final hashes after apply and revalidate**

```powershell
node scripts/pouch-audit/recheck-v3-1.mjs --validate
node scripts/pouch-audit/recheck-v3-1.mjs --qa
node scripts/pouch-audit/recheck-v3-1.mjs --report
node scripts/pouch-audit/recheck-v3-1.mjs --package
```

Expected: manifest reflects final `data.js`; results/QA remain 861/861 and all gzip checks pass.

- [ ] **Step 5: Verify historical artifacts are unchanged**

Compare every captured v2/v3 pre-run hash with current files. Expected: exact equality for all historical files.

### Task 12: Final verification, exact commit and push to main

**Files:**
- All v3.1 implementation and approved generated artifacts
- Potentially `data.js` only for verified corrections

- [ ] **Step 1: Run fresh full verification**

```powershell
node --test scripts/pouch-audit/recheck-v3.test.mjs
node --test scripts/pouch-audit/recheck-v3-1.test.mjs
node --check data.js
node --check scripts/pouch-audit/recheck-v3-1-identity.mjs
node --check scripts/pouch-audit/recheck-v3-1-transport.mjs
node --check scripts/pouch-audit/recheck-v3-1-sources.mjs
node --check scripts/pouch-audit/recheck-v3-1-research.mjs
node --check scripts/pouch-audit/recheck-v3-1-validator.mjs
node --check scripts/pouch-audit/recheck-v3-1-qa.mjs
node --check scripts/pouch-audit/recheck-v3-1-apply.mjs
node --check scripts/pouch-audit/recheck-v3-1-artifacts.mjs
node --check scripts/pouch-audit/recheck-v3-1.mjs
git diff --check
```

Expected: zero test failures, all syntax checks exit 0, diff check clean.

- [ ] **Step 2: Stage an explicit allowlist**

Stage only:

```text
data.js (only if verified changes exist)
.gitignore
scripts/pouch-audit/recheck-v3-1-*.mjs
scripts/pouch-audit/recheck-v3-1.test.mjs
scripts/pouch-audit/fixtures/v3-1/*
docs/superpowers/specs/2026-08-14-pouch-audit-v3-1-design.md
docs/superpowers/plans/2026-08-14-pouch-audit-v3-1.md
docs/superpowers/goals/2026-08-14-pouch-audit-v3-1-goal.md
audit/pouches/recheck-v3.1/input-snapshot.json
audit/pouches/recheck-v3.1/derived-results.jsonl
audit/pouches/recheck-v3.1/qa.jsonl
audit/pouches/recheck-v3.1/progress.json
audit/pouches/recheck-v3.1/approval.json
audit/pouches/recheck-v3.1/manifest.json
audit/pouches/recheck-v3.1/summary.md
audit/pouches/recheck-v3.1/raw-events.jsonl.gz
audit/pouches/recheck-v3.1/report.md.gz
```

Run `git diff --cached --name-only`, `git diff --cached --check`, inspect the complete staged diff, and verify no `audit/pouches/recheck-v3/` path is staged.

- [ ] **Step 3: Commit the final audit outputs**

```powershell
git commit -m "audit: complete pouch recheck v3.1"
```

Expected: commit succeeds and reports only approved paths.

- [ ] **Step 4: Fetch and verify fast-forward push safety**

```powershell
git fetch origin
git rev-list --left-right --count origin/main...main
```

Expected: remote-ahead count is 0. If remote is ahead, rebase local commits onto `origin/main`, resolve only in-scope conflicts, rerun Task 12 Step 1 and repeat this check. Never force push.

- [ ] **Step 5: Push and verify remote main**

```powershell
git push origin main
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

Expected: both SHAs are identical. Report final commit SHA, exact audit counts, `data.js` changes with evidence URLs, artifact paths, tests, limitations and the reusable `/goal` prompt.
