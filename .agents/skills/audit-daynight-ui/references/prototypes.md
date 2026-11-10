# Interactive Prototypes for UI Findings

A UI finding that changes layout or presentation carries a frontend-only
interactive prototype, as `using-daynight` requires for frontend delivery. The
prototype lets the implementer and reviewer operate the proposed behavior; it does
not prove the product's behavior.

## Build a reviewable prototype

- Use one self-contained HTML file with representative final styling and actual
  controls, taking colors, type scale and component styles from the current UI.
- Put an inspection bar outside the product area to switch the version (current
  and proposal), state, size, content length, input mode and locale. Keep it
  visually distinct from the product.
- Keep mock data and interaction state only in page memory: no `localStorage`,
  `sessionStorage`, cookies, IndexedDB, Cache Storage or dependencies that use
  them. Reopening the file restores its initial state.
- Include the applicable populated, empty, loading, failure, disabled,
  long-content and narrow states.

## Match product geometry

A breakpoint applies to one specific box. Measure the product's container chain
at each audited viewport — for example the Session container, the composer's
padding and the footer's inner width — and reproduce that nesting in the
prototype: size the simulated container with the measured outer width and keep
the product's inner padding. In the task, state each threshold together with the
box it applies to and the measured values at the audited viewports. A threshold
quoted for the wrong box sends the implementer to the wrong breakpoint. Container
queries on the sized element let one page reproduce several widths.

## Review before packaging

Render each declared size, state and locale and inspect the screenshots. Operate
every control with pointer, keyboard and touch emulation, and check the Tab path
and Escape. Confirm that the current version reproduces the observed failure and
that the proposal resolves it without new overlap or overflow.

Run the checker from a caller-owned Playwright page. Resolve Playwright from the
web package of the Daynight checkout, use an isolated headless browser, and close
the browser afterwards:

```js
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.join(checkout, 'packages/daynight-web/package.json'));
const { chromium } = require('@playwright/test');
const { checkPrototype, storageProbeScript } = await import(pathToFileURL(path.join(
  checkout, '.agents/skills/audit-daynight-ui/scripts/check-prototype.mjs')));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript({ content: storageProbeScript });
  const page = await context.newPage();
  await page.goto(pathToFileURL(prototypeFile).href);
  const report = await checkPrototype(page, { area: '#device', controls: '.proto-bar select' });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
```

The checker visits every option of every inspection control and clicks a bounded
number of visible, enabled actions inside the product area in each resulting
state. It reports elements, or text painted past their boxes, that extend
horizontally beyond the product area without a clipping or scrolling container.
It also reports visible focusable elements that Tab never reaches, storage access
during any visited state or action, page errors and dialogs. `ok: true` means only that these checks passed; it does not judge the
design. Pass other selectors when a prototype uses a different structure.

When an attachment preview embeds the prototype in a sandboxed iframe, confirm
that the sandbox permits the behavior the prototype needs. A blocked form is not
evidence about the product.

## Deliver and remove

Upload the prototype as an attachment of its owning task. Never commit prototypes,
mock pages, their assets or tests that target them. Delete local copies after the
upload has been read back and verified.
