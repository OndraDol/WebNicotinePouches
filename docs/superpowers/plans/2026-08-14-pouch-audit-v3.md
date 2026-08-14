# Pouch audit v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separate, fail-closed v3 audit pipeline that freezes exactly 861 input cards, records only append-only raw research events, derives all protocol and outcome states independently, performs independent QA, and stops after a fully evidenced five-card `77 Pouches` pilot for explicit user approval.

**Architecture:** A shared schema module owns canonical JSON and hash-chain primitives. The research writer appends raw events but never writes derived card states. A read-only validator imports only the shared schema, derives results from the frozen snapshot and raw event log, and a separate QA module rechecks both inputs and event evidence. A CLI enforces the pilot stop, validator-hash approval, batches of at most 25, and the final safe-application gate.

**Tech Stack:** Node.js ESM, built-in `node:test`, `node:crypto`, `node:fs/promises`, built-in `fetch` with abort timeouts, JSON/JSONL artifacts, no new third-party dependencies.

---

## File map

Create these focused modules and artifacts:

- `scripts/pouch-audit/recheck-v3-schema.mjs` — canonical JSON, SHA-256, event types, source/owner-group registry, raw-event shape checks, and hash-chain helpers.
- `scripts/pouch-audit/recheck-v3-freeze.mjs` — build and verify the immutable 861-card input snapshot.
- `scripts/pouch-audit/recheck-v3-transport.mjs` — live HTTP transport and response normalization used only by research.
- `scripts/pouch-audit/recheck-v3-research.mjs` — append-only search, catalog, owner, URL-open, extraction, and candidate-decision events; pilot and batch checkpoints.
- `scripts/pouch-audit/recheck-v3-validator.mjs` — read-only derivation from snapshot plus raw events; no import of the research module.
- `scripts/pouch-audit/recheck-v3-qa.mjs` — independent read-only QA and QA JSONL writer; no import of the research or validator modules.
- `scripts/pouch-audit/recheck-v3.mjs` — CLI orchestration, pilot stop, approval hash, batch limits, reports, and exit codes.
- `scripts/pouch-audit/recheck-v3-apply.mjs` — final fail-closed safe-application gate for evidence-backed `data.js` changes.
- `scripts/pouch-audit/recheck-v3.test.mjs` — unit, integration, negative, pilot, QA, idempotence, and final-gate tests.

Create these generated artifacts only through the v3 CLI:

- `audit/pouches/recheck-v3/input-snapshot.json`
- `audit/pouches/recheck-v3/raw-events.jsonl`
- `audit/pouches/recheck-v3/derived-results.jsonl`
- `audit/pouches/recheck-v3/qa.jsonl`
- `audit/pouches/recheck-v3/pilot-report.md`
- `audit/pouches/recheck-v3/progress.json`
- `audit/pouches/recheck-v3/pilot-approval.json` after explicit pilot approval

Do not modify or delete `audit/pouches/recheck-v2*`, `audit/pouches/research-log.jsonl`, `audit/pouches/ledger.jsonl`, or `data.js` during pilot implementation.

### Task 1: Define canonical hashing and the immutable 861-card snapshot

**Files:**
- Create: `scripts/pouch-audit/recheck-v3-schema.mjs`
- Create: `scripts/pouch-audit/recheck-v3-freeze.mjs`
- Create/modify: `scripts/pouch-audit/recheck-v3.test.mjs`
- Create: `audit/pouches/recheck-v3/input-snapshot.json` only when the freeze command is run

- [ ] **Step 1: Write failing tests for canonical JSON and the exact frozen set**

```js
test('freezes exactly the 861 unresolved IDs without changing data.js', () => {
  const snapshot = buildInputSnapshot({
    inputSnapshot: readFixture('audit/pouches/input.json'),
    unresolvedInput: readFixture('audit/pouches/unresolved-input.json'),
    dataSourceText: readFixture('data.js'),
    now: '2026-08-14T00:00:00.000Z',
  });
  assert.equal(snapshot.rows.length, 861);
  assert.equal(new Set(snapshot.rows.map((row) => row.input_id)).size, 861);
  assert.equal(snapshot.rows.filter((row) => row.original.b === '77 Pouches').length, 5);
  assert.equal(snapshot.data_source_sha256, sha256(readFixture('data.js')));
  assert.equal(snapshot.rows[0].original, { b: '77 Pouches', n: '77 Black Currant Ice', mg: 10.4 });
});

test('rejects a changed original card or changed membership after freezing', () => {
  const frozen = buildInputSnapshot(validFreezeInputs());
  assert.throws(() => assertFrozenSnapshot(frozen, { ...frozen, rows: frozen.rows.slice(1) }), /861|snapshot|membership/i);
  assert.throws(() => assertFrozenSnapshot(frozen, { ...frozen, rows: frozen.rows.map((row, index) => index === 0 ? { ...row, original: { ...row.original, mg: 99 } } : row) }), /hash|original|snapshot/i);
});
```

- [ ] **Step 2: Run the focused test and verify the expected RED failure**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "freezes exactly|changed original"`

Expected: FAIL because `buildInputSnapshot`, `sha256`, and `assertFrozenSnapshot` do not exist yet. A test error caused by a fixture typo must be fixed before implementation.

- [ ] **Step 3: Implement the minimal canonical/hash and freeze APIs**

Implement these exact exports:

```js
export function canonicalJson(value) { /* recursively sort object keys, preserve array order, emit UTF-8 JSON */ }
export function sha256(value) { /* hash canonical string or UTF-8 string */ }
export function hashInputCard(row) { /* hash input_id, original_index, and original only */ }
export function hashSnapshot(snapshot) { /* hash schema, source hash, and ordered rows without snapshot hash */ }
export function buildInputSnapshot({ inputSnapshot, unresolvedInput, dataSourceText, now }) { /* exact 861-card snapshot */ }
export function assertFrozenSnapshot(existing, candidate) { /* fail closed on any ID, original, source, or hash drift */ }
```

`buildInputSnapshot` must map each unresolved `input_id` to the corresponding immutable row from `input.json`, compare its `{b,n,mg}` against the current parsed `data.js`, include `input_card_sha256` per row, and set `snapshot_sha256` only after all rows pass. It must not write `data.js`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "freezes exactly|changed original"`

Expected: PASS with no warnings.

- [ ] **Step 5: Add the freeze CLI wrapper and verify its output without live research**

Add `freezeInputSnapshot(paths)` to `recheck-v3-freeze.mjs`. The first run creates only `input-snapshot.json`; a second run must compare the existing hash and report `snapshot: unchanged` without rewriting it.

Run: `node scripts/pouch-audit/recheck-v3.mjs --freeze`

Expected: `861/861 input cards frozen`, `data.js changed: no`, and a new `audit/pouches/recheck-v3/input-snapshot.json`.

- [ ] **Step 6: Commit the snapshot contract**

```text
git add scripts/pouch-audit/recheck-v3-schema.mjs scripts/pouch-audit/recheck-v3-freeze.mjs scripts/pouch-audit/recheck-v3.test.mjs scripts/pouch-audit/recheck-v3.mjs audit/pouches/recheck-v3/input-snapshot.json
git commit -m "feat: freeze v3 pouch audit inputs"
```

### Task 2: Add append-only raw events and integrity checks

**Files:**
- Modify: `scripts/pouch-audit/recheck-v3-schema.mjs`
- Create/modify: `scripts/pouch-audit/recheck-v3-research.mjs`
- Modify: `scripts/pouch-audit/recheck-v3.test.mjs`
- Create: `audit/pouches/recheck-v3/raw-events.jsonl` through the writer only

- [ ] **Step 1: Write failing tests for event hashes, event-chain order, and forbidden summaries**

```js
test('appendRawEvent creates a linked hash-chain record', async () => {
  const path = tempPath('raw-events.jsonl');
  await appendRawEvent(path, { input_id: 'input-a', event_type: 'search_attempt', payload: { status: 200 } }, { recordedAt: '2026-08-14T00:00:00.000Z' });
  await appendRawEvent(path, { input_id: 'input-a', event_type: 'transport_event', payload: { kind: 'cache_hit' } }, { recordedAt: '2026-08-14T00:00:01.000Z' });
  const events = await readRawEvents(path);
  assert.equal(events.length, 2);
  assert.equal(events[1].previous_event_sha256, events[0].event_sha256);
  assert.deepEqual(verifyEventChain(events), []);
});

test('raw event validation rejects derived summary fields anywhere in payload', async () => {
  await assert.rejects(() => appendRawEvent(tempPath('raw-events.jsonl'), {
    input_id: 'input-a', event_type: 'search_attempt',
    payload: { protocol_complete: true },
  }), /derived|protocol_complete/i);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "hash-chain|derived summary"`

Expected: FAIL because raw event append/read/verify functions do not exist.

- [ ] **Step 3: Implement the raw event contract**

Add these exact exports to the schema module:

```js
export const V3_EVENT_TYPES = new Set(['search_attempt', 'catalog_lookup', 'url_opened', 'candidate_decision', 'owner_lookup', 'transport_event']);
export const DERIVED_FIELD_NAMES = new Set(['protocol_complete', 'saturation', 'outcome', 'qa_status', 'unreviewed_candidate_count']);
export function createRawEvent(input, { sequence, previousHash, recordedAt }) { /* validate and hash */ }
export function assertRawEvent(event, { expectedSequence, expectedPreviousHash, expectedInputIds }) { /* fail closed */ }
export function verifyEventChain(events, expectedInputIds = null) { /* return concrete errors */ }
export async function appendRawEvent(path, input, clock = {}) { /* append exactly one JSONL line */ }
export async function readRawEvents(path) { /* parse JSONL and reject malformed lines */ }
export function hashEvents(events) { /* hash the canonical ordered event array */ }
```

The recursive forbidden-field check must inspect `payload` as well as the event envelope. No writer function may accept an `outcome`, `protocol_complete`, `saturation`, `qa_status`, or alias as input.

- [ ] **Step 4: Run all schema/event tests and verify GREEN**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "hash-chain|derived summary|event"`

Expected: PASS.

- [ ] **Step 5: Commit the append-only event contract**

```text
git add scripts/pouch-audit/recheck-v3-schema.mjs scripts/pouch-audit/recheck-v3-research.mjs scripts/pouch-audit/recheck-v3.test.mjs
git commit -m "feat: add append-only v3 audit events"
```

### Task 3: Build the independent validator core

**Files:**
- Create: `scripts/pouch-audit/recheck-v3-validator.mjs`
- Modify: `scripts/pouch-audit/recheck-v3-schema.mjs` only for shared pure constants
- Modify: `scripts/pouch-audit/recheck-v3.test.mjs`

- [ ] **Step 1: Write failing tests for validator isolation and core derivation**

```js
test('validator source does not import the research module', () => {
  const source = readFileSync('scripts/pouch-audit/recheck-v3-validator.mjs', 'utf8');
  assert.doesNotMatch(source, /recheck-v3-research/);
});

test('validator derives pending when one candidate has no open and decision events', () => {
  const result = deriveResults(validSnapshot(), eventsWithUnreviewedCandidate());
  assert.equal(result.rows[0].outcome, 'pending');
  assert.equal(result.rows[0].unreviewed_candidate_count, 1);
  assert.equal(result.ok, false);
});

test('validator derives unresolved only after every required action is evidenced', () => {
  const result = deriveResults(validSnapshot(), completeNoEvidenceEvents());
  assert.equal(result.rows[0].outcome, 'unresolved_after_complete_search');
  assert.equal(result.rows[0].protocol_complete, true);
  assert.equal(result.rows[0].unreviewed_candidate_count, 0);
});
```

- [ ] **Step 2: Run the validator tests and verify RED**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "validator source|unreviewed|unresolved"`

Expected: FAIL because `deriveResults` and the validator module do not exist.

- [ ] **Step 3: Implement the pure validator pipeline**

Implement these exports without importing research or QA:

```js
export function deriveInputResult(inputRow, events, { sourceRegistry }) { /* derive every field from raw evidence */ }
export function deriveResults(snapshot, events, options = {}) { /* validate chain and derive all 861/5 rows */ }
export async function validateV3Artifacts(paths, options = {}) { /* read-only CLI-facing validator */ }
```

The derived row must include `protocol_complete`, `saturation`, `owner_resolution`, `unreviewed_candidate_count`, `verified_sources`, `conflicts`, and `outcome`, but none of those fields may be read from raw input. The validator must return `ok: false` and exit code 1 on any structural or evidentiary uncertainty.

- [ ] **Step 4: Add transport-success and candidate-accounting rules**

Implement exact predicates:

```js
const successfulResponse = (event) => event.event_type === 'search_attempt'
  && event.payload.status >= 200 && event.payload.status < 300
  && event.payload.parse_status === 'parsed'
  && event.payload.cache_hit !== true;

const candidateKey = (url) => new URL(url).toString();
```

Treat 429, timeout, network error, sleep, cache hit, and parse failure as non-successful. Count every candidate URL produced by a successful search/catalog event. A candidate is complete only with a matching `url_opened` plus `candidate_decision`, or a `candidate_decision` whose `rejection_rule` is present in the validator’s explicit deterministic non-product rule set.

- [ ] **Step 5: Run validator tests and verify GREEN**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "validator|candidate|transport"`

Expected: PASS.

- [ ] **Step 6: Commit the validator core**

```text
git add scripts/pouch-audit/recheck-v3-validator.mjs scripts/pouch-audit/recheck-v3-schema.mjs scripts/pouch-audit/recheck-v3.test.mjs
git commit -m "feat: derive pouch audit results from raw events"
```

### Task 4: Encode search, catalog, owner, saturation, and evidence gates

**Files:**
- Modify: `scripts/pouch-audit/recheck-v3-validator.mjs`
- Modify: `scripts/pouch-audit/recheck-v3-schema.mjs`
- Modify: `scripts/pouch-audit/recheck-v3.test.mjs`

- [ ] **Step 1: Write the ten required negative tests before changing gate logic**

Add one test per required rejection. Each test must assert a concrete error and a non-zero validator result:

```js
const negativeCases = [
  ['rejects second search system with HTTP 429', eventsSecondSystem429()],
  ['rejects three general catalogs without item-specific lookup', eventsThreeGenericCatalogs()],
  ['rejects owner not identified without owner attempts', eventsOwnerNotIdentifiedWithoutAttempts()],
  ['rejects unknown domain auto-classified as retailer', eventsUnknownRetailer()],
  ['rejects saturation after a query with new domain or candidate', eventsFalseSaturation()],
  ['rejects one unreviewed candidate', eventsWithUnreviewedCandidate()],
  ['rejects two URLs in one owner group as independent', eventsSameOwnerGroupTwice()],
  ['rejects QA-like summary evidence in the research record', eventsWithDerivedSummary()],
  ['rejects verified without an exact product page', eventsVerifiedWithoutProductPage()],
  ['rejects copied trace from another product identity', eventsCopiedIdentityTrace()],
];
for (const [name, events] of negativeCases) test(name, () => {
  const result = deriveResults(validSnapshot(), events);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});
```

- [ ] **Step 2: Run the ten tests and verify RED**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "rejects"`

Expected: at least the gate cases fail because the validator does not yet enforce all rules. Fix test fixtures until each failure identifies a missing validator rule rather than a malformed test.

- [ ] **Step 3: Implement deterministic query materiality**

Add:

```js
export function materialQueryKey(query) { /* NFKC/lowercase, strip punctuation, page/continuation markers, sort substantive tokens */ }
export function materiallyDistinct(a, b) { return materialQueryKey(a) !== materialQueryKey(b); }
```

The validator must require two independent search systems and two materially distinct successful queries for saturation. Reordering tokens, changing quotes/whitespace, adding `page N`, or adding `exact continuation N` is not material. A query that produces a new relevant domain or candidate cannot satisfy a `no_new_*` condition.

- [ ] **Step 4: Implement catalog, owner, and source-group derivation**

Add an immutable `SOURCE_REGISTRY` to the schema module with explicit host patterns, `source_class`, `owner`, and `owner_group_id` for known official, regulator, and retailer branches. Unknown hosts resolve to `source_class: 'unknown'` and cannot count as retailer, official, regulator, or product-detail evidence. A catalog event counts only when its lookup key, result, candidate/no-match, and all candidate decisions are present. Owner-not-identified requires successful owner-specific attempts in both used search systems before saturation.

- [ ] **Step 5: Implement exact evidence and mg/sáček derivation**

Implement these checks in the validator:

```js
const exactEvidence = source => source.source_class !== 'unknown'
  && source.page_kind === 'product_detail'
  && source.match_decision === 'exact_match'
  && Number.isFinite(source.extracted?.strength_mg_per_pouch);
```

Require exact product identity, exact strength semantics, and matching variant fields. Allow `mg/g` conversion only when the same source supplies exact net weight and pouch count. Count at most one evidence branch per `owner_group_id`. Derive `verified`, `conflicted`, `unresolved_after_complete_search`, or `pending` exactly as specified in the design document.

- [ ] **Step 6: Run the ten tests and all validator tests GREEN**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "rejects|validator|saturation|catalog|owner|evidence"`

Expected: PASS with all ten negative cases rejected and valid complete fixtures accepted.

- [ ] **Step 7: Commit the gate rules**

```text
git add scripts/pouch-audit/recheck-v3-validator.mjs scripts/pouch-audit/recheck-v3-schema.mjs scripts/pouch-audit/recheck-v3.test.mjs
git commit -m "test: enforce v3 audit evidence gates"
```

### Task 5: Implement live transport and append-only pilot research

**Files:**
- Create: `scripts/pouch-audit/recheck-v3-transport.mjs`
- Modify: `scripts/pouch-audit/recheck-v3-research.mjs`
- Modify: `scripts/pouch-audit/recheck-v3-schema.mjs`
- Modify: `scripts/pouch-audit/recheck-v3.test.mjs`

- [ ] **Step 1: Write fixture-backed tests for raw-only research behavior**

```js
test('research writes raw events and never writes derived card states', async () => {
  const result = await researchOneInput(validPilotRow(), { fetchImpl: fixtureFetch(), outputPath: tempPath('raw-events.jsonl') });
  const events = await readRawEvents(result.rawPath);
  assert.ok(events.some((event) => event.event_type === 'search_attempt'));
  assert.ok(events.some((event) => event.event_type === 'url_opened'));
  assert.ok(events.some((event) => event.event_type === 'candidate_decision'));
  assert.doesNotMatch(readFileSync(result.rawPath, 'utf8'), /protocol_complete|saturation|outcome|qa_status/);
});

test('research opens every fixture candidate and records a decision without a fixed candidate cap', async () => {
  const result = await researchOneInput(rowWithEightCandidates(), { fetchImpl: fixtureFetch(), outputPath: tempPath('raw-events.jsonl') });
  const events = await readRawEvents(result.rawPath);
  assert.equal(events.filter((event) => event.event_type === 'url_opened').length, 8);
  assert.equal(events.filter((event) => event.event_type === 'candidate_decision').length, 8);
});
```

- [ ] **Step 2: Run the research tests and verify RED**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "research writes|every fixture"`

Expected: FAIL because the v3 transport and research functions do not yet exist.

- [ ] **Step 3: Implement transport with explicit cache/timeout semantics**

Export:

```js
export async function fetchLive(url, { fetchImpl = fetch, timeoutMs = 12000, cache = null } = {}) { /* return requested/final URL, status, title, body hash, body, cache_hit */ }
export function parseSearchResponse(response) { /* candidates plus parse_status */ }
export function parseProductResponse(response) { /* title and extracted product fields */ }
```

A cache hit must be recorded as `cache_hit: true` and never count as a successful path. A timeout or network failure must become a `transport_event`, not a synthetic HTTP success. Every live response gets a SHA-256 body hash and final URL.

- [ ] **Step 4: Implement deterministic pilot research order**

`researchOneInput` must append events in this order:

1. two independent search systems with identity/strength queries;
2. owner-specific search attempts in both systems;
3. source-registry catalog snapshots and item-specific lookups;
4. every discovered candidate opened or deterministically rejected with an individual reason;
5. additional materially distinct successful queries until the validator can derive saturation.

The function must never write a result summary, must never stop after seven candidates, and must not use v2 hashes, timestamps, statuses, or decisions as evidence. `researchPilot` selects exactly the five frozen rows whose original brand is `77 Pouches`, writes only those IDs to `progress.json`, and refuses to process any other ID.

- [ ] **Step 5: Run the fixture-backed research tests GREEN**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "research|candidate cap|pilot"`

Expected: PASS.

- [ ] **Step 6: Commit the raw research writer**

```text
git add scripts/pouch-audit/recheck-v3-transport.mjs scripts/pouch-audit/recheck-v3-research.mjs scripts/pouch-audit/recheck-v3-schema.mjs scripts/pouch-audit/recheck-v3.test.mjs
git commit -m "feat: record v3 pilot research as raw events"
```

### Task 6: Add independent QA and hash-bound artifacts

**Files:**
- Create: `scripts/pouch-audit/recheck-v3-qa.mjs`
- Modify: `scripts/pouch-audit/recheck-v3.test.mjs`
- Create: `audit/pouches/recheck-v3/qa.jsonl` through the QA command

- [ ] **Step 1: Write failing tests proving QA does not trust summaries**

```js
test('QA rejects a card whose only support is stored outcome/protocol_complete', () => {
  const card = { ...validDerivedResult(), outcome: 'verified', protocol_complete: true, verified_sources: [] };
  const qa = qaOneInput(validSnapshot().rows[0], rawEventsWithoutProductPage(), card);
  assert.equal(qa.qa_status, 'qa_failed');
  assert.match(qa.errors.join('\n'), /product|evidence|source/i);
});

test('QA records the exact input-card and raw-event hashes', () => {
  const qa = qaOneInput(validSnapshot().rows[0], completeNoEvidenceEvents(), validDerivedResult());
  assert.equal(qa.input_card_sha256, hashInputCard(validSnapshot().rows[0]));
  assert.equal(qa.raw_events_sha256, hashEvents(completeNoEvidenceEvents()));
});
```

- [ ] **Step 2: Run the QA tests and verify RED**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "QA rejects|exact input-card"`

Expected: FAIL because the independent QA module does not exist.

- [ ] **Step 3: Implement QA without importing research or validator**

Export:

```js
export function qaOneInput(inputRow, rawEvents, derivedResult, { sourceRegistry } = {}) { /* independently recheck */ }
export function qaV3Set(snapshot, events, derivedResults, options = {}) { /* exactly one QA row per ID */ }
export async function writeQaRows(path, rows) { /* JSONL output only */ }
```

QA must recheck input identity, event-chain integrity, event-to-candidate coverage, status semantics, owner-group independence, saturation preconditions, exact mg/sáček evidence, and absence of copied identity traces. It must calculate `input_card_sha256`, `raw_events_sha256`, and `derived_result_sha256` itself and set `qa_status` from those checks.

- [ ] **Step 4: Run all QA tests GREEN**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "QA|qa_status|hash"`

Expected: PASS.

- [ ] **Step 5: Commit independent QA**

```text
git add scripts/pouch-audit/recheck-v3-qa.mjs scripts/pouch-audit/recheck-v3.test.mjs
git commit -m "feat: add hash-bound independent v3 QA"
```

### Task 7: Implement CLI orchestration, pilot report, and approval gate

**Files:**
- Create/modify: `scripts/pouch-audit/recheck-v3.mjs`
- Modify: `scripts/pouch-audit/recheck-v3.test.mjs`
- Create: `audit/pouches/recheck-v3/derived-results.jsonl`, `pilot-report.md`, and `progress.json` through commands

- [ ] **Step 1: Write failing CLI tests for pilot scope and stop conditions**

```js
test('pilot CLI processes exactly five 77 Pouches IDs', () => {
  const result = runCli(['--pilot'], isolatedAuditEnv());
  assert.equal(result.status, 0, result.stderr);
  const progress = readJson('audit/pouches/recheck-v3/progress.json');
  assert.deepEqual(progress.processed_input_ids, five77InputIds());
  assert.equal(progress.processed_input_ids.length, 5);
});

test('batch CLI refuses to run before explicit pilot approval', () => {
  const result = runCli(['--batch', '--limit', '25'], isolatedAuditEnvWithPilot());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approval|pilot/i);
});

test('approval stores validator hash and later validator changes invalidate it', () => {
  runCli(['--approve-pilot'], isolatedAuditEnvWithPilot());
  mutateValidatorFixture();
  const result = runCli(['--batch', '--limit', '25'], isolatedAuditEnvWithPilot());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /validator.*hash|new pilot/i);
});
```

- [ ] **Step 2: Run the CLI tests and verify RED**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "pilot CLI|batch CLI|approval"`

Expected: FAIL because the v3 CLI modes do not yet exist.

- [ ] **Step 3: Implement the CLI modes and exit codes**

Implement exactly:

```text
--freeze
--pilot
--validate --pilot
--qa --pilot
--approve-pilot
--batch --limit 25
--validate
--qa
--apply-safe
```

`--pilot` requires a frozen snapshot and processes only the five selected IDs. `--validate --pilot` requires five complete derived results and returns code 0 only when all five are valid. `--qa --pilot` writes exactly five QA rows and does not edit raw events or derived cards. `--approve-pilot` requires a passed pilot validator and QA, records snapshot hash, validator source hash, five IDs, timestamp, and explicit approval basis. `--batch --limit N` rejects `N > 25`, missing approval, changed validator hash, or any incomplete previous batch.

- [ ] **Step 4: Implement the pilot report**

Generate `pilot-report.md` from raw events, derived results, and QA rows. For each of the five rows include the original frozen card and hash, every raw query and HTTP status, all candidates, all opened/final URLs and hashes, extracted fields, every candidate decision and reason, derived gates, saturation, `unreviewed_candidate_count`, outcome, QA status, and the three audit hashes. The report must not summarize away any candidate or event.

- [ ] **Step 5: Run CLI tests GREEN and verify no non-pilot ID is touched**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "pilot CLI|batch CLI|approval|report"`

Expected: PASS. The isolated audit directory must contain raw events for exactly five IDs.

- [ ] **Step 6: Commit the pilot gate**

```text
git add scripts/pouch-audit/recheck-v3.mjs scripts/pouch-audit/recheck-v3.test.mjs
git commit -m "feat: enforce v3 pilot approval gate"
```

### Task 8: Run the live five-card pilot and stop for explicit approval

**Files:**
- Create/update only: `audit/pouches/recheck-v3/input-snapshot.json`, `raw-events.jsonl`, `derived-results.jsonl`, `qa.jsonl`, `pilot-report.md`, `progress.json`
- Do not modify: `data.js`, historical v2 files, or the remaining 856-card queue

- [ ] **Step 1: Freeze and verify the 861-card snapshot**

Run: `node scripts/pouch-audit/recheck-v3.mjs --freeze`

Expected: exactly 861 rows, five `77 Pouches` rows, stable snapshot hash, and no `data.js` diff.

- [ ] **Step 2: Run only the five-card live pilot**

Run: `node scripts/pouch-audit/recheck-v3.mjs --pilot`

Expected: raw events for exactly the five frozen `77 Pouches` IDs; every discovered candidate has an open/decision pair or a deterministic rejection event; no v3 raw event contains a derived summary field.

- [ ] **Step 3: Run the read-only validator and independent QA for the pilot**

Run:

```text
node scripts/pouch-audit/recheck-v3.mjs --validate --pilot
node scripts/pouch-audit/recheck-v3.mjs --qa --pilot
```

Expected: the validator prints one complete derived row per pilot ID, QA prints one result per pilot ID, and hashes in the QA rows match the snapshot, raw-event subset, and derived result.

- [ ] **Step 4: Generate and inspect the five-card report**

Run: `node scripts/pouch-audit/recheck-v3.mjs --report --pilot`

Inspect `audit/pouches/recheck-v3/pilot-report.md` for all five cards, all candidates, all decisions, and separate `verified`, `conflicted`, and `unresolved_after_complete_search` counts. Confirm `data.js` remains unchanged with `git diff -- data.js`.

- [ ] **Step 5: Stop and request explicit user approval**

Do not run `--approve-pilot`, `--batch`, or any research command for the other 856 IDs. Present the report path, five card-level raw evidence sections, validator result, QA result, and limitations to the user. Continue only after an explicit approval response.

### Task 9: After approval, process batches and enforce the global gate

**Files:**
- Modify: `scripts/pouch-audit/recheck-v3.mjs`
- Modify: `scripts/pouch-audit/recheck-v3-research.mjs`
- Modify: `scripts/pouch-audit/recheck-v3-validator.mjs`
- Modify: `scripts/pouch-audit/recheck-v3-qa.mjs`
- Modify: `scripts/pouch-audit/recheck-v3.test.mjs`
- Create/update: v3 JSONL artifacts and `pilot-approval.json`

- [ ] **Step 1: Record approval only after the user approves the pilot**

Run: `node scripts/pouch-audit/recheck-v3.mjs --approve-pilot`

Expected: `pilot-approval.json` contains the pilot snapshot hash, validator source hash, exactly five approved IDs, approval timestamp, and `approval_basis: "explicit user approval"`.

- [ ] **Step 2: Add failing tests for batch size, freshness, and global exact coverage**

```js
test('rejects a batch larger than 25', () => assert.notEqual(runCli(['--batch', '--limit', '26'], approvedEnv()).status, 0));
test('rejects a batch after raw evidence changes without fresh QA', () => { /* append one event, assert batch refusal */ });
test('global validator requires 861 unique IDs and zero pending/unreviewed candidates', () => { /* assert fail-closed counts */ });
```

- [ ] **Step 3: Run these tests RED, then implement one-brand batches**

Process by original brand, at most 25 rows per checkpoint. Before the next batch, require the previous batch to have a matching frozen validator hash, fresh QA hashes, zero pending rows, and zero unreviewed candidates. Resume from raw events without duplicating an existing valid event chain.

- [ ] **Step 4: Run batch tests GREEN**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "batch|861|fresh QA|unreviewed"`

Expected: PASS.

- [ ] **Step 5: Run the remaining batches only after the explicit approval gate**

Run: `node scripts/pouch-audit/recheck-v3.mjs --batch --limit 25` repeatedly by brand until all 861 IDs have raw events, derived results, and fresh QA. After every batch, run the validator and QA before beginning the next one.

### Task 10: Add the final safe-application gate and verify completion

**Files:**
- Create: `scripts/pouch-audit/recheck-v3-apply.mjs`
- Modify: `scripts/pouch-audit/recheck-v3.test.mjs`
- Modify: `data.js` only for explicitly evidence-backed changes after the global gate

- [ ] **Step 1: Write failing tests for safe application refusal and idempotence**

```js
test('safe application refuses any global validation failure', () => {
  assert.throws(() => applySafeV3({ results: resultsWithPendingRow(), qa: completeQa(), dataSource: dataFixture() }), /861|pending|validation/i);
});

test('safe application leaves unresolved results unchanged and is idempotent', () => {
  const first = applySafeV3({ results: completeResults(), qa: completeQa(), dataSource: dataFixture() });
  const second = applySafeV3({ results: completeResults(), qa: completeQa(), dataSource: first.source });
  assert.equal(second.changed, false);
  assert.deepEqual(second.source, first.source);
});
```

- [ ] **Step 2: Run application tests RED**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "safe application|idempotent"`

Expected: FAIL because the v3 application gate does not exist.

- [ ] **Step 3: Implement fail-closed application**

`recheck-v3-apply.mjs` must refuse to write unless the validator and QA both report 861/861, zero pending/incomplete, zero unreviewed candidates, matching snapshot/event/card hashes, and valid evidence thresholds. It may change only row-local values with direct `verified` evidence; unresolved results remain unchanged. It must preserve row order and refuse a copied identity trace. A second invocation must produce no further `data.js` change.

- [ ] **Step 4: Run application tests GREEN**

Run: `node --test scripts/pouch-audit/recheck-v3.test.mjs --test-name-pattern "safe application|idempotent"`

Expected: PASS.

- [ ] **Step 5: Run the proportional final verification gate**

Run:

```text
node --test scripts/pouch-audit/recheck-v3.test.mjs
node scripts/pouch-audit/recheck-v3.mjs --validate
node scripts/pouch-audit/recheck-v3.mjs --qa
node scripts/pouch-audit/recheck-v3.mjs --apply-safe
node scripts/pouch-audit/recheck-v3.mjs --apply-safe
node --check data.js
node --check sw.js
git diff --check
git status --short
```

Expected: all tests pass, validator exits 0 for 861/861, QA exits 0 for 861/861, the second safe-application run reports no further change, JavaScript syntax checks pass, and no unrelated files are modified.

- [ ] **Step 6: Report the final audit counts and evidence boundaries**

Report exact counts for `verified`, `conflicted`, and `unresolved_after_complete_search`; confirm zero pending/incomplete and zero unreviewed candidates; include snapshot, validator, raw-event, derived-result, and QA hashes; list every `data.js` change with its direct evidence URL; and identify any unavailable sources and fallback paths. Never describe unresolved results as verified.

## Plan self-review

- The plan preserves all historical v2 files and leaves `data.js` unchanged through the five-card pilot.
- The validator and QA have explicit module-isolation tests and do not import the research writer.
- All ten requested negative cases have named tests and concrete fixture constructors.
- Candidate review has no fixed-count cap; every candidate is opened/classified or deterministically rejected.
- Saturation, owner resolution, catalog validity, source-group independence, and evidence thresholds are derived from raw facts rather than stored booleans.
- The plan stops after the pilot and requires explicit approval before any of the other 856 rows are researched.
- The final application gate is separate, fail-closed, and idempotent.
