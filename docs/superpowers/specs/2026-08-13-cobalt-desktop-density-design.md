# PouchLog Cobalt Desktop Density Polish

## Goal

Refine the approved Cobalt Utility redesign so the desktop interface feels sleek and deliberately dense rather than visually enlarged. Keep the 1120 px content shell, all product behavior, the mobile information architecture, and the existing accessibility guarantees.

The pass also restores the original brand line `Know your numbers` and adds a small Google provider cue to the header because Google sign-in is already available in the existing authentication dialog.

## Visual direction

Use a selective 90–92% desktop density adjustment instead of CSS `zoom`, transforms, or a narrower dashboard. Preserve the existing flat navy/cobalt system, hairline borders, Public Sans/IBM Plex Mono pairing, and 44 px minimum interactive targets.

The restored tagline sits below the wordmark as a restrained technical micro-caption:

- exact text: `Know your numbers`
- IBM Plex Mono, 10 px, uppercase, medium weight
- muted text color and a short cobalt hairline marker
- 9 px on narrow mobile screens
- treated as stable English brand copy rather than localized interface text

The logged-out header Login action receives an inline 14 px Google `G` provider badge. The icon is decorative and `aria-hidden`; the localized Login label remains the accessible name and the button continues opening the existing authentication dialog. It does not become a direct Google OAuth trigger. The cue is hidden when a user is signed in.

## Desktop density changes

For viewports at least 1024 px wide:

- Reduce the header from 70 px to about 64 px and the wordmark from 30–34 px to 28–31 px.
- Reduce the PlanRail from 96 px to about 88 px, with 16×20 px padding, a smaller icon, 22 px data values, and an 8 px progress track.
- Reduce KPI cells from 120 px to about 108 px, with 16×20 px padding and 34–42 px metric values. Units become 12 px.
- Use 14 px vertical gaps between major modules.
- Reduce logging controls from 72 px to 64 px, section padding to 10×20 px, grid gaps to 12 px, CTA text to 14 px, and quick choices to approximately 52 px high.
- Tighten analytics padding, chart gutters, titles, and benchmark spacing while preserving the exact stable `.chart-container` height of 200 px.
- Tighten lower-module padding and achievement rows without removing content.
- Keep all desktop buttons and other interactive elements at least 44×44 px.

The target is for the lower grid to begin around y=875–900 at 1536×1024, compared with about y=949 before this pass.

## Tablet and mobile

Tablet receives the same typographic and spacing logic at a milder level. Mobile remains primarily unchanged to protect readability and touch ergonomics, with only small adjustments to header/tagline fit and obviously oversized module padding. Mobile charts remain 220 px high, controls retain 44 px minimum targets, long product names remain flexible, and the 320 px no-overflow guarantee remains.

## Implementation boundaries

Changes are presentational and remain in `index.html`:

- CSS density overrides and responsive refinements
- restored tagline visibility
- inline Google SVG within the existing `syncBtn`
- minimal presentation logic so translations and auth-state updates preserve the icon when logged out and omit it when logged in

Do not change Firebase configuration, providers, auth behavior, Firestore paths, state, calculations, localStorage keys, charts, CRUD, translations unrelated to the header, PWA files, or dependencies.

## State and data flow

No application data flow changes. The existing auth observer continues to determine whether `syncBtn` represents Login or signed-in state. A small rendering helper may update the button content from the existing `state.user` and current language; it must not initiate authentication or modify user state.

## Accessibility and failure behavior

- Keep the Login button's localized accessible name and its 44 px target.
- Mark the Google SVG decorative with `aria-hidden="true"` and `focusable="false"`.
- Preserve visible focus styles and dark/light WCAG AA contrast.
- If SVG styling fails, the visible Login text remains sufficient and the auth dialog remains unchanged.
- Do not use global scaling, fixed selector heights, or clipping that could hide long names.

## Verification

Use a test-first contract that initially fails on the hidden tagline, absent Google badge, and current desktop dimensions. After implementation, verify:

- the tagline is visible and fits at 1536, 1440, 1024, 390, and 320 px
- the logged-out Login action contains the Google cue while retaining its label and dialog behavior
- signed-in presentation does not show the provider cue
- desktop geometry meets the density targets without horizontal overflow or overlap
- all visible interactive targets remain at least 44 px
- mobile layout, dialogs, long names, theme switching, translations, and Chart.js dimensions remain stable
- same-fixture before/after screenshots at 1536×1024 and 1440×900 demonstrate the density improvement
- static syntax, regression guards, forbidden-style scans, and browser console checks pass

## Delivery

Implement on `codex/cobalt-density-polish` as a focused follow-up commit. Keep comparison screenshots outside the repository. Do not merge or deploy unless separately requested.
