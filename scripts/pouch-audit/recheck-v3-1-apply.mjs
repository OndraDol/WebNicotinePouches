function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function quote(value) { return JSON.stringify(String(value)); }

function assertGate({ snapshot, results, qaRows, validator }) {
  if (!snapshot || !Array.isArray(snapshot.rows)) throw new Error('Safe apply requires a snapshot');
  if (!validator?.ok || Number(validator.summary?.pending ?? 0) !== 0 || Number(validator.summary?.unreviewed ?? 0) !== 0) throw new Error('Safe apply requires a passing global validator gate');
  if (!Array.isArray(results) || !Array.isArray(qaRows) || results.length !== qaRows.length) throw new Error('Safe apply requires one QA row per result');
  if (new Set(results.map((row) => row.input_id)).size !== results.length) throw new Error('Safe apply requires unique results');
  if (qaRows.some((row) => row.qa_status !== 'qa_passed')) throw new Error('Safe apply refuses failed QA');
  if (results.some((row) => ['pending', 'conflicted'].includes(row.outcome) || Number(row.unreviewed_candidate_count ?? 0) !== 0)) throw new Error('Safe apply refuses pending, conflicted or unreviewed results');
}

export function applyVerifiedChanges(dataText, gate) {
  assertGate(gate);
  let text = String(dataText);
  const changedRows = [];
  for (const result of gate.results) {
    if (result.outcome !== 'verified') continue;
    const source = (result.verified_sources ?? []).find((item) => Number.isFinite(Number(item.strength_mg_per_pouch)) && item.url);
    if (!source) continue;
    const original = result.original;
    const nextMg = Number(source.strength_mg_per_pouch);
    if (!original || !Number.isFinite(nextMg) || nextMg === Number(original.mg)) continue;
    const pattern = new RegExp(`(\\{\\s*b\\s*:\\s*${escapeRegExp(quote(original.b))}\\s*,\\s*n\\s*:\\s*${escapeRegExp(quote(original.n))}\\s*,\\s*mg\\s*:\\s*)${escapeRegExp(String(original.mg))}(\\s*\\})`, 'u');
    const next = text.replace(pattern, `$1${String(nextMg)}$2`);
    if (next === text) {
      const alreadyApplied = new RegExp(`\\{\\s*b\\s*:\\s*${escapeRegExp(quote(original.b))}\\s*,\\s*n\\s*:\\s*${escapeRegExp(quote(original.n))}\\s*,\\s*mg\\s*:\\s*${escapeRegExp(String(nextMg))}\\s*\\}`, 'u').test(text);
      if (alreadyApplied) continue;
      throw new Error(`Safe apply could not locate exact data.js row for ${result.input_id}`);
    }
    text = next;
    changedRows.push({ input_id: result.input_id, source_url: source.url, from: Number(original.mg), to: nextMg });
  }
  return { text, changedRows };
}
