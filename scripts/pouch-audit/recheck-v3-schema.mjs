import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export const V3_EVENT_TYPES = new Set([
  'search_attempt',
  'catalog_lookup',
  'url_opened',
  'candidate_decision',
  'owner_lookup',
  'transport_event',
]);

export const DERIVED_FIELD_NAMES = new Set([
  'protocol_complete', 'protocolcomplete',
  'saturation',
  'outcome', 'final_outcome', 'finaloutcome',
  'qa_status', 'qastatus',
  'unreviewed_candidate_count', 'unreviewedcandidatecount',
  'derived_result', 'derivedresult', 'result_summary', 'resultsummary',
]);

const registryRows = [
  { host: 'haypp.com', source_class: 'retailer', owner: 'Haypp Group', owner_group_id: 'haypp-group' },
  { host: 'northerner.com', source_class: 'retailer', owner: 'Haypp Group', owner_group_id: 'haypp-group' },
  { host: 'nicopodsuk.com', source_class: 'retailer', owner: 'NicoPODS UK', owner_group_id: 'nicopodsuk' },
  { host: 'snusdirect.com', source_class: 'retailer', owner: 'Snusdirect', owner_group_id: 'snusdirect' },
  { host: 'velo.com', source_class: 'official', owner: 'BAT / VELO', owner_group_id: 'bat-velo' },
  { host: 'zyn.com', source_class: 'official', owner: 'Swedish Match / ZYN', owner_group_id: 'swedish-match-zyn' },
  { host: 'nordicspirit.co.uk', source_class: 'official', owner: 'JTI / Nordic Spirit', owner_group_id: 'jti-nordic-spirit' },
  { host: 'fumipods.com', source_class: 'official', owner: 'Helix Sweden / Fumi', owner_group_id: 'helix-fumi' },
  { host: 'pablopouch.com', source_class: 'official', owner: 'Pablo', owner_group_id: 'pablo' },
  { host: 'fda.gov', source_class: 'regulator', owner: 'US FDA', owner_group_id: 'us-fda' },
  { host: 'accessdata.fda.gov', source_class: 'regulator', owner: 'US FDA', owner_group_id: 'us-fda' },
  { host: 'canada.ca', source_class: 'regulator', owner: 'Health Canada', owner_group_id: 'health-canada' },
  { host: 'folkhalsomyndigheten.se', source_class: 'regulator', owner: 'Swedish Public Health Agency', owner_group_id: 'swedish-ph' },
  { host: 'sik.dk', source_class: 'regulator', owner: 'Danish Safety Technology Authority', owner_group_id: 'danish-safety' },
];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const SOURCE_REGISTRY = deepFreeze(registryRows.map((row) => ({ ...row })));

const normalizedDerivedNames = new Set([...DERIVED_FIELD_NAMES].map(normalizeFieldName));

function normalizeFieldName(value) {
  return String(value).replaceAll(/[^a-z0-9]/giu, '').toLocaleLowerCase('en-US');
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError(`Canonical JSON cannot contain undefined field ${key}`);
      output[key] = canonicalize(value[key]);
    }
    return output;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const input = typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value);
  return createHash('sha256').update(input).digest('hex');
}

export function hashInputCard(row) {
  return sha256({
    input_id: row.input_id,
    original_index: row.original_index,
    original: row.original,
  });
}

export function hashSnapshot(snapshot) {
  return sha256({
    schema: snapshot.schema,
    source_file: snapshot.source_file,
    input_snapshot_sha256: snapshot.input_snapshot_sha256,
    data_source_sha256: snapshot.data_source_sha256,
    rows: snapshot.rows,
  });
}

export function hashEvents(events) {
  return sha256(events);
}

export function sourceForUrl(url, registry = SOURCE_REGISTRY) {
  let hostname;
  try { hostname = new URL(url).hostname.toLocaleLowerCase('en-US'); } catch { return { source_class: 'unknown', owner: null, owner_group_id: null, host: null }; }
  const match = registry.find((entry) => hostname === entry.host || hostname.endsWith(`.${entry.host}`));
  return match ? { ...match, host: hostname } : { source_class: 'unknown', owner: null, owner_group_id: null, host: hostname };
}

function assertNoDerivedFields(value, path = 'event') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDerivedFields(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (normalizedDerivedNames.has(normalizeFieldName(key))) throw new Error(`Derived field ${key} is forbidden in raw event at ${path}`);
    assertNoDerivedFields(child, `${path}.${key}`);
  }
}

function assertSha(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
}

export function createRawEvent(input, { sequence, previousHash = null, recordedAt = new Date().toISOString() } = {}) {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error('Raw event sequence must be a positive integer');
  if (!input || typeof input !== 'object') throw new Error('Raw event input must be an object');
  if (typeof input.input_id !== 'string' || !input.input_id) throw new Error('Raw event input_id is required');
  if (!V3_EVENT_TYPES.has(input.event_type)) throw new Error(`Unknown v3 event type: ${input.event_type}`);
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new Error('Raw event payload must be an object');
  assertNoDerivedFields(input.payload, 'payload');
  if (previousHash !== null) assertSha(previousHash, 'previous_event_sha256');
  const event = {
    event_id: input.event_id ?? `evt-${String(sequence).padStart(6, '0')}`,
    input_id: input.input_id,
    event_type: input.event_type,
    recorded_at: recordedAt,
    sequence,
    previous_event_sha256: previousHash,
    payload: input.payload,
  };
  if (typeof event.event_id !== 'string' || !event.event_id) throw new Error('Raw event event_id is required');
  assertNoDerivedFields(event, 'event');
  return { ...event, event_sha256: sha256(event) };
}

export function assertRawEvent(event, { expectedSequence = null, expectedPreviousHash = null, expectedInputIds = null } = {}) {
  if (!event || typeof event !== 'object') throw new Error('Raw event must be an object');
  if (expectedSequence !== null && event.sequence !== expectedSequence) throw new Error(`Raw event sequence mismatch: expected ${expectedSequence}`);
  if (expectedPreviousHash !== null && event.previous_event_sha256 !== expectedPreviousHash) throw new Error('Raw event chain link mismatch');
  if (expectedInputIds && !expectedInputIds.has(event.input_id)) throw new Error(`Raw event input_id is outside frozen set: ${event.input_id}`);
  if (!V3_EVENT_TYPES.has(event.event_type)) throw new Error(`Unknown v3 event type: ${event.event_type}`);
  if (typeof event.recorded_at !== 'string' || Number.isNaN(Date.parse(event.recorded_at))) throw new Error('Raw event recorded_at is invalid');
  if (event.sequence < 1 || !Number.isInteger(event.sequence)) throw new Error('Raw event sequence is invalid');
  if (event.sequence === 1 && event.previous_event_sha256 !== null) throw new Error('First raw event must have a null previous hash');
  if (event.sequence > 1) assertSha(event.previous_event_sha256, 'previous_event_sha256');
  assertSha(event.event_sha256, 'event_sha256');
  assertNoDerivedFields(event, 'event');
  const { event_sha256: ignored, ...body } = event;
  if (sha256(body) !== event.event_sha256) throw new Error(`Raw event hash mismatch: ${event.event_id}`);
  return event;
}

export function verifyEventChain(events, expectedInputIds = null) {
  const errors = [];
  if (!Array.isArray(events)) return ['Raw events must be an array'];
  const seenIds = new Set();
  let previousHash = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    try {
      if (seenIds.has(event?.event_id)) throw new Error(`Duplicate event_id: ${event.event_id}`);
      seenIds.add(event?.event_id);
      assertRawEvent(event, { expectedSequence: index + 1, expectedPreviousHash: previousHash, expectedInputIds });
      previousHash = event.event_sha256;
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}

async function acquireAppendLock(path, timeoutMs = 30000) {
  const lockPath = `${path}.lock`;
  const started = Date.now();
  await mkdir(dirname(path), { recursive: true });
  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      return async () => {
        await handle.close();
        try { await unlink(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started >= timeoutMs) throw new Error(`Append lock timeout for ${path}; inspect and remove the lock only after confirming no writer is running`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

const appendQueues = new Map();
const appendStates = new Map();

async function fileSignature(path) {
  try {
    const info = await stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return { size: 0, mtimeMs: null };
    throw error;
  }
}

export async function appendRawEvent(path, input, clock = {}) {
  const previous = appendQueues.get(path) ?? Promise.resolve();
  let releaseQueue;
  const current = new Promise((resolve) => { releaseQueue = resolve; });
  appendQueues.set(path, current);
  await previous;
  try {
    const release = await acquireAppendLock(path, clock.lockTimeoutMs ?? 30000);
    try {
      const signature = await fileSignature(path);
      let state = appendStates.get(path);
      if (!state || state.size !== signature.size || state.mtimeMs !== signature.mtimeMs) {
        let events = [];
        try { events = await readRawEvents(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        state = { count: events.length, previousHash: events.at(-1)?.event_sha256 ?? null, ...signature };
      }
      const event = createRawEvent(input, {
        sequence: state.count + 1,
        previousHash: state.previousHash,
        recordedAt: clock.recordedAt ?? clock.now?.() ?? new Date().toISOString(),
      });
      await appendFile(path, `${canonicalJson(event)}\n`, 'utf8');
      appendStates.set(path, { count: event.sequence, previousHash: event.event_sha256, ...(await fileSignature(path)) });
      return event;
    } finally {
      await release();
    }
  } finally {
    releaseQueue();
    if (appendQueues.get(path) === current) appendQueues.delete(path);
  }
}

export async function readRawEvents(path) {
  let content;
  try { content = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const events = [];
  for (const [index, line] of content.split(/\r?\n/u).filter(Boolean).entries()) {
    try { events.push(JSON.parse(line)); } catch { throw new Error(`Malformed raw event JSON on line ${index + 1}`); }
  }
  const errors = verifyEventChain(events);
  if (errors.length) throw new Error(`Invalid raw event chain: ${errors.join('; ')}`);
  return events;
}
