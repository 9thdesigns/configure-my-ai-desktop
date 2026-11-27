# t499u D1: CFA avatars in the desktop widget (screenshots only, never merged)

These were rendered in Playwright Chromium from the real `src/widget.html` and `src/island.html` (strict CSP unchanged), with a stub feed passed through the real main-process code (`widgetStateFrom`, `widgetView`, `islandView`).

The CFA markup and stylesheet in these shots are **stand-ins** (in `stub-cfa.js`) written to the t499u contract shape. The real markup and CSS arrive from `GET /desktop/widget.json` once the web side ships.

- `widget-chat-*`: the dock plus the quick-chat popover (Ada).
- `widget-picker-*`: the dock plus the seats picker.
- `island-pill-*`: the island pill.
- `before-initials` / `after-cfa-idle` / `after-cfa-working`, each in `light` and `dark`.
- `dock-idle-to-working-swap.webm`: idle → working → idle swapped in place without a re-mount.

## Round 2: real partial structure (`*-real-cfa-*`)

These use the **real CFA partial's markup structure** from configure-my-ai #1588 (`gen-fixture.js`; only the ~14KB brand-mark path data is generated), passed through the real sanitiser and renderer. The stylesheet (`cfa-avatar-real.css`) was rebuilt from the real sheet's facts: `@property`, `@keyframes`, a reduced-motion block, and `data:image/svg+xml` masks for the cloud, triangle, samurai and astronaut shapes. The real 56KB sheet was not live in production when these were taken. Samurai is the Manager (top of the dock); cloud is Ada (quick chat).
