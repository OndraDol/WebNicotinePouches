# Goal: Complete Pouch audit v3.1

Implement and complete the approved Pouch audit v3.1 in this workspace.

Approved sources:

- Design: `C:\Users\ondrej.dolejs\Documents\ChatGPT\Pouchlog\docs\superpowers\specs\2026-08-14-pouch-audit-v3-1-design.md`
- Plan: `C:\Users\ondrej.dolejs\Documents\ChatGPT\Pouchlog\docs\superpowers\plans\2026-08-14-pouch-audit-v3-1.md`

The user explicitly authorizes an exact five-row pilot for 77 Pouches, continuation to all 861 input IDs after the pilot gates pass, safe application of only directly verified row corrections to `data.js`, commit of the approved scope, and a fast-forward push to `origin/main` without force-push.

Required constraints:

- Use TDD: every production correction is preceded by a negative test and observed RED, then minimal GREEN and the complete regression suite.
- Keep the run isolated and append-only in `audit/pouches/recheck-v3.1`; do not overwrite the current v3 raw log.
- Freeze exactly 861 unique IDs against the initial `data.js`; preserve v2 and v3 artifacts byte-for-byte and verify their SHA-256 hashes after completion.
- Derive brand, variant, strength semantics, mg/pouch, source class, owner group, independence, and final state independently in the validator; never use frozen-card facts as product evidence.
- Treat search snippets as non-evidence, Haypp/Northerner as one branch, and allow mg/g conversion only from weight and pouch count in the same product block.
- Process in batches of at most 25. Each checkpoint requires a fresh validator, QA, zero pending, and zero unreviewed candidates without weakening evidence thresholds.
- Produce snapshot, raw log, derived results, independent QA, complete report, manifest, deterministic gzip archives, and summary.
- Require a global gate of 861 results, QA 861/861, pending 0, unreviewed 0, valid raw hash chain, and matching artifact hashes.
- Run safe apply twice; the second run must be a no-op. Stage only the explicit audit allowlist, inspect the full staged diff, fetch before push, rebase only if `origin/main` advanced, and push fast-forward only.
