import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { assertRawEvent, canonicalJson, sha256 } from './recheck-v3-schema.mjs';

async function preserveIncident(sourcePath, incidentPath, sourceText, sourceHash) {
  try {
    const existing = await readFile(incidentPath, 'utf8');
    if (sha256(existing) !== sourceHash) throw new Error(`Incident copy exists with a different hash: ${incidentPath}`);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(incidentPath), { recursive: true });
  await copyFile(sourcePath, incidentPath);
  const copied = await readFile(incidentPath, 'utf8');
  if (sha256(copied) !== sourceHash || copied !== sourceText) throw new Error('Forensic incident copy verification failed');
}

export async function repairRawEventLog({ sourcePath, targetPath = sourcePath, incidentPath, manifestPath, now = new Date().toISOString() } = {}) {
  if (!sourcePath || !incidentPath || !manifestPath) throw new Error('Raw-log repair requires sourcePath, incidentPath, and manifestPath');
  const sourceText = await readFile(sourcePath, 'utf8');
  const sourceHash = sha256(sourceText);
  const lines = sourceText.split(/\r?\n/u).filter(Boolean);
  const validLines = [];
  const invalidEvents = [];
  const seenIds = new Set();
  let previousHash = null;
  let firstInvalidLine = null;

  for (let index = 0; index < lines.length; index += 1) {
    let event;
    let errorMessage;
    try {
      event = JSON.parse(lines[index]);
      if (seenIds.has(event.event_id)) throw new Error(`Duplicate event_id: ${event.event_id}`);
      if (event.sequence !== index + 1) throw new Error(`Sequence mismatch: expected ${index + 1}, received ${event.sequence}`);
      if (event.previous_event_sha256 !== previousHash) throw new Error(`Previous hash mismatch at ${event.event_id}`);
      assertRawEvent(event, { expectedSequence: index + 1 });
    } catch (error) {
      errorMessage = error.message;
    }
    if (errorMessage) {
      firstInvalidLine = index;
      invalidEvents.push({ line: index + 1, event_id: event?.event_id ?? null, error: errorMessage });
      break;
    }
    seenIds.add(event.event_id);
    previousHash = event.event_sha256;
    validLines.push(lines[index]);
  }

  if (firstInvalidLine === null) throw new Error('Raw event log is already valid; no repair performed');
  await preserveIncident(sourcePath, incidentPath, sourceText, sourceHash);
  const repairedText = validLines.length ? `${validLines.join('\n')}\n` : '';
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, repairedText, 'utf8');
  const repairedHash = sha256(repairedText);
  const manifest = {
    schema: 3,
    repair_type: 'append_only_log_fork',
    repaired_at: now,
    source_path: sourcePath,
    source_sha256: sourceHash,
    source_event_count: lines.length,
    valid_prefix_event_count: validLines.length,
    invalid_suffix_count: lines.length - validLines.length,
    invalid_events: invalidEvents,
    incident_copy_path: incidentPath,
    repaired_path: targetPath,
    repaired_sha256: repairedHash,
    evidence_boundary: 'Events after the first invalid chain record remain only in the incident copy and are not used as v3 evidence.',
  };
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`, 'utf8');
  return { manifest };
}
