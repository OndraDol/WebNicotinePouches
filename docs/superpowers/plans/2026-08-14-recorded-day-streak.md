# Recorded-Day Streak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count a streak only across consecutive calendar days with recorded, within-limit pouch use, while allowing an unrecorded current day to preserve yesterday's active streak.

**Architecture:** Add a small pure `calculateRecordedDayStreak` function beside the existing statistics calculation in `index.html`. Keep local-date counting and dynamic-limit ownership in `calculateStats()`, then pass the existing day-count map, current local date, and limit function into the helper. Exercise the exact production function by extracting its marked source block into Node's built-in VM test runner, avoiding new runtime dependencies or app-shell assets.

**Tech Stack:** Browser JavaScript, HTML, Node.js 22 built-in `node:test`, `node:assert`, `node:fs`, and `node:vm`.

---

### Task 1: Replace inactive-day streak counting

**Files:**
- Create: `tests/streak.test.mjs`
- Modify: `index.html:2383-2402`

- [ ] **Step 1: Write the failing regression tests**

Create `tests/streak.test.mjs` with tests that execute the marked production helper from `index.html`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
const indexSource = readFileSync(indexPath, 'utf8');

function loadStreakCalculator() {
  const match = indexSource.match(
    /\/\/ --- RECORDED-DAY STREAK START ---\r?\n([\s\S]*?)\r?\n\s*\/\/ --- RECORDED-DAY STREAK END ---/
  );
  assert.ok(match, 'index.html must contain the recorded-day streak helper');

  const context = {};
  runInNewContext(
    `${match[1]}\nthis.calculateRecordedDayStreak = calculateRecordedDayStreak;`,
    context
  );
  return context.calculateRecordedDayStreak;
}

function localDateKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const today = new Date(2026, 7, 14, 12);
const limitOf = (limits = {}, fallback = 3) => (date) => limits[localDateKey(date)] ?? fallback;

test('old isolated records followed by inactivity produce no streak', () => {
  const calculate = loadStreakCalculator();
  assert.equal(calculate({ '2025-11-28': 1 }, today, limitOf()), 0);
});

test('consecutive recorded days within their limits are counted', () => {
  const calculate = loadStreakCalculator();
  const days = { '2026-08-14': 2, '2026-08-13': 1, '2026-08-12': 3 };
  assert.equal(calculate(days, today, limitOf()), 3);
});

test('a recorded current day is included immediately', () => {
  const calculate = loadStreakCalculator();
  assert.equal(calculate({ '2026-08-14': 1 }, today, limitOf()), 1);
});

test('an unrecorded current day preserves a streak ending yesterday', () => {
  const calculate = loadStreakCalculator();
  const days = { '2026-08-13': 1, '2026-08-12': 2, '2026-08-11': 1 };
  assert.equal(calculate(days, today, limitOf()), 3);
});

test('missing both today and yesterday produces no streak', () => {
  const calculate = loadStreakCalculator();
  assert.equal(calculate({ '2026-08-12': 1 }, today, limitOf()), 0);
});

test('an empty day inside the sequence ends the streak', () => {
  const calculate = loadStreakCalculator();
  const days = { '2026-08-14': 1, '2026-08-13': 1, '2026-08-11': 1 };
  assert.equal(calculate(days, today, limitOf()), 2);
});

test('a recorded day above its dynamic limit ends the streak', () => {
  const calculate = loadStreakCalculator();
  const days = { '2026-08-14': 1, '2026-08-13': 2, '2026-08-12': 1 };
  const limits = { '2026-08-14': 2, '2026-08-13': 1, '2026-08-12': 2 };
  assert.equal(calculate(days, today, limitOf(limits)), 1);
});

test('empty history produces no streak', () => {
  const calculate = loadStreakCalculator();
  assert.equal(calculate({}, today, limitOf()), 0);
});

test('calculateStats delegates streak calculation to the recorded-day helper', () => {
  assert.match(
    indexSource,
    /const streak = calculateRecordedDayStreak\(days, today, getDynamicLimitForDate\);/
  );
});
```

- [ ] **Step 2: Run the focused tests and verify the expected failure**

Run:

```powershell
node --test tests/streak.test.mjs
```

Expected: FAIL because `index.html` does not yet contain the `RECORDED-DAY STREAK` helper block or delegate call. Confirm the failure is caused by the missing behavior, not a syntax or path error.

- [ ] **Step 3: Add the minimal production helper and delegate to it**

Insert this block immediately before `calculateStats()` in `index.html`:

```javascript
        // --- RECORDED-DAY STREAK START ---
        function calculateRecordedDayStreak(days, today, getLimitForDate) {
            const checkDate = new Date(today);
            checkDate.setHours(0, 0, 0, 0);
            const dateKey = (date) => {
                const pad = (value) => String(value).padStart(2, '0');
                return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
            };

            if ((days[dateKey(checkDate)] || 0) === 0) {
                checkDate.setDate(checkDate.getDate() - 1);
            }

            let streak = 0;
            while (true) {
                const recorded = days[dateKey(checkDate)] || 0;
                if (recorded === 0 || recorded > getLimitForDate(new Date(checkDate))) break;
                streak += 1;
                checkDate.setDate(checkDate.getDate() - 1);
            }
            return streak;
        }
        // --- RECORDED-DAY STREAK END ---
```

Inside `calculateStats()`, replace the old loop from `let streak = 0` through its closing `while` brace with:

```javascript
            const streak = calculateRecordedDayStreak(days, today, getDynamicLimitForDate);
```

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```powershell
node --test tests/streak.test.mjs
```

Expected: PASS, 9 tests passed and 0 failed.

- [ ] **Step 5: Run all repository tests and syntax checks**

Run:

```powershell
node --test tests/*.test.mjs scripts/pouch-audit/*.test.mjs
node --check scripts/pouch-audit/run.mjs
git diff --check -- index.html tests/streak.test.mjs
```

Expected: every test passes, both syntax/diff checks exit with code 0, and no errors or warnings are introduced by the changed files.

- [ ] **Step 6: Review the scoped diff and commit the fix**

Run:

```powershell
git diff -- index.html tests/streak.test.mjs
git status --short
git add -- index.html tests/streak.test.mjs
git diff --cached --check
git commit -m "fix: count streak from recorded days"
```

Expected: the diff contains only the pure streak helper, the replacement delegate call, and focused tests. Existing unrelated working-tree changes remain unstaged.
