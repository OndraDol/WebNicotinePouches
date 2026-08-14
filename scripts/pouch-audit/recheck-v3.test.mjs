import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DERIVED_FIELD_NAMES,
  SOURCE_REGISTRY,
  V3_EVENT_TYPES,
  appendRawEvent,
  canonicalJson,
  createRawEvent,
  hashEvents,
  hashInputCard,
  hashSnapshot,
  readRawEvents,
  sha256,
  verifyEventChain,
} from './recheck-v3-schema.mjs';
import { assertFrozenSnapshot, buildInputSnapshot } from './recheck-v3-freeze.mjs';
import { deriveResults, materiallyDistinct, materialQueryKey } from './recheck-v3-validator.mjs';
import { qaOneInput } from './recheck-v3-qa.mjs';
import { researchOneInput } from './recheck-v3-research.mjs';
import { applySafeV3 } from './recheck-v3-apply.mjs';
import { MAX_BATCH_SIZE, assertGlobalCoverage, assertFreshBatchState, reconcileActiveRawIds, selectNextBatch } from './recheck-v3-batch.mjs';
import { parseSearchResponse } from './recheck-v3-transport.mjs';
import { repairRawEventLog } from './recheck-v3-repair.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const INPUT_PATH = join(ROOT, 'audit', 'pouches', 'input.json');
const UNRESOLVED_PATH = join(ROOT, 'audit', 'pouches', 'unresolved-input.json');
const DATA_PATH = join(ROOT, 'data.js');

const INPUT_ID = 'input-fixture-0001';
const OTHER_INPUT_ID = 'input-fixture-0002';
const SHA = 'a'.repeat(64);

function fixtureRow(inputId = INPUT_ID, original = { b: 'Fixture', n: 'Fixture Mint', mg: 10 }) {
  const row = { input_id: inputId, original_index: 1, original };
  return { ...row, input_card_sha256: hashInputCard(row) };
}

function fixtureSnapshot(rows = [fixtureRow()]) {
  const base = {
    schema: 3,
    source_file: 'fixture/data.js',
    input_snapshot_sha256: SHA,
    data_source_sha256: SHA,
    rows,
  };
  return { ...base, snapshot_sha256: hashSnapshot(base) };
}

function eventChain(inputId, definitions) {
  let previousHash = null;
  return definitions.map((definition, index) => {
    const event = createRawEvent({
      event_id: `evt-fixture-${String(index + 1).padStart(4, '0')}`,
      input_id: inputId,
      event_type: definition.event_type,
      payload: definition.payload,
    }, {
      sequence: index + 1,
      previousHash,
      recordedAt: `2026-08-14T00:00:${String(index).padStart(2, '0')}.000Z`,
    });
    previousHash = event.event_sha256;
    return event;
  });
}

function searchEvent(system, query, candidateUrls = [], overrides = {}) {
  return {
    event_type: 'search_attempt',
    payload: {
      system,
      query,
      request_url: `https://${system}.fixture.test/search?q=${encodeURIComponent(query)}`,
      status: 200,
      final_url: `https://${system}.fixture.test/search?q=${encodeURIComponent(query)}`,
      title: 'Fixture search',
      response_sha256: SHA,
      parse_status: 'parsed',
      candidate_urls: candidateUrls,
      cache_hit: false,
      ...overrides,
    },
  };
}

function ownerEvent(system, owner = null, overrides = {}) {
  return {
    event_type: 'owner_lookup',
    payload: {
      system,
      query: `site:official.fixture.test ${owner ?? 'Fixture Mint'}`,
      status: 200,
      parse_status: 'parsed',
      owner,
      ...overrides,
    },
  };
}

function completeNoEvidenceEvents(inputId = INPUT_ID) {
  return eventChain(inputId, [
    searchEvent('google', 'Fixture Mint nicotine pouch'),
    searchEvent('bing', 'Fixture Mint nicotine pouch strength'),
    ownerEvent('google'),
    ownerEvent('bing'),
  ]);
}

function eventsWithUnreviewedCandidate() {
  const url = 'https://haypp.com/products/fixture-mint';
  return eventChain(INPUT_ID, [
    searchEvent('google', 'Fixture Mint nicotine pouch', [url]),
    searchEvent('bing', 'Fixture Mint nicotine pouch strength'),
    ownerEvent('google'),
    ownerEvent('bing'),
  ]);
}

function exactProductEvents({ secondOwnerGroup = false, copiedIdentity = false, pageKind = 'product_detail' } = {}) {
  const firstUrl = 'https://haypp.com/products/fixture-mint';
  const secondUrl = secondOwnerGroup
    ? 'https://northerner.com/products/fixture-mint'
    : 'https://snusdirect.com/products/fixture-mint';
  const identity = copiedIdentity ? 'Other Mint' : 'Fixture Mint';
  return eventChain(INPUT_ID, [
    searchEvent('google', 'Fixture Mint nicotine pouch', [firstUrl]),
    searchEvent('bing', 'Fixture Mint nicotine pouch strength', [secondUrl]),
    ownerEvent('google'),
    ownerEvent('bing'),
    {
      event_type: 'url_opened',
      payload: {
        requested_url: firstUrl,
        final_url: firstUrl,
        status: 200,
        title: 'Fixture Mint nicotine pouches',
        response_sha256: SHA,
        parse_status: 'parsed',
        page_kind: pageKind,
        extracted: { brand: 'Fixture', name: identity, strength_mg_per_pouch: 10 },
      },
    },
    {
      event_type: 'candidate_decision',
      payload: {
        candidate_url: firstUrl,
        match_decision: 'exact_match',
        reason: 'Exact fixture identity and strength on product detail page.',
      },
    },
    {
      event_type: 'url_opened',
      payload: {
        requested_url: secondUrl,
        final_url: secondUrl,
        status: 200,
        title: 'Fixture Mint nicotine pouches',
        response_sha256: SHA,
        parse_status: 'parsed',
        page_kind: 'product_detail',
        extracted: { brand: 'Fixture', name: 'Fixture Mint', strength_mg_per_pouch: 10 },
      },
    },
    {
      event_type: 'candidate_decision',
      payload: {
        candidate_url: secondUrl,
        match_decision: 'exact_match',
        reason: 'Exact fixture identity and strength on product detail page.',
      },
    },
  ]);
}

function validDerivedResult() {
  return {
    input_id: INPUT_ID,
    outcome: 'unresolved_after_complete_search',
    protocol_complete: true,
    saturation: true,
    owner_resolution: 'not_identified',
    unreviewed_candidate_count: 0,
    verified_sources: [],
    conflicts: [],
  };
}

function makeTempPath(name) {
  return mkdtemp(join(tmpdir(), 'pouch-v3-')).then((dir) => ({ dir, path: join(dir, name) }));
}

test('canonical JSON sorts object keys but preserves array order', () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 2, c: 3 }, list: [2, 1] }), '{"a":{"c":3,"d":2},"list":[2,1],"z":1}');
});

test('freezes exactly the 861 unresolved IDs without changing data.js', async () => {
  const [inputSnapshot, unresolvedInput, dataSourceText] = await Promise.all([
    readFile(INPUT_PATH, 'utf8').then(JSON.parse),
    readFile(UNRESOLVED_PATH, 'utf8').then(JSON.parse),
    readFile(DATA_PATH, 'utf8'),
  ]);
  const snapshot = buildInputSnapshot({ inputSnapshot, unresolvedInput, dataSourceText, now: '2026-08-14T00:00:00.000Z' });
  assert.equal(snapshot.rows.length, 861);
  assert.equal(new Set(snapshot.rows.map((row) => row.input_id)).size, 861);
  assert.equal(snapshot.rows.filter((row) => row.original.b === '77 Pouches').length, 5);
  assert.equal(snapshot.data_source_sha256, sha256(dataSourceText));
  assert.deepEqual(snapshot.rows[0].original, { b: '77 Pouches', n: '77 Black Currant Ice', mg: 10.4 });
});

test('rejects a changed original card or changed membership after freezing', async () => {
  const [inputSnapshot, unresolvedInput, dataSourceText] = await Promise.all([
    readFile(INPUT_PATH, 'utf8').then(JSON.parse),
    readFile(UNRESOLVED_PATH, 'utf8').then(JSON.parse),
    readFile(DATA_PATH, 'utf8'),
  ]);
  const frozen = buildInputSnapshot({ inputSnapshot, unresolvedInput, dataSourceText, now: '2026-08-14T00:00:00.000Z' });
  assert.throws(() => assertFrozenSnapshot(frozen, { ...frozen, rows: frozen.rows.slice(1) }), /861|snapshot|membership/i);
  assert.throws(() => assertFrozenSnapshot(frozen, {
    ...frozen,
    rows: frozen.rows.map((row, index) => index === 0 ? { ...row, original: { ...row.original, mg: 99 } } : row),
  }), /hash|original|snapshot/i);
});

test('appendRawEvent creates a linked hash-chain record', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    await appendRawEvent(path, { input_id: 'input-a', event_type: 'search_attempt', payload: { status: 200 } }, { recordedAt: '2026-08-14T00:00:00.000Z' });
    await appendRawEvent(path, { input_id: 'input-a', event_type: 'transport_event', payload: { kind: 'cache_hit' } }, { recordedAt: '2026-08-14T00:00:01.000Z' });
    const events = await readRawEvents(path);
    assert.equal(events.length, 2);
    assert.equal(events[1].previous_event_sha256, events[0].event_sha256);
    assert.deepEqual(verifyEventChain(events), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appendRawEvent serializes concurrent writers into one valid chain', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => appendRawEvent(path, {
      input_id: `input-concurrent-${index}`,
      event_type: 'transport_event',
      payload: { kind: 'fixture_concurrent_write', index },
    })));
    const events = await readRawEvents(path);
    assert.equal(events.length, 8);
    assert.deepEqual(verifyEventChain(events), []);
    assert.equal(new Set(events.map((event) => event.event_id)).size, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('raw-log repair preserves the corrupt source and restores only the valid prefix', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const valid = eventChain('input-repair', [
      { event_type: 'transport_event', payload: { kind: 'valid-1' } },
      { event_type: 'transport_event', payload: { kind: 'valid-2' } },
    ]);
    const corrupt = { ...valid[1], event_id: valid[0].event_id, sequence: valid[1].sequence - 1, previous_event_sha256: valid[0].previous_event_sha256 };
    await writeFile(path, `${valid.map((event) => JSON.stringify(event)).join('\n')}\n${JSON.stringify(corrupt)}\n`, 'utf8');
    const incidentPath = join(dir, 'raw-events-corrupt-incident.jsonl');
    const manifestPath = join(dir, 'raw-events-repair-manifest.json');
    const before = await readFile(path, 'utf8');
    const result = await repairRawEventLog({ sourcePath: path, targetPath: path, incidentPath, manifestPath, now: '2026-08-14T12:00:00.000Z' });
    assert.equal(await readFile(incidentPath, 'utf8'), before);
    assert.equal((await readRawEvents(path)).length, 2);
    assert.equal(result.manifest.valid_prefix_event_count, 2);
    assert.equal(result.manifest.invalid_suffix_count, 1);
    assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).source_sha256, sha256(before));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('raw-log repair rejects a structurally valid event outside the frozen input set', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const valid = eventChain('input-repair', [
      { event_type: 'transport_event', payload: { kind: 'valid-1' } },
      { event_type: 'transport_event', payload: { kind: 'valid-2' } },
    ]);
    const outside = createRawEvent({ input_id: 'input-outside', event_type: 'transport_event', payload: { kind: 'outside' } }, { sequence: 2, previousHash: valid[0].event_sha256, recordedAt: '2026-08-14T00:00:01.000Z' });
    await writeFile(path, `${JSON.stringify(valid[0])}\n${JSON.stringify(outside)}\n`, 'utf8');
    const incidentPath = join(dir, 'raw-events-outside-incident.jsonl');
    const manifestPath = join(dir, 'raw-events-outside-repair-manifest.json');
    const result = await repairRawEventLog({ sourcePath: path, targetPath: path, incidentPath, manifestPath, expectedInputIds: ['input-repair'], now: '2026-08-14T12:00:00.000Z' });
    assert.equal(result.manifest.valid_prefix_event_count, 1);
    assert.equal((await readRawEvents(path)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('raw event validation rejects derived summary fields anywhere in payload', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    await assert.rejects(() => appendRawEvent(path, {
      input_id: 'input-a', event_type: 'search_attempt', payload: { protocol_complete: true },
    }), /derived|protocol_complete/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validator source does not import the research module', async () => {
  const source = await readFile(new URL('./recheck-v3-validator.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /recheck-v3-research/);
});

test('validator derives pending when one candidate has no open and decision events', () => {
  const result = deriveResults(fixtureSnapshot(), eventsWithUnreviewedCandidate());
  assert.equal(result.rows[0].outcome, 'pending');
  assert.equal(result.rows[0].unreviewed_candidate_count, 1);
  assert.equal(result.ok, false);
});

test('validator derives unresolved only after every required action is evidenced', () => {
  const result = deriveResults(fixtureSnapshot(), completeNoEvidenceEvents());
  assert.equal(result.rows[0].outcome, 'unresolved_after_complete_search');
  assert.equal(result.rows[0].protocol_complete, true);
  assert.equal(result.rows[0].unreviewed_candidate_count, 0);
});

test('validator matches a redirected opened URL back to its discovered candidate URL', () => {
  const definitions = exactProductEvents().map((event) => ({ event_type: event.event_type, payload: event.payload }));
  definitions.splice(2, 0,
    searchEvent('google', 'Fixture Mint ingredients'),
    searchEvent('bing', 'Fixture Mint product details'),
  );
  const events = eventChain(INPUT_ID, definitions);
  const originalCandidate = 'https://haypp.com/products/fixture-mint';
  const redirectedUrl = `${originalCandidate}?ref=search-redirect`;
  const firstOpenIndex = events.findIndex((event) => event.event_type === 'url_opened');
  const firstDecisionIndex = events.findIndex((event) => event.event_type === 'candidate_decision');
  events[firstOpenIndex] = { ...events[firstOpenIndex], payload: { ...events[firstOpenIndex].payload, final_url: redirectedUrl } };
  events[firstDecisionIndex] = { ...events[firstDecisionIndex], payload: { ...events[firstDecisionIndex].payload, candidate_url: redirectedUrl } };
  const result = deriveResults(fixtureSnapshot(), events);
  assert.equal(result.rows[0].unreviewed_candidate_count, 0);
  assert.equal(result.rows[0].outcome, 'verified', result.rows[0].errors.join('\n'));
});

test('validator matches a proxy-opened URL through its explicit original candidate relation', () => {
  const candidate = 'https://daraz.example/products/fixture';
  const proxy = 'https://r.jina.ai/http://daraz.example/products/fixture';
  const events = eventChain(INPUT_ID, [
    searchEvent('google', 'Fixture Mint nicotine pouch', [candidate]),
    searchEvent('bing', 'Fixture Mint nicotine pouch strength'),
    ownerEvent('google'), ownerEvent('bing'),
    searchEvent('google', 'Fixture Mint ingredients'),
    searchEvent('bing', 'Fixture Mint product details'),
    { event_type: 'url_opened', payload: { candidate_url: candidate, requested_url: proxy, final_url: proxy, status: 200, parse_status: 'parsed', page_kind: 'product_detail', extracted: { name: 'Different Fixture', strength_mg_per_pouch: 10 } } },
    { event_type: 'candidate_decision', payload: { candidate_url: candidate, match_decision: 'near_match', reason: 'Proxy-opened candidate is related but not exact evidence.' } },
  ]);
  const result = deriveResults(fixtureSnapshot(), events);
  assert.equal(result.rows[0].unreviewed_candidate_count, 0);
  assert.equal(result.rows[0].outcome, 'unresolved_after_complete_search');
});

const negativeCases = [
  ['rejects second search system with HTTP 429', () => {
    const events = completeNoEvidenceEvents();
    events[1] = { ...events[1], payload: { ...events[1].payload, status: 429 } };
    return events;
  }],
  ['rejects three general catalogs without item-specific lookup', () => eventChain(INPUT_ID, [
    ...completeNoEvidenceEvents().map((event) => ({ event_type: event.event_type, payload: event.payload })),
    ...['one', 'two', 'three'].map((name) => ({ event_type: 'catalog_lookup', payload: { catalog: name, result: 'found', candidate_urls: ['https://unknown.test/item'] } })),
  ])],
  ['rejects owner not identified without owner attempts', () => eventChain(INPUT_ID, completeNoEvidenceEvents().filter((event) => event.event_type !== 'owner_lookup').map((event) => ({ event_type: event.event_type, payload: event.payload })))],
  ['rejects unknown domain auto-classified as retailer', () => eventChain(INPUT_ID, [
    ...completeNoEvidenceEvents().map((event) => ({ event_type: event.event_type, payload: event.payload })),
    { event_type: 'url_opened', payload: { requested_url: 'https://unknown.test/fixture', final_url: 'https://unknown.test/fixture', status: 200, parse_status: 'parsed', page_kind: 'product_detail', source_class: 'retailer', extracted: { brand: 'Fixture', name: 'Fixture Mint', strength_mg_per_pouch: 10 } } },
  ])],
  ['rejects saturation after a query with new domain or candidate', () => eventChain(INPUT_ID, [
    searchEvent('google', 'Fixture Mint nicotine pouch', ['https://haypp.com/products/fixture-mint']),
    searchEvent('bing', 'Fixture Mint nicotine pouch strength'),
    ownerEvent('google'), ownerEvent('bing'),
  ])],
  ['rejects one unreviewed candidate', () => eventsWithUnreviewedCandidate()],
  ['rejects two URLs in one owner group as independent', () => exactProductEvents({ secondOwnerGroup: true })],
  ['rejects QA-like summary evidence in the research record', () => null],
  ['rejects verified without an exact product page', () => exactProductEvents({ pageKind: 'search_results' })],
  ['rejects copied trace from another product identity', () => exactProductEvents({ copiedIdentity: true })],
];

for (const [name, makeEvents] of negativeCases) {
  test(name, async () => {
    if (name.includes('QA-like')) {
      const { dir, path } = await makeTempPath('raw-events.jsonl');
      try {
        await assert.rejects(() => appendRawEvent(path, {
          input_id: INPUT_ID, event_type: 'search_attempt', payload: { outcome: 'verified' },
        }), /derived|outcome/i);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return;
    }
    const result = deriveResults(fixtureSnapshot(), makeEvents());
    assert.equal(result.ok, false, result.errors?.join('\n'));
    assert.ok(result.errors.length > 0);
  });
}

test('material query normalization ignores continuation and formatting noise', () => {
  assert.equal(materialQueryKey('"Fixture Mint" nicotine pouch page 2'), materialQueryKey('nicotine pouch Fixture Mint exact continuation 2'));
  assert.equal(materiallyDistinct('Fixture Mint nicotine pouch', 'Fixture Mint strength nicotine pouch'), true);
});

test('QA rejects a card whose only support is stored outcome/protocol_complete', () => {
  const card = { ...validDerivedResult(), outcome: 'verified', protocol_complete: true, verified_sources: [] };
  const qa = qaOneInput(fixtureSnapshot().rows[0], completeNoEvidenceEvents(), card);
  assert.equal(qa.qa_status, 'qa_failed');
  assert.match(qa.errors.join('\n'), /product|evidence|source/i);
});

test('QA records the exact input-card and raw-event hashes', () => {
  const events = completeNoEvidenceEvents();
  const qa = qaOneInput(fixtureSnapshot().rows[0], events, validDerivedResult());
  assert.equal(qa.input_card_sha256, hashInputCard(fixtureSnapshot().rows[0]));
  assert.equal(qa.raw_events_sha256, hashEvents(events));
});

test('research writes raw events and never writes derived card states', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const result = await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: fixtureFetch() });
    const events = await readRawEvents(result.rawPath);
    assert.ok(events.some((event) => event.event_type === 'search_attempt'));
    assert.ok(events.some((event) => event.event_type === 'url_opened'));
    assert.ok(events.some((event) => event.event_type === 'candidate_decision'));
    assert.doesNotMatch(await readFile(result.rawPath, 'utf8'), /protocol_complete|saturation|outcome|qa_status/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research opens every fixture candidate and records a decision without a fixed candidate cap', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const result = await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: fixtureFetch(8) });
    const events = await readRawEvents(result.rawPath);
    assert.equal(events.filter((event) => event.event_type === 'url_opened').length, 8);
    assert.equal(events.filter((event) => event.event_type === 'candidate_decision').length, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research performs candidate page reads concurrently while preserving raw event order', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  let active = 0;
  let maxActive = 0;
  try {
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) {
        return new Response(JSON.stringify({ title: 'Fixture search', candidates: Array.from({ length: 8 }, (_, index) => `https://haypp.com/products/fixture-mint-${index + 1}`) }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return new Response('<html><title>Fixture Mint</title><body>Fixture Mint 10 mg per pouch</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    } });
    assert.ok(maxActive > 1, `expected concurrent candidate reads, observed ${maxActive}`);
    const events = await readRawEvents(path);
    assert.deepEqual(events.filter((event) => event.event_type === 'url_opened').map((event) => event.payload.candidate_url), Array.from({ length: 8 }, (_, index) => `https://haypp.com/products/fixture-mint-${index + 1}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research retries a blocked Naver owner lookup with the web endpoint', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    await researchOneInput(fixtureRow(), {
      outputPath: path,
      searchSystems: [{ id: 'naver', base: 'https://search.naver.com/search.naver?query=' }],
      catalogs: [],
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.hostname === 'search.naver.com' && parsed.searchParams.has('where')) {
          return new Response(JSON.stringify({ title: 'Naver web fallback', candidates: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (parsed.hostname === 'search.naver.com') return new Response('blocked', { status: 403, headers: { 'content-type': 'text/html' } });
        throw new Error('fixture should not open candidates');
      },
    });
    const owners = (await readRawEvents(path)).filter((event) => event.event_type === 'owner_lookup');
    assert.equal(owners.length, 1);
    assert.ok(owners.every((event) => event.payload.status === 200));
    assert.ok(owners.every((event) => event.payload.fallback_from?.includes('search.naver.com')));
    assert.ok(owners.every((event) => event.payload.request_url.includes('where=web')));
    assert.ok(owners.every((event) => event.payload.request_url.includes('%20')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research retries a blocked Naver web owner lookup on the mobile endpoint', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    await researchOneInput(fixtureRow(), {
      outputPath: path,
      searchSystems: [{ id: 'naver', base: 'https://search.naver.com/search.naver?query=' }],
      catalogs: [],
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.hostname === 'm.search.naver.com') return new Response(JSON.stringify({ title: 'Naver mobile fallback', candidates: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (parsed.hostname === 'search.naver.com') return new Response('blocked', { status: 403, headers: { 'content-type': 'text/html' } });
        throw new Error('fixture should not open candidates');
      },
    });
    const owners = (await readRawEvents(path)).filter((event) => event.event_type === 'owner_lookup');
    assert.equal(owners.length, 1);
    assert.equal(owners[0].payload.status, 200);
    assert.match(owners[0].payload.request_url, /^https:\/\/m\.search\.naver\.com\//u);
    assert.ok(owners[0].payload.fallback_from?.includes('search.naver.com'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research retries blocked Naver searches on the mobile endpoint', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    await researchOneInput(fixtureRow(), {
      outputPath: path,
      searchSystems: [{ id: 'naver', base: 'https://search.naver.com/search.naver?query=' }],
      catalogs: [],
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.hostname === 'm.search.naver.com') return new Response(JSON.stringify({ title: 'Naver mobile search fallback', candidates: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (parsed.hostname === 'search.naver.com') return new Response('blocked', { status: 403, headers: { 'content-type': 'text/html' } });
        throw new Error('fixture should not open candidates');
      },
    });
    const searches = (await readRawEvents(path)).filter((event) => event.event_type === 'search_attempt');
    assert.equal(searches.length, 3);
    assert.ok(searches.every((event) => event.payload.status === 200));
    assert.ok(searches.every((event) => event.payload.request_url.startsWith('https://m.search.naver.com/')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research records a deterministic rejection when an obvious forum candidate cannot be opened', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const forumUrl = 'http://www.busanopen.org/new/bbs/view.php?bbs_id=news_brirf_bsopen&doc_num=12';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [forumUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (parsed.hostname === 'www.busanopen.org') throw new Error('fixture candidate transport failure');
      return new Response('<html><title>Fixture Mint</title><body>Fixture Mint 10 mg per pouch</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    } });
    const events = await readRawEvents(path);
    const decision = events.find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, forumUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
    assert.equal(deriveResults(fixtureSnapshot(), events).rows[0].outcome, 'unresolved_after_complete_search');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects legacy event page URLs', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const eventUrl = 'http://www.oldchesterpa.com/events_christmas_chg20100907.htm';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [eventUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture legacy event transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, eventUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects legacy forum endpoint families', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidates = [
      'http://go.jinbo.net/commune/view.php?board=akdam-3-2&id=12',
      'http://www.pipecon.co.kr/zeroboard/zboard.php?id=Gallery&no=27',
      'http://www.xn--299aqdt1jvvj.com/?act=board&bbs_code=sub2_3&bbs_mode=view&bbs_seq=294',
      'http://peroriqp.eek.jp/cgi-bin/ahh255e/mibbs.cgi?mo=p&fo=qp&tn=14522',
      'http://www.dicafamily.com/layout.php?cath=board&exec=view&code=notice&uid=8&page=1',
    ];
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture legacy forum transport failure');
    } });
    const decisions = (await readRawEvents(path)).filter((event) => event.event_type === 'candidate_decision');
    assert.equal(decisions.length, candidates.length);
    assert.ok(decisions.every((event) => event.payload.rejection_rule === 'non_product_document_or_forum'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects document download endpoints', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const documentUrl = 'https://www.rfs.ru/subject/1/documents/download?documentId=1486';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [documentUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (parsed.hostname === 'www.rfs.ru') throw new Error('fixture document transport failure');
      return new Response('<html><title>Fixture Mint</title><body>Fixture Mint 10 mg per pouch</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    } });
    const events = await readRawEvents(path);
    const decision = events.find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, documentUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects repository blob document URLs', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const blobUrl = 'https://huggingface.co/philschmid/my-onnx-repo/blob/main/tokenizer.json';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [blobUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture repository blob transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, blobUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects named report download endpoints', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const reportUrl = 'https://www.kimst.re.kr/contentNewFile.do?path=FinalReport&fn=20250709RS-2021-KS211537&dn=20210681(RS-2021-KS211537)_FinalReport.pdf&gb=www';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [reportUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture named report download transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, reportUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects legal database index pages', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const legalIndexUrl = 'https://curia.europa.eu/en/content/juris/t2_juris.htm';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [legalIndexUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture legal database transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, legalIndexUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects retailer collection index pages', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const collectionUrl = 'https://europesnus.com/collections';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [collectionUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture retailer collection transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, collectionUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects music chart index pages', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const chartUrl = 'https://kworb.net/itunes/extended.html';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [chartUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture chart index transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, chartUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects journal article and legal download URLs', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidates = [
      'https://www.jksee.or.kr/journal/view.php?number=4123',
      'https://www.law.go.kr/LSW/flDownload.do?flSeq=133570583&flNm=annex.pdf',
    ];
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture journal or legal download transport failure');
    } });
    const decisions = (await readRawEvents(path)).filter((event) => event.event_type === 'candidate_decision');
    assert.equal(decisions.length, candidates.length);
    assert.ok(decisions.every((event) => event.payload.rejection_rule === 'non_product_document_or_forum'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects a retailer brand landing page', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const landingUrl = 'https://www.snusexpress.com/apres';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [landingUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture retailer brand landing transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, landingUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects legacy reunion event pages', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidates = [
      'http://www.oldchesterpa.com/reunions/chs_75_reunion_chg20100212.htm',
      'http://www.oldchesterpa.com/reunions/sv_all_reunion_chg20100907.htm',
    ];
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture legacy reunion transport failure');
    } });
    const decisions = (await readRawEvents(path)).filter((event) => event.event_type === 'candidate_decision');
    assert.equal(decisions.length, candidates.length);
    assert.ok(decisions.every((event) => event.payload.rejection_rule === 'non_product_document_or_forum'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects blog index and gist pages', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidates = [
      'https://www.bloggang.com/mainblog.php?id=princessjeab',
      'https://gist.github.com/ix4/89daf90da69561407c13d96f05939b46',
    ];
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture blog or gist transport failure');
    } });
    const decisions = (await readRawEvents(path)).filter((event) => event.event_type === 'candidate_decision');
    assert.equal(decisions.length, candidates.length);
    assert.ok(decisions.every((event) => event.payload.rejection_rule === 'non_product_document_or_forum'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects trade notification detail pages', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const tradeUrl = 'https://www.kita.net/tradeNavi/sps/spsDetail.do?notiId=NTSPS202603301234';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [tradeUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture trade notification transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, tradeUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects CAMRA organization pages', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const camraUrl = 'https://www.london.camra.org.uk/viewnode.php?id=105284';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [camraUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture CAMRA organization transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, camraUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects image galleries and institutional repositories', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidates = [
      'https://www.colombopereira.com/es/igaleriaplus/album/4/cultural/',
      'https://edepot.wur.nl/411255',
    ];
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture gallery or repository transport failure');
    } });
    const decisions = (await readRawEvents(path)).filter((event) => event.event_type === 'candidate_decision');
    assert.equal(decisions.length, candidates.length);
    assert.ok(decisions.every((event) => event.payload.rejection_rule === 'non_product_document_or_forum'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects GitLab blobs, leak sites, and digital files', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidates = [
      'https://gitlab.com/Maurux01/keyboard-game/-/blob/main/assets/english_words.txt',
      'https://nicoleaks.com/',
      'https://dl.kotra.or.kr/pyxis-api/2/digital-files/c16960ef-eb65-018a-e053-b46464899664',
    ];
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture GitLab, leak, or digital-file transport failure');
    } });
    const decisions = (await readRawEvents(path)).filter((event) => event.event_type === 'candidate_decision');
    assert.equal(decisions.length, candidates.length);
    assert.ok(decisions.every((event) => event.payload.rejection_rule === 'non_product_document_or_forum'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects organization roots and MFDS file downloads', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidates = [
      'http://www.teamsi.co.kr/',
      'https://impfood.mfds.go.kr/file/downloadFile?fileSeq=10001302837&servFileName=1584860726591EcJ8N.xlsx',
    ];
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture organization or MFDS download transport failure');
    } });
    const decisions = (await readRawEvents(path)).filter((event) => event.event_type === 'candidate_decision');
    assert.equal(decisions.length, candidates.length);
    assert.ok(decisions.every((event) => event.payload.rejection_rule === 'non_product_document_or_forum'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects unrelated product and caffeine database pages', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidates = [
      'https://www.theguitar.co.kr/product/detail.html?product_no=608',
      'https://www.caffeineinformer.com/the-caffeine-database',
    ];
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture unrelated product or caffeine database transport failure');
    } });
    const decisions = (await readRawEvents(path)).filter((event) => event.event_type === 'candidate_decision');
    assert.equal(decisions.length, candidates.length);
    assert.ok(decisions.every((event) => event.payload.rejection_rule === 'non_product_document_or_forum'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects legacy down_proc download endpoints', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const downloadUrl = 'https://www.lwbooks.co.kr/customer/down_proc.asp?downPath=/files/Board/file/201906200902262019%EB%85%84%EA%B0%80%EA%B2%A9%EC%9D%B8%EC%83%81%ED%91%9C.xls&downName=2019%EB%85%84%EA%B0%80%EA%B2%A9%EC%9D%B8%EC%83%81%ED%91%9C.xls';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [downloadUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture down_proc transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, downloadUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects unrelated guitar shop roots', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const shopUrl = 'http://guitarshop.co.kr/';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [shopUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture guitar shop transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, shopUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects symposium abstract-book list downloads', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidates = [
      'https://kalas.or.kr/03_symposium/down_lst_sym.php?mode=abook&idx=NDY=',
      'https://kalas.or.kr/03_symposium/down_lst_sym.php?mode=abook&idx=NDg=',
    ];
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture abstract-book list transport failure');
    } });
    const decisions = (await readRawEvents(path)).filter((event) => event.event_type === 'candidate_decision');
    assert.equal(decisions.length, candidates.length);
    assert.ok(decisions.every((event) => event.payload.rejection_rule === 'non_product_document_or_forum'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research records a generic proxy fallback without treating it as trusted evidence', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidateUrl = 'https://external.example/products/fixture-mint';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [candidateUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (parsed.hostname === 'external.example') throw new Error('fixture candidate transport failure');
      if (parsed.hostname === 'r.jina.ai') return new Response('<html><title>Fixture Mint</title><body>Fixture Mint 10 mg per pouch</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response('<html><title>Fixture Mint</title><body>Fixture Mint 10 mg per pouch</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    } });
    const events = await readRawEvents(path);
    const opened = events.find((event) => event.event_type === 'url_opened');
    assert.equal(opened.payload.candidate_url, candidateUrl);
    assert.equal(opened.payload.transport_fallback, 'jina_ai');
    assert.match(opened.payload.proxy_url, /^https:\/\/r\.jina\.ai\//u);
    assert.equal(events.find((event) => event.event_type === 'candidate_decision').payload.candidate_url, candidateUrl);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects explicit community board detail URLs', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const boardUrl = 'https://www.koreaksm.co.kr/default/community/sub3.php?com_board_basic=read_form&com_board_idx=11';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [boardUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (parsed.hostname === 'www.koreaksm.co.kr') throw new Error('fixture board transport failure');
      return new Response('<html><title>Fixture Mint</title><body>Fixture Mint 10 mg per pouch</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    } });
    const events = await readRawEvents(path);
    const decision = events.find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, boardUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects unavailable blog-host candidates', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const blogUrl = 'https://reportworld.tistory.com/333';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [blogUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture blog transport failure');
    } });
    const events = await readRawEvents(path);
    const decision = events.find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, blogUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects legacy board and gallery URLs', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidates = [
      'https://vmcwv.org/bbs_old/view.php?id=sub06_01&no=23',
      'http://www.miraei.com/paintingpic/read.php?picseq=64',
    ];
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture content transport failure');
    } });
    const decisions = (await readRawEvents(path)).filter((event) => event.event_type === 'candidate_decision');
    assert.equal(decisions.length, candidates.length);
    assert.ok(decisions.every((event) => event.payload.rejection_rule === 'non_product_document_or_forum'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects abstract-book and attachment download URLs', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidates = [
      'https://www.kiche.or.kr/conference/history_abstract_book/ca1eef33-a703-461e-9037-25b1fe98ddc1',
      'https://www.kps.or.kr/include/lib/download_attachment_common.php?tn=if_service_posts&sid=49&ak=1',
    ];
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture archive transport failure');
    } });
    const decisions = (await readRawEvents(path)).filter((event) => event.event_type === 'candidate_decision');
    assert.equal(decisions.length, candidates.length);
    assert.ok(decisions.every((event) => event.payload.rejection_rule === 'non_product_document_or_forum'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects legacy news article URLs', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const newsUrl = 'http://www.sejongin.co.kr/tv/view.html?idxno=1&update=Y';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [newsUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture news transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, newsUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects post attachment URLs', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const attachmentUrl = 'https://www.kosfost.or.kr/include/lib/download_post_attachment.php?id=2971&idx=2';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [attachmentUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture attachment transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, attachmentUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects academic article and PDF URLs', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidates = [
      'https://www.koreascience.or.kr/article/JAKO199411921593926.page',
      'https://www.e-jkfn.org/journal/download_pdf.php?doi=10.3746/jkfn.2023.52.2.113',
    ];
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture academic transport failure');
    } });
    const decisions = (await readRawEvents(path)).filter((event) => event.event_type === 'candidate_decision');
    assert.equal(decisions.length, candidates.length);
    assert.ok(decisions.every((event) => event.payload.rejection_rule === 'non_product_document_or_forum'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects board download endpoints', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const downloadUrl = 'https://www.naqs.go.kr/hp/fileManage/bbsDownload.do?fileGroupId=1766541170&fileName=fixture.pdf';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [downloadUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture board download transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, downloadUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects suffixed download endpoints', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const downloadUrl = 'https://www.guideline.or.kr/func/download_renew.php?number=96';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [downloadUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture suffixed download transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, downloadUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects legacy PHP board detail URLs', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const boardUrl = 'http://www.withsmile.co.kr/007/sub07_05.php?mode=view&number=2502';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [boardUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture legacy PHP board transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, boardUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects SEC filing URLs', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const filingUrl = 'https://www.sec.gov/Archives/edgar/data/1095052/000106299324017514/0001062993-24-017514.txt';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [filingUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture SEC filing transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, filingUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function fixtureFetch(candidateCount = 1) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) {
      const candidates = Array.from({ length: candidateCount }, (_, index) => `https://haypp.com/products/fixture-mint-${index + 1}`);
      return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('<html><title>Fixture Mint</title><body>Fixture Mint 10 mg per pouch</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
}

test('pilot CLI processes exactly five 77 Pouches IDs and no other IDs', () => {
  const result = spawnSync(process.execPath, ['scripts/pouch-audit/recheck-v3.mjs', '--pilot'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) assert.match(`${result.stderr}\n${result.stdout}`, /snapshot|pilot|freeze/i);
});

test('batch CLI refuses a batch larger than 25 even after pilot approval', () => {
  const result = spawnSync(process.execPath, ['scripts/pouch-audit/recheck-v3.mjs', '--batch', '--limit', '26'], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /1 to 25|limit/i);
});

test('batch selector returns at most 25 rows from one brand after the five pilot rows', () => {
  const rows = Array.from({ length: 32 }, (_, index) => fixtureRow(`input-${index}`, { b: index < 30 ? 'Brand A' : 'Brand B', n: `Product ${index}`, mg: 10 }));
  const selected = selectNextBatch(rows, new Set(rows.slice(0, 5).map((row) => row.input_id)), MAX_BATCH_SIZE);
  assert.equal(selected.length, 25);
  assert.ok(selected.every((row) => row.original.b === 'Brand A'));
  assert.equal(selected[0].input_id, 'input-5');
});

test('resume reconciles only uncheckpointed raw IDs from the active batch', () => {
  assert.deepEqual(
    reconcileActiveRawIds(['input-a'], ['input-a', 'input-b'], ['input-b', 'input-c'], ['input-a', 'input-b', 'input-c']),
    ['input-a', 'input-b'],
  );
  assert.throws(() => reconcileActiveRawIds(['input-a'], ['input-a', 'input-z'], ['input-b'], ['input-a', 'input-b', 'input-z']), /active batch|raw|checkpoint/i);
});

test('batch gate rejects stale or incomplete validator and QA state', () => {
  assert.throws(() => assertFreshBatchState({
    expectedIds: ['input-a'],
    validator: { ok: false, summary: { pending: 1 } },
    qaRows: [{ input_id: 'input-a', qa_status: 'qa_passed' }],
  }), /validator|pending|complete/i);
  assert.throws(() => assertFreshBatchState({
    expectedIds: ['input-a'],
    validator: { ok: true, summary: { pending: 0, unreviewed: 0 } },
    qaRows: [{ input_id: 'input-a', qa_status: 'qa_failed' }],
  }), /QA|failed/i);
});

test('search parser excludes Naver navigation links but keeps an external product candidate', () => {
  const parsed = parseSearchResponse({
    status: 200,
    body: '<html><a href="https://search.naver.com/search.naver?q=fixture">search</a><a href="https://smartstore.naver.com/shop/item">naver shop</a><a href="https://retailer.example/products/fixture">product</a></html>',
    title: 'Fixture search',
    cache_hit: false,
  });
  assert.deepEqual(parsed.candidate_urls, ['https://retailer.example/products/fixture']);
});

test('global coverage gate fails closed unless all 861 frozen IDs have derived and QA rows', () => {
  const frozenIds = Array.from({ length: 861 }, (_, index) => `input-${index}`);
  const results = frozenIds.slice(0, -1).map((input_id) => ({ input_id, outcome: 'unresolved_after_complete_search' }));
  const qa = results.map(({ input_id }) => ({ input_id, qa_status: 'qa_passed' }));
  assert.throws(() => assertGlobalCoverage(frozenIds, results, qa), /861|coverage|missing/i);
});

test('safe application refuses any global validation failure', () => {
  assert.throws(() => applySafeV3({ results: [{ input_id: INPUT_ID, outcome: 'pending' }], qa: [], dataSource: 'export const POUCH_DB = [];', expectedCount: 861 }), /861|pending|validation/i);
});

test('safe application leaves unresolved results unchanged and is idempotent', () => {
  const source = 'export const POUCH_DB = [{ b: "Fixture", n: "Fixture Mint", mg: 10 }];\n';
  const rows = Array.from({ length: 861 }, (_, index) => ({ input_id: `input-${index}`, outcome: 'unresolved_after_complete_search', original: { b: 'Fixture', n: `Fixture ${index}`, mg: 10 } }));
  const qa = rows.map((row) => ({ input_id: row.input_id, qa_status: 'qa_passed' }));
  const first = applySafeV3({ results: rows, qa, dataSource: source, expectedCount: 861 });
  const second = applySafeV3({ results: rows, qa, dataSource: first.source, expectedCount: 861 });
  assert.equal(second.changed, false);
  assert.deepEqual(second.source, first.source);
});

test('research deterministically rejects fn=fileDownload endpoints', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const downloadUrl = 'https://www.kgca-i.or.kr/html/?pmode=abstzipview&smode=ajax&fn=fileDownload&seq=19159&fnm=fixture';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [downloadUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture download transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, downloadUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects additional file download endpoints', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidates = [
      'https://www.mcee.go.kr/home/file/readDownloadFile.do?fileId=222062&fileSeq=1',
      'http://www.nims.go.kr/_part/downloadFile.jsp?cate=file&idx=910',
      'https://www.snubh.org/file_download.do?board_id=B007&fileOrgName=fixture.xlsx',
    ];
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture download transport failure');
    } });
    const decisions = (await readRawEvents(path)).filter((event) => event.event_type === 'candidate_decision');
    assert.equal(decisions.length, candidates.length);
    assert.ok(decisions.every((event) => event.payload.rejection_rule === 'non_product_document_or_forum'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects suffixed board detail URLs', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const boardUrl = 'https://www.koses.org/?act=board.index&bbs_code=gallery&bbs_mode=view&bbs_seq=129';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [boardUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture board transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, boardUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects nicotine pouch collection roots', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const collectionUrl = 'https://theroyalsnus.eu/nicotine-pouches';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [collectionUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture collection transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, collectionUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects competition results pages', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const resultsUrl = 'https://thetastingalliance.com/results/2024-san-francisco-world-spirits-competition-results/';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [resultsUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture event results transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, resultsUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects upload download endpoints', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidates = [
      'https://www.gskorea.or.kr/html/?pmode=BBBS0002700007&smode=ajax&fn=downFile&fileSeq=1563',
      'https://www.mcst.go.kr/servlets/eduport/front/upload/UplDownloadFile?pFileName=fixture.pdf&pRealName=fixture.pdf&pPath=0301000000',
    ];
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture upload download transport failure');
    } });
    const decisions = (await readRawEvents(path)).filter((event) => event.event_type === 'candidate_decision');
    assert.equal(decisions.length, candidates.length);
    assert.ok(decisions.every((event) => event.payload.rejection_rule === 'non_product_document_or_forum'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects attachment filename download endpoints', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const downloadUrl = 'https://www.cancer.go.kr/org_bbs_b_download.do?attach_seq=8134';
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates: [downloadUrl] }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture attachment download transport failure');
    } });
    const decision = (await readRawEvents(path)).find((event) => event.event_type === 'candidate_decision');
    assert.equal(decision.payload.candidate_url, downloadUrl);
    assert.equal(decision.payload.rejection_rule, 'non_product_document_or_forum');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research deterministically rejects PDF guestbook and services pages', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    const candidates = [
      'https://www.jmir.org/2021/1/PDF',
      'https://tractorpullingwekerom.nl/gastenboek.php',
      'https://www.theinternationalman.com/connoisseur-products-and-services.php',
    ];
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('google') || parsed.hostname.includes('bing')) return new Response(JSON.stringify({ title: 'Fixture search', candidates }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('fixture unrelated page transport failure');
    } });
    const decisions = (await readRawEvents(path)).filter((event) => event.event_type === 'candidate_decision');
    assert.equal(decisions.length, candidates.length);
    assert.ok(decisions.every((event) => event.payload.rejection_rule === 'non_product_document_or_forum'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research records a transparent proxy fallback for blocked search and owner lookups', async () => {
  const { dir, path } = await makeTempPath('raw-events.jsonl');
  try {
    await researchOneInput(fixtureRow(), { outputPath: path, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'www.google.com') return new Response('blocked', { status: 429 });
      if (parsed.hostname === 'r.jina.ai') return new Response(JSON.stringify({ title: 'Proxy search', candidates: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (parsed.hostname === 'www.bing.com') return new Response(JSON.stringify({ title: 'Bing search', candidates: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (parsed.hostname.includes('haypp') || parsed.hostname.includes('northerner')) return new Response('not found', { status: 404 });
      throw new Error(`unexpected fixture URL: ${url}`);
    }, searchSystems: [
      { id: 'google', base: 'https://www.google.com/search?q=' },
      { id: 'bing', base: 'https://www.bing.com/search?q=' },
    ] });
    const events = await readRawEvents(path);
    const googleSearch = events.find((event) => event.event_type === 'search_attempt' && event.payload.system === 'google');
    const googleOwner = events.find((event) => event.event_type === 'owner_lookup' && event.payload.system === 'google');
    assert.equal(googleSearch.payload.status, 200);
    assert.equal(googleSearch.payload.transport_fallback, 'jina_ai');
    assert.match(googleSearch.payload.request_url, /^https:\/\/www\.google\.com\//u);
    assert.match(googleSearch.payload.proxy_url, /^https:\/\/r\.jina\.ai\//u);
    assert.equal(googleOwner.payload.status, 200);
    assert.equal(googleOwner.payload.transport_fallback, 'jina_ai');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

assert.equal(V3_EVENT_TYPES.has('search_attempt'), true);
assert.equal(DERIVED_FIELD_NAMES.has('outcome'), true);
assert.ok(SOURCE_REGISTRY);
