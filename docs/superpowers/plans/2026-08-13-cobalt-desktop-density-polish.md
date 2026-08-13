# Cobalt Desktop Density Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Cobalt Utility desktop interface feel approximately 90–92% as large, restore `Know your numbers`, and show that Google sign-in is available without changing authentication behavior.

**Architecture:** Keep the existing monolithic `index.html` and add narrowly scoped CSS overrides plus one presentation-only `renderSyncButton()` helper. Store all automated contracts and screenshots under `%TEMP%\pouchlog-cobalt-utility-qa`; no test artifact enters the repository.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, Firebase Auth 10.12.2 (unchanged), Python 3 + Playwright 1.60 with installed Chrome, PowerShell, Git.

---

## File map

- Modify: `index.html` — tagline visibility, Google provider cue, compact desktop/tablet styling, auth-button presentation helper.
- Create temporarily: `%TEMP%\pouchlog-cobalt-utility-qa\density_contract.py` — static RED/GREEN contract.
- Create temporarily: `%TEMP%\pouchlog-cobalt-utility-qa\density_browser_qa.py` — responsive geometry, interaction, and screenshot comparison.
- Preserve: `data.js`, `manifest.json`, `sw.js`, `privacy.html`, Firebase files, binary assets, and all storage/data logic.

### Task 1: Establish static RED contracts

**Files:**
- Create: `%TEMP%\pouchlog-cobalt-utility-qa\density_contract.py`
- Read: `index.html`

- [ ] **Step 1: Write the failing contract**

Create the temporary script with these assertions:

```python
from pathlib import Path
import argparse
import re

ROOT = Path(r"C:\Users\ondrej.dolejs\Documents\ChatGPT\Pouchlog")
html = (ROOT / "index.html").read_text(encoding="utf-8")

groups = {
    "header": {
        "tagline visible": bool(re.search(r"\.logo-tagline\s*\{[^}]*display:\s*flex", html, re.S)),
        "tagline hairline": ".logo-tagline::before" in html,
        "google cue markup": 'class="google-provider-icon"' in html,
        "decorative provider icon": 'class="google-provider-icon" aria-hidden="true" focusable="false"' in html,
        "auth presentation helper": "function renderSyncButton()" in html,
        "auth observer uses helper": html.count("renderSyncButton();") >= 2,
    },
    "density": {
        "desktop header 64": bool(re.search(r"@media \(min-width: 1024px\)[\s\S]*?\.header-inner\s*\{[^}]*min-height:\s*64px", html)),
        "desktop plan rail 88": bool(re.search(r"@media \(min-width: 1024px\)[\s\S]*?\.plan-rail\s*\{[^}]*min-height:\s*88px", html)),
        "desktop KPI 108": bool(re.search(r"@media \(min-width: 1024px\)[\s\S]*?\.kpi-strip \.stat\s*\{[^}]*min-height:\s*108px", html)),
        "desktop logging controls 64": bool(re.search(r"@media \(min-width: 1024px\)[\s\S]*?\.log-pouch-button\s*\{[^}]*min-height:\s*64px", html)),
        "stable desktop chart": bool(re.search(r"\.chart-container\s*\{[^}]*position:\s*relative;[^}]*width:\s*100%;[^}]*height:\s*200px", html, re.S)),
        "stable mobile chart": bool(re.search(r"@media \(max-width: 767px\)[\s\S]*?\.chart-container\s*\{\s*height:\s*220px", html)),
        "no CSS zoom": not re.search(r"(?:^|[;{])\s*zoom\s*:", html),
        "no scale workaround": "transform: scale(" not in html,
    },
}

parser = argparse.ArgumentParser()
parser.add_argument("--group", choices=["header", "density", "all"], default="all")
args = parser.parse_args()
selected = groups if args.group == "all" else {args.group: groups[args.group]}
failures = []
for group, checks in selected.items():
    for name, passed in checks.items():
        print(("PASS" if passed else "FAIL"), f"{group}: {name}")
        if not passed:
            failures.append(f"{group}: {name}")
raise SystemExit(1 if failures else 0)
```

- [ ] **Step 2: Run both groups and verify RED**

Run:

```powershell
$qaDir = Join-Path $env:TEMP 'pouchlog-cobalt-utility-qa'
python -X utf8 "$qaDir\density_contract.py" --group header
python -X utf8 "$qaDir\density_contract.py" --group density
```

Expected: both commands exit 1. Header reports hidden tagline/missing Google markup/helper; density reports current 70/96/120/72 px values. Stable chart and no-scale checks already pass.

- [ ] **Step 3: Capture the unchanged desktop baseline**

Start the static server and use the existing deterministic `qa_suite` fixture to save the pre-implementation state as:

```text
%TEMP%\pouchlog-cobalt-utility-qa\density-before-1536x1024.png
%TEMP%\pouchlog-cobalt-utility-qa\density-before-1440x900.png
```

Expected geometry at 1536×1024 is approximately a 71 px header, 96 px PlanRail, 148 px KPI strip, 72 px selector/CTA, and lower grid beginning near y=949.

### Task 2: Restore the brand line and Google provider cue

**Files:**
- Modify: `index.html:882-923`
- Modify: `index.html:1474-1485`
- Modify: `index.html:2123-2154`
- Modify: `index.html:3053-3094`
- Test: `%TEMP%\pouchlog-cobalt-utility-qa\density_contract.py --group header`

- [ ] **Step 1: Add compact header styles**

Replace the hidden tagline override and extend the Login styles with:

```css
.logo-tagline {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 3px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    line-height: 1.2;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
}
.logo-tagline::before { content: ""; width: 12px; height: 1px; background: var(--accent); }
.header-login { gap: 7px; }
.google-provider-icon { width: 14px; height: 14px; flex: 0 0 auto; }
```

- [ ] **Step 2: Add the inline provider SVG without changing the listener**

Change only the contents/translation attributes of `syncBtn`:

```html
<button id="syncBtn" class="btn btn-plain header-login" data-i18n-aria-label="auth_btn" aria-label="Login">
    <svg class="google-provider-icon" aria-hidden="true" focusable="false" viewBox="0 0 18 18">
        <path fill="#4285f4" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.797 2.715v2.258h2.909c1.702-1.567 2.684-3.874 2.684-6.613Z"/>
        <path fill="#34a853" d="M9 18c2.43 0 4.467-.806 5.956-2.182l-2.909-2.258c-.806.54-1.836.859-3.047.859-2.344 0-4.328-1.584-5.037-3.711H.957v2.332A9 9 0 0 0 9 18Z"/>
        <path fill="#fbbc05" d="M3.963 10.708A5.416 5.416 0 0 1 3.682 9c0-.593.102-1.169.281-1.708V4.96H.957A9 9 0 0 0 0 9c0 1.45.347 2.824.957 4.04l3.006-2.332Z"/>
        <path fill="#ea4335" d="M9 3.58c1.322 0 2.508.454 3.441 1.346l2.581-2.581C13.463.892 11.426 0 9 0A9 9 0 0 0 .957 4.96l3.006 2.332C4.672 5.165 6.656 3.58 9 3.58Z"/>
    </svg>
    <span class="header-login-label">Login</span>
</button>
```

- [ ] **Step 3: Centralize presentation-only auth button rendering**

Add immediately before `applyLanguage()`:

```javascript
function renderSyncButton() {
    const syncBtn = document.getElementById('syncBtn');
    if (!syncBtn) return;
    const label = syncBtn.querySelector('.header-login-label');
    const providerIcon = syncBtn.querySelector('.google-provider-icon');
    const signedIn = Boolean(state.user);
    if (label) label.textContent = signedIn ? '~' : t('auth_btn');
    if (providerIcon) providerIcon.classList.toggle('hidden', signedIn);
    syncBtn.setAttribute('aria-label', signedIn ? t('auth_title') : t('auth_btn'));
}
```

In `applyLanguage()`, replace the `syncBtn.innerText` block with `renderSyncButton();`. In `onAuthStateChanged`, remove both direct `syncBtn.innerText` assignments and call `renderSyncButton();` once after `state.user` is set or cleared. Do not alter the `syncBtn` click listener or Google auth listener.

- [ ] **Step 4: Verify header GREEN**

Run:

```powershell
python -X utf8 "$qaDir\density_contract.py" --group header
```

Expected: all header checks pass and exit 0.

### Task 3: Apply the desktop-first density scale

**Files:**
- Modify: `index.html:882-1209`
- Modify: `index.html:1341-1458`
- Test: `%TEMP%\pouchlog-cobalt-utility-qa\density_contract.py --group density`

- [ ] **Step 1: Tighten desktop presentation values**

Place these exact overrides inside the existing `@media (min-width: 1024px)` block so mobile keeps its touch-oriented scale. Retain 44 px global targets and chart heights:

```css
@media (min-width: 1024px) {
    .header-inner { min-height: 64px; gap: 14px; }
    .logo-row { font-size: clamp(28px, 2.6vw, 31px); }
    .header-actions { gap: 6px; }
    .section-title { font-size: 17px; line-height: 1.25; }
    .plan-rail { min-height: 88px; padding: 16px 20px; gap: 20px; }
    .plan-icon { width: 38px; height: 38px; }
    .plan-identity { gap: 12px; }
    .plan-name { font-size: 17px; }
    .plan-target, .plan-limit { padding-left: 20px; }
    .plan-target-value, .plan-limit-value { font-size: 22px; }
    .plan-progress-copy { gap: 8px; margin-bottom: 6px; }
    .progress-bar { height: 8px; }
    .kpi-strip .stat { min-height: 108px; padding: 16px 20px; }
    .stat .val { margin-top: 7px; font-size: clamp(34px, 3.6vw, 42px); }
    .stat .val .metric-unit { font-size: 12px; }
    .stat .sub { margin-top: 3px; line-height: 1.3; }
    .logging-band, .analytics-band, .lower-grid { margin-top: 14px; }
    .logging-band { padding: 10px 20px; }
    .logging-grid { gap: 12px; margin-top: 8px; }
    .selector-btn { min-height: 64px; padding: 10px 14px; }
    .selected-pouch-name { font-size: 15px; line-height: 1.25; }
    .selected-pouch-name .pouch-mg { font-size: 11px; line-height: 1.3; }
    .log-pouch-button { min-height: 64px; font-size: 14px; }
    .quick-choice { min-height: 52px; padding: 8px 10px; }
    .analytics-band { padding: 14px 20px; }
    .analytics-grid { margin-top: 8px; }
    .chart-module { padding-right: 20px; }
    .chart-module + .chart-module { padding-left: 20px; }
    .chart-title { margin-bottom: 6px; }
    .benchmark-card { margin-top: 10px; padding-top: 8px; }
    .lower-module { padding: 16px 18px; }
    .lower-module > summary { line-height: 1.3; }
    .achievement { min-height: 90px; }
    footer { margin-top: 24px; padding: 12px; }
}
```

- [ ] **Step 2: Keep mobile touch-safe and adjust only header fit**

Inside `@media (max-width: 767px)`, retain current module/control dimensions and add:

```css
.header-inner { min-height: 60px; }
.logo-row { font-size: clamp(24px, 7vw, 26px); }
.logo-tagline { font-size: 9px; letter-spacing: 0.06em; }
```

Do not change `.chart-container { height: 220px; }` or any 44 px minimum target.

- [ ] **Step 3: Verify density GREEN and full static contract**

Run:

```powershell
python -X utf8 "$qaDir\density_contract.py" --group density
python -X utf8 "$qaDir\density_contract.py" --group all
```

Expected: all checks pass and both commands exit 0.

### Task 4: Browser geometry and interaction verification

**Files:**
- Create temporarily: `%TEMP%\pouchlog-cobalt-utility-qa\density_browser_qa.py`
- Read: `%TEMP%\pouchlog-cobalt-utility-qa\qa_suite.py`
- Test: `index.html`

- [ ] **Step 1: Write the browser contract**

Use Python Playwright with installed Chrome and `qa_suite.create_context()`. For 1536×1024 and 1440×900, assert:

```python
assert metrics["headerHeight"] <= 65
assert 84 <= metrics["planHeight"] <= 90
assert metrics["kpiHeight"] <= 112
assert metrics["selectorHeight"] <= 66
assert metrics["ctaHeight"] <= 66
assert metrics["lowerTop"] <= 910
assert metrics["scrollWidth"] <= metrics["clientWidth"] + 1
assert metrics["taglineVisible"] is True
assert metrics["googleIconVisible"] is True
assert metrics["minVisibleTarget"] >= 44
```

Click `#syncBtn` and assert `#authModal[open]`; do not submit auth. Switch EN/CS and light/dark, then reassert the visible provider cue and clean console. At 390×844 and 320×568, assert no horizontal overflow, tagline fit, 44 px targets, and `.chart-container` height 220 px.

- [ ] **Step 2: Run browser QA and capture after screenshots**

Save:

```text
%TEMP%\pouchlog-cobalt-utility-qa\density-after-1536x1024.png
%TEMP%\pouchlog-cobalt-utility-qa\density-after-1440x900.png
%TEMP%\pouchlog-cobalt-utility-qa\density-after-390x844.png
```

Expected: all geometry, interaction, overflow, target, theme, language, and console assertions pass.

- [ ] **Step 3: Inspect before/after images at original resolution**

Open all four desktop images with `view_image(original)`. Confirm the new desktop retains the same hierarchy, has visibly smaller buttons/metrics/padding, keeps both charts readable, and exposes more of the lower grid without appearing cramped.

### Task 5: Regression verification and focused commit

**Files:**
- Modify: `index.html`
- Preserve: all other production files

- [ ] **Step 1: Run syntax and protected-logic checks**

```powershell
git diff --check
$html = Get-Content -LiteralPath index.html -Raw
$module = [regex]::Match($html, '<script type="module">(?<code>.*?)</script>', [Text.RegularExpressions.RegexOptions]::Singleline)
$module.Groups['code'].Value | node --check --input-type=module -
node --check sw.js
python -m json.tool manifest.json > $null
python -X utf8 "$qaDir\regression_guard.py"
python -X utf8 "$qaDir\index_contract.py"
```

Expected: exit 0 for every command.

- [ ] **Step 2: Confirm scope and forbidden styles**

```powershell
git diff --name-only HEAD
rg -n 'linear-gradient|radial-gradient|backdrop-filter|transition:\s*all|outline\s*:\s*(none|0)|zoom\s*:|transform:\s*scale\(' index.html
```

Expected: only `index.html` differs from the design/plan commits; forbidden-style scan returns no active match.

- [ ] **Step 3: Stage only the production file and inspect it**

```powershell
git add -- index.html
git diff --cached --check
git diff --cached -- index.html
```

Expected: staged diff contains only the approved tagline, provider cue/presentation helper, and density changes.

- [ ] **Step 4: Commit the implementation**

```powershell
git commit -m "style: refine cobalt desktop density"
```

- [ ] **Step 5: Final branch check**

```powershell
git status --porcelain=v1 --untracked-files=all
git log --oneline --reverse origin/main..HEAD
```

Expected: clean worktree with the documentation commits followed by the focused style commit. Do not push, merge, or deploy without a separate request.
