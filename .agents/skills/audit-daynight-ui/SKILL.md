---
name: audit-daynight-ui
description: Use when auditing Daynight's user-facing experience — layout, readability, interaction, accessibility, language, or Session View timelines and composers — on desktop and phone widths, usually as the topic skill of an investigation under discover-daynight-improvements.
---

# Audit Daynight UI

Find user-facing experience problems in real Daynight paths and turn each into a
designed, component-level improvement. Follow the
[investigation contract](../discover-daynight-improvements/SKILL.md) for
boundaries, evidence, packages and handoff, and
[prepare-daynight-local](../prepare-daynight-local/SKILL.md) for the environment,
browser identity, controller Test Sessions and the capture helper. Links that
leave the skills directory refer to the Daynight repository; when these skills
are installed outside a checkout, resolve them against the selected source
checkout.

Apply the selected revision's [UI principles](../../../docs/ui-design.md) and
product specifications first. [WCAG 2.2](https://www.w3.org/TR/WCAG22/) supplies
accessibility criteria; [Nielsen's heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
help examine feedback, control, consistency and error prevention. Use them to
explain a concrete user impact, not to produce a generic design score or claim
full conformance.

## Recognize UI findings

A finding has a concrete user cost in a supported path. These count even when
nothing overflows and every control technically works:

| Kind | Examples |
| --- | --- |
| Unintended action, lost work or unreachable essential action | Leaving a menu applies a setting; a pending approval is pushed out of the visible area |
| Unreasonable layout | A primary action alone on its own row while the row above has room; wrapping that leaves half-empty rows on both sides; control rows that consume most of a phone's height; the primary action changing position between states |
| Unreadable or ambiguous content | Names squeezed into narrow columns; truncation that removes an affordance such as a menu caret; raw internal data, such as a JSON dump, shown as the message; repeated boilerplate that hides useful text |
| Wrong or misleading state | A read-only notice while the session waits for an answer; "outcome unknown" during a normal send; a missing interruption or cancellation result; empty-state text that implies hidden content |
| Language and consistency | Text that should follow the page locale but does not, outside the labels a specification keeps in English; one concept named differently by neighboring components |
| Accessibility | Controls unreachable by keyboard, missing accessible names, lost focus, or targets too small or crowded to use |

A deliberate, specified behavior, a preference without user cost and a
browser-platform failure are not UI findings; classify them under
[the investigation method](../discover-daynight-improvements/references/method.md#classify-by-impact).

## Cover phones and states by default

Audit every surface at 320×640, 375×667 and 390×844 with touch emulation, at an
intermediate 768 width and at a 1280–1360 desktop, in Chinese and English, with
pointer, keyboard and touch input where they apply. Cover the states the surface
supports: empty, loading, ready, working, waiting for input, pending mutation,
error, completed and read-only. Record skipped cells.
[Coverage](references/coverage.md) lists dimensions, measurements and content
fixtures; [Session View](references/session-view.md) lists that surface's
components, states and Provider differences.

Viewport emulation does not establish a real phone's soft keyboard,
`visualViewport` behavior or compositor animation. Keep those unverified unless a
suitable device was used.

## Design the improvement

Each layout or presentation finding states a concrete design, not only the defect:

- how elements group, and which group wraps, truncates or yields space first;
- layout regimes by available container width, stated in measured product
  geometry, with a row budget for each regime;
- a stable position for the primary action across states;
- the behavior for each applicable state, long content, locale and input method;
- what must not change: permissions, gating, native action semantics, drafts and
  focus.

Provide an interactive prototype that follows [the prototype standard](references/prototypes.md),
and run its checker before packaging. Frontend delivery requires this prototype
even when the layout is unchanged, for example a focus, keyboard or text change
in a menu, as [task creation](../../../packages/daynight/src/commands/skill/skills/using-daynight/references/create-task.md)
requires. Only a finding whose change lies outside the frontend, such as CLI
output or a backend Provider projection, may show the expected text or output in
`task.md` instead; a raw-data finding of that kind shows the readable form the
data should take.

## Keep tasks at component level

One task covers one component's improvement or one behavior. Split a page-wide
problem by component: a phone Session page becomes separate tasks for the
composer footer, the Session header and the page shell. Different reproductions
of one component behavior, such as several widths or Providers, share one task.
Shared CSS or source files do not create dependencies; describe related tasks in
the description when their results interact.

## Capture UI evidence

Use prepare-daynight-local's [capture helper](../prepare-daynight-local/references/browser-evidence.md)
and its readiness rules. When the problem is that an element is pushed out of the
visible area, use a stable visible element as the readiness condition and observe
the hidden element's geometry. Use geometry-only captures for surfaces that list
personal configuration, such as command catalogs. Record transient states, such as
send receipts or interruption progress, as time series. Screen every artifact
under [the private-data screening](../discover-daynight-improvements/references/evidence.md#screen-private-data-before-upload).
