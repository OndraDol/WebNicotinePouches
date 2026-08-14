# Pouch product audit implementation plan

> **For agentic workers:** This plan is executed inline in the current workspace. No commit, push, deploy, reset, checkout, or broad regeneration is allowed.

**Goal:** Audit every originally unresolved pouch input, produce resumable evidence, apply only safe changes, and pass the requested validations.

**Architecture:** Extend the existing Node standard-library audit tool with an immutable unresolved-set snapshot, a per-input resumable researcher, append-only research records, and stricter validation. Reuse existing cached source discovery only as candidate input; promote only exact, evidence-backed matches.

**Tech Stack:** Node.js ESM, `node:fs`, `node:crypto`, `node:test`, built-in `fetch`, existing `data.js` parser.

---

### Task 1: Freeze the exact unresolved set and define the research contract

**Files:**
- Modify: `scripts/pouch-audit/lib.mjs`
- Modify: `scripts/pouch-audit/run.mjs`
- Test: `scripts/pouch-audit/run.test.mjs`
- Create: `audit/pouches/unresolved-input.json`

- [ ] Add a freeze helper that reads the existing immutable snapshot and current ledger, selects exactly `no_match + ambiguous`, preserves source order, writes a hash and count, and refuses to silently change an existing freeze.
- [ ] Add schema helpers for terminal research records and final ledger fields, including `research_status`, `active_search_seconds`, and `terminal_reason`.
- [ ] Add a failing test proving a second freeze cannot alter the frozen ID set.
- [ ] Run the focused test and observe the expected failure before implementation.

### Task 2: Implement resumable per-input research and append-only logging

**Files:**
- Modify: `scripts/pouch-audit/lib.mjs`
- Modify: `scripts/pouch-audit/run.mjs`
- Test: `scripts/pouch-audit/run.test.mjs`
- Create: `audit/pouches/research-log.jsonl`

- [ ] Add cached response reads, exact query generation, source-branch grouping, response SHA-256 evidence, and a bounded active-search loop.
- [ ] Reuse existing structured detail/source records only after exact full-name/variant/strength pairing; record every checked URL and result.
- [ ] Add live exact-query fallback through built-in `fetch`; retain robots/CAPTCHA/geoblock/age-gate outcomes without treating them as proof of nonexistence.
- [ ] Complete a row as verified/conflicted immediately when evidence permits; otherwise continue until 600 active seconds and record `exhausted_10m`.
- [ ] Make restart skip only rows with a valid final research record and append one terminal record per frozen ID.
- [ ] Add failing tests for resume, exact-name rejection, and the 600-second terminal contract, then implement and run them.

### Task 3: Rebuild ledger/output writers around the completed research set

**Files:**
- Modify: `scripts/pouch-audit/lib.mjs`
- Modify: `scripts/pouch-audit/run.mjs`
- Test: `scripts/pouch-audit/run.test.mjs`
- Modify: `audit/pouches/ledger.jsonl`
- Modify: `audit/pouches/manual-review.csv`
- Modify: `audit/pouches/summary.md`
- Modify: `audit/pouches/progress.md`
- Modify: `audit/pouches/source-index.json`

- [ ] Merge research records into one final row per frozen ID with all required statuses and explicit numeric/null fields.
- [ ] Keep caffeine and non-nicotine products with `mg=0`; never use caffeine, mg/g, or title numerals as pouch mg.
- [ ] Generate checkpoint progress after each brand or 25 rows, and ensure all eight original conflict groups remain resolved or listed in manual review.
- [ ] Add validation for exact ID coverage, final fields, evidence hashes, active-time threshold, duplicate-free final catalog, and unchanged runtime schema.

### Task 4: Apply safe changes and verify idempotence

**Files:**
- Modify: `data.js` only for approved row-local changes/removals
- Modify: `sw.js` only if the existing cache bump is required by a data change

- [ ] Run the completed audit with `--apply-safe` after all 861 records have terminal states.
- [ ] Verify the mapper can apply changes to the existing 987-row working copy without rewriting unrelated rows.
- [ ] Run `--apply-safe` a second time and assert no further data change.

### Task 5: Run the complete validation gate and report evidence

**Files:**
- No additional source changes unless a validation failure identifies a required fix.

- [ ] Run `node --test`.
- [ ] Run `node scripts/pouch-audit/run.mjs --validate --offline`.
- [ ] Run `node --check data.js`, `node --check sw.js`, `git diff --check`, and `git status --short`.
- [ ] Recount all requested categories and list every `data.js` change, removal reason, limitation, changed file, and verification result.
