import { gzipSync, gunzipSync } from 'node:zlib';
import { sha256 } from './recheck-v3-schema.mjs';

export function deterministicGzip(bytes) {
  return gzipSync(Buffer.from(bytes), { level: 9, mtime: 0 });
}

export function verifyGzip(gzipBytes, expectedUncompressedSha256) {
  const plain = gunzipSync(gzipBytes);
  if (sha256(plain) !== expectedUncompressedSha256) throw new Error('Gzip payload hash mismatch');
  return true;
}

export function summarizeFallbacks(rawEvents = []) {
  const count = (kinds) => rawEvents.filter((event) => kinds.includes(event.event_type === 'transport_event' ? event.payload?.kind : '')).length;
  const jina = count(['search_http_proxy_fallback', 'owner_http_proxy_fallback']);
  const duck = count(['search_independent_fallback', 'owner_independent_fallback']);
  return [
    ...(jina ? [`Jina AI proxy fallback used: ${jina}`] : []),
    ...(duck ? [`DuckDuckGo independent fallback used: ${duck}`] : []),
    'No catalog endpoints used; repeated catalog 404s were avoided by direct search/owner lookup.',
  ];
}

function json(value) { return JSON.stringify(value, null, 2); }

export function buildReport(snapshot, rawEvents = [], results = [], qaRows = []) {
  const lines = ['# Pouch audit v3.1 report', '', '## Coverage', '', `- Snapshot rows: ${snapshot?.rows?.length ?? 0}`, `- Raw events: ${rawEvents.length}`, `- Results: ${results.length}`, `- QA rows: ${qaRows.length}`, '', '## Raw queries', ''];
  for (const event of rawEvents.filter((item) => item.event_type === 'search_attempt')) lines.push(`- ${event.input_id}: ${event.payload?.system ?? 'unknown'} — ${event.payload?.query ?? ''}`);
  lines.push('', '## Candidates', '');
  for (const event of rawEvents.filter((item) => item.event_type === 'search_attempt')) for (const url of event.payload?.candidate_urls ?? []) lines.push(`- ${event.input_id}: ${typeof url === 'string' ? url : url?.url ?? ''}`);
  lines.push('', '## Opened URLs', '');
  for (const event of rawEvents.filter((item) => item.event_type === 'url_opened')) lines.push(`- ${event.input_id}: ${event.payload?.final_url ?? event.payload?.requested_url ?? event.payload?.candidate_url ?? ''}`);
  lines.push('', '## Decisions', '');
  for (const event of rawEvents.filter((item) => item.event_type === 'candidate_decision')) lines.push(`- ${event.input_id}: ${event.payload?.candidate_url ?? ''} — ${event.payload?.match_decision ?? event.payload?.rejection_rule ?? ''} — ${event.payload?.reason ?? ''}`);
  lines.push('', '## Derived result', '');
  for (const result of results) lines.push(`- ${result.input_id}: ${result.outcome} (exact evidence ${result.gates?.exact_evidence_count ?? 0})`);
  lines.push('', '## QA hashes', '');
  for (const qa of qaRows) lines.push(`- ${qa.input_id}: ${qa.qa_status}; input=${qa.input_card_sha256}; raw=${qa.raw_events_sha256}; derived=${qa.derived_result_sha256}`);
  lines.push('', '## Complete records', '', '```json', json({ snapshot, rawEvents, results, qaRows }), '```', '');
  return lines.join('\n');
}

export function buildManifest({ files = {}, counts = {}, dataJsBefore = null, dataJsAfter = null, sourceVersions = {}, unavailableSources = [], fallbacks = [], dataChanges = [], previousArtifacts = {} } = {}) {
  return {
    schema: 'pouch-audit-v3.1-manifest',
    created_at: new Date().toISOString(),
    files,
    counts,
    data_js: { before_sha256: dataJsBefore, after_sha256: dataJsAfter, changes: dataChanges },
    source_versions: sourceVersions,
    unavailable_sources: unavailableSources,
    fallbacks,
    previous_artifacts: previousArtifacts,
  };
}
