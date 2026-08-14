# Pouch recheck v2 Implementation Plan

> **For agentic workers:** This plan is executed inline in the current workspace. No commit, push, deploy, reset, checkout, or broad regeneration is allowed.

**Goal:** Re-open and independently document all 861 frozen unresolved pouch inputs with evidence cards that pass a strict second-pass validator.

**Architecture:** Keep the existing audit outputs untouched and write a separate v2 JSONL card file, QA JSONL file, and progress file. Candidate URLs may be read from old cache/logs only for discovery; every evidence URL, search endpoint, official catalog, and retailer branch used by v2 is fetched again and hashed during this run. A small read-only validator enforces exact ID coverage, one-card uniqueness, allowed outcomes, current response hashes, branch/search/protocol requirements, and `qa_status=passed`.

**Tech Stack:** Node.js ESM, built-in `fetch`, `node:crypto`, `node:fs`, existing product parsing/matching helpers, `node:test`.

---

### Task 1: Define the v2 evidence-card contract and immutable queue

**Files:**
- Create: `scripts/pouch-audit/recheck-v2.mjs`
- Create: `scripts/pouch-audit/recheck-v2.test.mjs`
- Create: `audit/pouches/recheck-v2.jsonl`
- Create: `audit/pouches/recheck-v2-qa.jsonl`
- Create: `audit/pouches/recheck-v2-progress.md`

- [ ] Load `audit/pouches/unresolved-input.json`, assert exactly 861 rows, preserve each complete original record, and initialize all IDs as `pending` in the v2 progress state.
- [ ] Define card fields for exact identity, market, outcome, unique queries, reopened direct URLs, owner/branch/source metadata, status/title/checked_at/SHA-256, explicit nicotine and pack measurements, match decisions with reasons, paraphrased evidence, threshold explanation, protocol steps, and QA status.
- [ ] Reject `exhausted_10m`, cache-only evidence, snippets, duplicate URLs, duplicate query shapes, and non-allowed outcomes in the validator.
- [ ] Add tests for frozen-set equality, duplicate rejection, prohibited terminal states, and strict required-field enforcement.

### Task 2: Run live brand-batched research and write resumable cards

**Files:**
- Modify: `scripts/pouch-audit/recheck-v2.mjs`
- Modify: `audit/pouches/recheck-v2.jsonl`
- Modify: `audit/pouches/recheck-v2-progress.md`

- [ ] Reuse old source-index and old research data only to discover candidate URLs; never copy old hashes, timestamps, statuses, or evidence values into v2.
- [ ] For each ID, reopen exact candidates and perform two semantically different searches through two search systems, an identified owner/catalog attempt, the market-relevant registry attempt when applicable, and three independent retailer branches; classify every opened candidate as `exact_match`, `near_match`, or `wrong_variant` with a concrete reason.
- [ ] Accept `verified` only with one exact owner/regulator source or two independent retailer branches; accept `conflicted` only with two exact direct sources that disagree; otherwise record the complete protocol as `not_verifiable_after_protocol`.
- [ ] Process at most four brands concurrently and checkpoint progress after each brand or 25 IDs with counts for all outcomes and QA states. Resume only from a v2 card whose live evidence can still be validated; otherwise leave it pending.

### Task 3: Perform an independent second pass

**Files:**
- Create/modify: `scripts/pouch-audit/recheck-v2-qa.mjs`
- Modify: `audit/pouches/recheck-v2-qa.jsonl`

- [ ] Read every v2 card independently of summary counts, reopen all verified/conflicted evidence URLs, and verify all not-verifiable cards contain the full required protocol with no synthetic or dependent steps.
- [ ] Check exact brand/name/variant/strength/market pairing, nicotine-per-pouch semantics, conversion inputs, branch ownership, query uniqueness, response hashes, and allowed outcome vocabulary.
- [ ] Write exactly one QA result per frozen ID; for any doubt write `qa_status=qa_failed` and return the ID to pending for another research pass.

### Task 4: Apply only safe changes after the stop condition

**Files:**
- Modify: `scripts/pouch-audit/lib.mjs` or `run.mjs` only as required to consume passed v2 records
- Modify: `data.js` only for evidence-backed row-local changes/removals
- Modify: `sw.js` only if an existing cache-bump rule requires it

- [ ] Run the read-only v2 validator and refuse application unless all 861 cards are unique, complete, allowed, and `qa_status=passed`.
- [ ] Apply only exact safe changes supported by v2 verified/conflicted evidence; do not alter data for not-verifiable cards.
- [ ] Verify a second apply attempt is idempotent.

### Task 5: Run the final verification gate and report

**Files:**
- No additional files unless a failed check identifies a necessary correction.

- [ ] Run the new read-only v2 validator, `node --test`, `node scripts/pouch-audit/run.mjs --validate --offline`, `node --check data.js`, `node --check sw.js`, `git diff --check`, and `git status --short`.
- [ ] Report exact 861/861 QA coverage, outcome counts, controller returns, data.js changes with direct evidence, unavailable sources and fallbacks, and every command result. Do not commit, push, or deploy.
