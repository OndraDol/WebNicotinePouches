# QA Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Do not deploy or invoke production account deletion.

**Goal:** Fix all 11 confirmed QA findings, including a production-ready but non-destructively tested account-deletion flow.

**Architecture:** Put reusable validation, storage, date, CSV, merge, benchmark, and achievement decisions in a dependency-free browser/Node module. Keep DOM orchestration in `index.html`. Implement deletion as an injected pure handler wrapped by a Firebase v2 callable. Preserve the current static hosting architecture and use Node's built-in test runner.

**Tech Stack:** HTML/CSS, browser JavaScript modules, Node.js 22 `node:test`, Firebase Web SDK 10.12.2, Firebase Admin 12.x, Firebase Functions 5.x, Firestore, Firebase Authentication, service worker cache API.

---

### Task 1: Add failing core regression tests

**Files:**
- Create: `tests/app-core.test.mjs`
- Create: `app-core.mjs`

- [ ] Test safe JSON fallback without mutating the corrupt source.
- [ ] Test settings validation boundaries and a past quit date.
- [ ] Test strict, atomic backup validation including a malicious history ID.
- [ ] Test Prague local date/time conversion around midnight.
- [ ] Test RFC 4180 escaping and spreadsheet-formula neutralization.
- [ ] Test deterministic guest/cloud history merging.
- [ ] Test empty benchmark and the minimum tracking window for both badges.
- [ ] Run `node --test tests/app-core.test.mjs` and confirm failure for missing behavior.
- [ ] Add the smallest dependency-free implementation in `app-core.mjs` and rerun until green.

### Task 2: Integrate safe data handling and UI fixes

**Files:**
- Modify: `index.html`
- Modify: `tests/app-core.test.mjs`

- [ ] Import the tested core helpers and replace direct startup `JSON.parse` calls.
- [ ] Validate the wizard before mutating state or writing Firestore.
- [ ] Make JSON restore atomic and reject malformed records.
- [ ] Render full history through DOM nodes and event listeners instead of inline JavaScript.
- [ ] Use local calendar values in the history editor.
- [ ] Replace CSV string interpolation with the tested exporter.
- [ ] Add an empty-history benchmark state.
- [ ] Apply the tested completed-period badge eligibility.
- [ ] Replace hard-coded Czech authentication titles with translation keys.
- [ ] Add structural regression assertions where a pure behavior test cannot cover the integration seam.

### Task 3: Repair cloud synchronization

**Files:**
- Modify: `index.html`
- Modify: `app-core.mjs`
- Modify: `tests/app-core.test.mjs`

- [ ] Add and test history-owner classification for guest, current UID, and another UID.
- [ ] Fetch remote history before attaching the realtime listener.
- [ ] Merge and upload guest-only entries, with remote records winning same-ID conflicts.
- [ ] Treat remote snapshots, including empty snapshots, as authoritative after initialization.
- [ ] Unsubscribe when authentication state changes.
- [ ] Clear account-owned local history/custom pouches on normal logout without deleting cloud data.
- [ ] Await cloud writes and surface failures.

### Task 4: Implement account deletion through TDD

**Files:**
- Create: `functions/delete-account.js`
- Create: `functions/delete-account.test.js`
- Modify: `functions/index.js`
- Modify: `functions/package.json`
- Modify: `index.html`

- [ ] Write failing handler tests for missing auth, stale auth, recursive user-data removal, auth deletion ordering, retry after `auth/user-not-found`, and backend failure.
- [ ] Implement the dependency-injected handler without importing Firebase in the pure module.
- [ ] Wrap it in a v2 `deleteAccount` callable with authenticated error mapping and the existing allowed origins.
- [ ] Add the localized deletion dialog, exact e-mail confirmation, Google/password reauthentication, loading/error states, and callable invocation.
- [ ] Clear `nt_` keys only after a successful server response.
- [ ] Run only fake-adapter tests; do not deploy or invoke the callable against the real project.

### Task 5: Make PWA asset refresh resilient

**Files:**
- Modify: `sw.js`
- Modify: `tests/app-core.test.mjs` or create `tests/service-worker.test.mjs`

- [ ] Write structural tests for network-first app data and cached offline fallback.
- [ ] Version the cache and add `app-core.mjs` to the shell.
- [ ] Use network-first for documents and mutable first-party data.
- [ ] Use stale-while-revalidate for remaining GET assets.
- [ ] Verify an offline reload from a local server without altering production state.

### Task 6: Run proportional regression and local browser QA

**Files:**
- Modify only files required by failures found in the affected paths.

- [ ] Run `node --test tests/*.test.mjs scripts/pouch-audit/*.test.mjs`.
- [ ] Run `(Set-Location functions; node --test contact.test.js delete-account.test.js)`.
- [ ] Run syntax checks for all changed JavaScript and `git diff --check` on scoped files.
- [ ] Start a hidden local HTTP server with a retained PID and verify HTTP 200.
- [ ] Exercise onboarding validation, malicious-backup rejection, history editing, CSV/JSON export, empty statistics, Czech auth copy, account-deletion dialog without submission, and offline PWA.
- [ ] Inspect browser console and responsive layouts at 390 px and 320 px.
- [ ] Stop the exact server PID and confirm its listener is gone.
- [ ] Review the scoped diff without staging or changing unrelated user files.

### Task 7: Final safety and documentation check

**Files:**
- Modify: `docs/qa/2026-08-14-pouchlog-qa-report.md` only if status annotations materially help handoff.

- [ ] Confirm no deployment command, production callable, real sign-in, or account/data deletion was executed.
- [ ] Confirm all 11 QA IDs map to an implemented change and a verification result.
- [ ] Report any limitation that remains because destructive production verification was intentionally excluded.
