import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applySafeChanges,
  bumpServiceWorkerIfNeeded,
  buildLedger,
  collectSourceIndex,
  ensureGitignore,
  loadOrCreateInputSnapshot,
  resolvePaths,
  validateAudit,
  writeAuditOutputs,
} from './lib.mjs';
import { hasTerminalResearchState, runResearch } from './research.mjs';
import { mergeV2IntoLedger, validateV2Set } from './recheck-v2.mjs';

function usage() {
  console.error('Usage: node scripts/pouch-audit/run.mjs --refresh [--offline] [--apply-safe] | --validate --offline');
}

function parseArgs(argv) {
  return {
    refresh: argv.includes('--refresh'),
    validate: argv.includes('--validate'),
    offline: argv.includes('--offline'),
    applySafe: argv.includes('--apply-safe'),
  };
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8').trim();
  return content ? content.split(/\r?\n/u).map((line) => JSON.parse(line)) : [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ((args.refresh === args.validate) || (args.applySafe && !args.refresh)) {
    usage();
    process.exitCode = 2;
    return;
  }
  const workspaceRoot = process.env.POUCH_AUDIT_WORKSPACE_ROOT ?? process.cwd();
  const auditRoot = process.env.POUCH_AUDIT_ROOT ?? workspaceRoot;
  const paths = resolvePaths(workspaceRoot, auditRoot);

  if (args.validate) {
    const result = await validateAudit(paths);
    if (result.ok) {
      console.log(`validation: ok (${result.ledgerRows} ledger rows, ${result.finalRows} final POUCH_DB rows)`);
      return;
    }
    console.error('validation: failed');
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  const snapshot = await loadOrCreateInputSnapshot(paths);
  if (snapshot.input_rows !== snapshot.rows.length) throw new Error('Input snapshot metadata is inconsistent');
  let frozen;
  if (existsSync(paths.unresolvedPath)) {
    frozen = JSON.parse(readFileSync(paths.unresolvedPath, 'utf8'));
    const snapshotIds = new Set(snapshot.rows.map((row) => row.input_id));
    if (frozen.unresolved_rows !== frozen.rows.length || frozen.rows.some((row) => !snapshotIds.has(row.input_id))) throw new Error('Frozen unresolved input set is inconsistent with immutable input snapshot');
  } else {
    const currentLedger = existsSync(paths.ledgerPath) ? readFileSync(paths.ledgerPath, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)) : [];
    frozen = await (await import('./lib.mjs')).freezeUnresolvedInput(paths, snapshot, currentLedger);
  }
  const gitignoreChanged = await ensureGitignore(paths);
  const sourceIndex = existsSync(paths.sourceIndexPath) ? JSON.parse(readFileSync(paths.sourceIndexPath, 'utf8')) : await collectSourceIndex({ paths, offline: args.offline, candidateRows: snapshot.rows });
  const researchRecords = frozen.rows.length ? await runResearch({ paths, frozen, sourceIndex, offline: args.offline }) : [];
  if (researchRecords.length && researchRecords.every(hasTerminalResearchState)) {
    sourceIndex.research = { completed_at: new Date().toISOString(), records: researchRecords.map((record) => ({ input_id: record.input_id, checked_at: record.checked_at, terminal_reason: record.terminal_reason, research_status: record.research_status, active_search_seconds: record.active_search_seconds, checked_urls: record.checked_urls, source_owner: record.source_owner, evidence: record.evidence })) };
  }
  let ledger = buildLedger(snapshot, sourceIndex, researchRecords);
  const v2Path = join(paths.auditDir, 'recheck-v2.jsonl');
  const v2QaPath = join(paths.auditDir, 'recheck-v2-qa.jsonl');
  if (existsSync(v2Path) || existsSync(v2QaPath)) {
    if (!existsSync(v2Path) || !existsSync(v2QaPath) || !existsSync(paths.unresolvedPath)) throw new Error('v2 artifacts are incomplete; refusing ledger refresh.');
    const frozenV2 = JSON.parse(readFileSync(paths.unresolvedPath, 'utf8')).rows;
    const v2Cards = readJsonLines(v2Path);
    const v2Qa = readJsonLines(v2QaPath);
    const v2Validation = validateV2Set(frozenV2, v2Cards, v2Qa, { requirePassed: true });
    if (!v2Validation.ok) throw new Error(`Refusing ledger refresh until recheck-v2 passes: ${v2Validation.errors.slice(0, 5).join('; ')}`);
    ledger = mergeV2IntoLedger(ledger, v2Cards);
  }
  let applyResult = { changed: false, removed: 0, reason: 'not requested' };
  let swChanged = false;
  if (args.applySafe) {
    if (snapshot.rows.length !== snapshot.expected_input_rows || snapshot.rows.length !== 1036) {
      throw new Error(`Refusing safe cleanup because immutable input row count is ${snapshot.rows.length}, not the expected 1036.`);
    }
    applyResult = await applySafeChanges(paths, snapshot, ledger);
    swChanged = await bumpServiceWorkerIfNeeded(paths, applyResult.changed);
  }
  await writeAuditOutputs(paths, snapshot, ledger, sourceIndex, applyResult);
  console.log(JSON.stringify({
    mode: 'refresh',
    offline: args.offline,
    input_rows: snapshot.rows.length,
    ledger_rows: ledger.length,
    exact_duplicate_removals: ledger.filter((item) => item.reason_code === 'exact_duplicate').length,
    applied: args.applySafe,
    data_changed: applyResult.changed,
    data_removed: applyResult.removed,
    sw_cache_bumped: swChanged,
    gitignore_changed: gitignoreChanged,
    idempotence: applyResult.reason === 'already applied' ? 'no further data.js change' : null,
  }, null, 2));
}

main().catch((error) => {
  console.error(`pouch-audit: ${error.stack ?? error.message ?? error}`);
  process.exitCode = 1;
});
