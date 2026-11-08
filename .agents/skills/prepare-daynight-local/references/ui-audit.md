# Discover and Assess UI Experience Problems

Use an authorized localhost audit to find problems in real user paths and turn
confirmed improvements into independent work. Apply the selected revision's
[UI principles](../../../../docs/ui-design.md) and product specifications first.
[WCAG 2.2](https://www.w3.org/TR/WCAG22/) supplies accessibility criteria;
[Nielsen's heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
help examine feedback, control, consistency and error prevention. Use these to
explain a concrete user impact, not to generate a generic design score or claim
full accessibility conformance.

Prepare only the necessary [local fixtures](ui-fixtures.md), collect
[browser evidence](browser-evidence.md), then follow
[independent task handoff](ui-handoff.md) for improvements whose production
registration is authorized. Environment preparation alone does not authorize
production writes or automatic execution.

## Start with a user goal

Choose representative paths that answer actual questions: find a pending task,
understand why it cannot run, inspect a Worker's capacity, continue an assistant
conversation, or read a completed task's result. Include the actions before and
after a suspicious component; an isolated screenshot can miss a navigation or
state-preservation failure.

Work through this cycle:

1. Observe the ordinary path and establish its expected outcome.
2. Vary content, available space, state or input in ways that real use permits.
3. Record a candidate with the affected action and a minimal reproduction.
4. Reproduce it with actual input and consistent visual, geometry or readback
   evidence. Inspect the relevant source before claiming a cause.
5. Classify it as an improvement, expected behavior, environment failure or
   duplicate. Keep an unconfirmed candidate distinct from a finding.
6. Prepare one independent task for each confirmed improvement, then verify the
   delivered implementation against the original reproduction when available.

Use a small audit table in the worktree's ignored `.tmp/`. It describes test
coverage; it is not an environment-management task or a new production task.
Add rows as exploration finds another meaningful path, not for every mouse click.

| User goal and route | Fixture/state | Size, locale, input | Interventions | Evidence | Judgment or gap |
| --- | --- | --- | --- | --- | --- |
| Identify the selected assistant and write a message | Long name, ready conversation | 320 and 390 CSS px, English, pointer | Open/close details; switch away and back | Header/composer geometry and same-state capture | Can identify name, status and action; draft retained? |
| Inspect task details and return to the list | Task with dependencies and long content | 768 CSS px, Chinese, keyboard | Open detail, move across tabs, return | Focus order, actual content width and navigation | Is retained navigation consuming the useful workspace? |
| Choose or dismiss a composer command | Real supported command menu | Desktop and narrow view, keyboard | Arrow keys, Tab, Shift+Tab, Escape | Draft, menu and selected setting before/after | Does leaving the control unexpectedly execute a command? |
| Read a result without losing the task context | Owned Markdown/HTML attachment | Narrow and desktop, pointer | Preview, scroll, close and return | Preview bounds, hit targets and route | Is content reachable and the exit usable? |

## Vary the dimensions that expose failures

Cover applicable cells, and explicitly record skipped or unavailable ones.
Typical widths are 320 and 390 CSS pixels for narrow layouts, 768 for intermediate
layouts, and 1280 or 1360 for desktop. Record height, zoom, scale and orientation;
probe on both sides of a relevant breakpoint when a failure changes there.
These widths are a starting set, not proof of every device layout.

| Dimension | Useful variations |
| --- | --- |
| Content | Chinese and English; short and long names; unbroken paths or IDs; lengthy messages; zero, one and several rows; attachments |
| State | Loading, empty, ready, working, idle, action required, error, pending mutation, completed and read-only history when supported |
| Composition | Sidebar/list/detail together; dialog; open command menu; expanded content; Session fullscreen; switch away and back |
| Input | Ordinary pointer, keyboard, and touch-capable emulation; actual mobile browser for soft-keyboard and viewport claims |
| Recovery | Dismiss without applying, retry after a known failure, return to the original route, retain an unsent draft |

Do not create a cross-product of every cell. Select combinations that challenge
the user goal, expand around a discovered failure, and state the coverage limit.
Do not induce a shared service outage or alter an unrelated Worker merely to
fill an error-state row. Label intercepted responses or mocked states as such;
they cannot establish that the real backend produced the state.

## Judge usable space and reachable actions

Assess whether users can read, understand, act and recover. Common measurements
and their interpretation include:

- Compare the content's usable width with its fixed actions and neighboring
  panels. A 768-pixel viewport can leave less room for chat than a 390-pixel
  single-panel layout. Breakpoints must respond to the remaining workspace.
- Inspect wrapping, truncation, title height and the first useful content below
  it. A heading split into individual letters may have no horizontal overflow.
  `scrollWidth <= clientWidth` does not establish a usable layout.
- Check whether a fixed menu or expanded command output covers the composer,
  its close action or the focused control. Verify actual hit targets as well as
  rectangles. A nested scroller is acceptable when content and its exit remain
  reachable; its existence alone is not a defect.
- Exercise focus order, visible focus, Tab/Shift+Tab, Escape and return to the
  previous control. Leaving a command menu must not silently apply a setting,
  clear a draft or submit a message unless that is the specified interaction.
- Check target size and spacing together. WCAG's
  [target-size criterion](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
  has exceptions; an icon smaller than 24 CSS pixels is not by itself a failure.
  [Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) likewise allows
  content that genuinely requires a two-dimensional layout.
- Keep business state, field labels and actual errors readable. Do not repair
  crowding by hiding the assistant name, task state or only available action.
  Follow the repository's page-level language-selector rule and make hover
  explanations available from keyboard focus.

For state problems, compare the UI with the same resource's CLI readback. A
waiting task without a Session has no active Session failure to display. A saved
Worker configuration and an applied configuration are different observations;
a Bot's closed chat is not a stopped Bot. Use
[the website guide](website.md) for these distinctions.

## Promote evidence, not suspicion

For each candidate, retain the smallest reproduction, source/build identity,
route, locale, viewport, fixture state, actual and expected outcomes, affected
user action, capture method and untested limits. Follow
[browser evidence](browser-evidence.md) for semantic readiness and a consistent
capture. Loading-state measurements and a later ready-state image cannot be
combined into proof of one layout.

Separate what was observed from the source-level explanation. An unexpected
layout is reproducible before its CSS cause is known; name that uncertainty
instead of presenting an inferred cause as established. Compare the relevant
test and document owners before prescribing implementation.

Use impact to order confirmed work:

| Observation | Treatment |
| --- | --- |
| Routine input causes an unintended action, loses work or makes an essential action unreachable | Prioritize the independent defect and verify preservation/recovery behavior |
| Common content or supported size makes a name unreadable, crowds controls or forces avoidable navigation | Prepare a bounded usability improvement with measurable acceptance |
| A deliberate product state or documented interaction works as specified | Record the reason for exclusion; propose a behavior change only within the user's scope |
| Browser/automation failure also occurs on a blank page | Diagnose the environment and report that UI layer unverified; do not assign a product rendering defect |
| The same user-visible defect already has an owner | Reuse its material where authorized; do not open another task for a new width or screenshot alone |
| Preference without a specific user cost, or a source-only suspicion | Retain as a candidate or exclude it; do not manufacture a repair task |

The browser reference describes bounded blank-page checks and screen-media PDF
fallbacks. PDF/DOM evidence can support static layout or interaction findings
when clearly identified. It does not prove compositor rendering, animation,
native Provider behavior or a real phone's soft-keyboard handling.

## Improve the method after each audit

Record paths exercised, findings, excluded candidates and untested layers. For an
exclusion, save the reason that changed the judgment: expected state, duplicate,
stale artifact, incomplete capture or platform failure. These distinctions make
later audits more accurate; a finding count is not an effectiveness measure.

When a fix is delivered and retesting is in scope, identify the new fixed source
and running build, replay the original failure, then check its adjacent states.
Compare equivalent captures. A task marked done, a passing unit test or an old
prototype cannot replace this product check.

Keep concrete task evidence in the owning task's attachments. Improve this skill
with reusable decisions, reliable fixture recipes and verified failure
diagnostics; do not accumulate private IDs, process logs or audit chronology.
Script repeated, error-prone mechanics such as capture validation and artifact
checks. Keep judgment about user impact, scope and expected behavior explicit.
