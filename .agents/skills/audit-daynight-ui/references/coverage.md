# UI Coverage and Measurements

Use these dimensions and measurements with the coverage table from
[the investigation method](../../discover-daynight-improvements/references/method.md#record-coverage).

## Vary the dimensions that expose failures

| Dimension | Useful variations |
| --- | --- |
| Size | 320×640, 375×667 and 390×844 with touch emulation; 768; 1280 or 1360. Record height, zoom, scale and orientation; probe both sides of a breakpoint where a failure changes |
| Content | Chinese and English; short and long names; unbroken paths or IDs; lengthy messages; Markdown, code and tables; zero, one and several rows; attachments |
| State | Loading, empty, ready, working, waiting for input, pending mutation, error, completed and read-only history when supported |
| Composition | Sidebar, list and detail together; dialogs; open menus; expanded content; Session fullscreen; switching away and back |
| Input | Pointer, keyboard and touch-capable emulation; an actual mobile browser for soft-keyboard and viewport claims |
| Recovery | Dismiss without applying, retry after a known failure, return to the original route, retain an unsent draft |

These sizes are a starting set, not proof of every device layout. Example rows:

| User goal and route | Fixture/state | Size, locale, input | Interventions | Evidence | Judgment or gap |
| --- | --- | --- | --- | --- | --- |
| Identify the selected assistant and write a message | Long name, ready conversation | 320 and 390, English, touch | Open/close details; switch away and back | Header and composer geometry; same-state capture | Name, status and action identifiable? Draft retained? |
| Answer a pending approval on a phone | Test Session waiting for an answer | 320×640 and 390×844, Chinese, touch | Scroll the timeline; open Permissions | Timeline visible height; card position; notice text | Card reachable and its content readable? |
| Choose or dismiss a composer command | Real command catalog | Desktop and 390, keyboard | Arrow keys, Tab, Shift+Tab, Escape | Draft, menu and selected setting before and after | Leaving the control executes nothing? |
| Read a result without losing the task context | Owned Markdown attachment | Narrow and desktop, pointer | Preview, scroll, close and return | Preview bounds, hit targets and route | Content reachable and the exit usable? |

## Measure usable space and reachable actions

Assess whether users can read, understand, act and recover:

- Compare the content's usable width with its fixed actions and neighboring
  panels. A 768-pixel viewport can leave less room than a 390-pixel single-panel
  layout; breakpoints must respond to the remaining workspace.
- Inspect wrapping, truncation, title height and the first useful content below
  it. A heading split into individual letters may have no horizontal overflow;
  `scrollWidth <= clientWidth` does not establish a usable layout.
- Count the rows each control group occupies and the visible height left for the
  primary content, such as a timeline, list or document, in each state and with
  menus open. Primary content reduced to a few dozen pixels on a phone is a
  finding even without overflow.
- Look for orphaned actions: a control alone on its row while an adjacent row has
  room. Check whether the primary action keeps its position across states.
- Check clipped affordances: a control whose `scrollWidth` exceeds its
  `clientWidth` where the clipped part carries meaning, such as a caret, unit or
  count.
- Check whether a fixed menu or expanded output covers the composer, its close
  action or the focused control. Verify actual hit targets as well as rectangles.
  A nested scroller is acceptable when content and its exit remain reachable.
- Exercise focus order, visible focus, Tab and Shift+Tab, Escape and the return
  to the previous control. Leaving a menu must not apply a setting, clear a draft
  or submit a message unless that is the specified interaction.
- Check target size and spacing together. WCAG's
  [target-size criterion](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
  has exceptions; an icon smaller than 24 CSS pixels is not by itself a failure.
  [Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) likewise
  allows content that genuinely requires a two-dimensional layout.
- Keep business state, field labels and actual errors readable. Do not repair
  crowding by hiding the assistant name, task state or the only available action.
  Follow the repository's page-level language-selector rule and make hover
  explanations available from keyboard focus.

## Compare UI state with server readback

For state problems, compare the UI with the same resource's CLI readback. A
waiting task without a Session has no active Session failure to display. A saved
Worker configuration and an applied configuration are different observations,
and a Bot's closed chat is not a stopped Bot. prepare-daynight-local's
[website guide](../../prepare-daynight-local/references/website.md) describes
these distinctions.

## Prepare content fixtures

Create fixtures with prepare-daynight-local's
[fixture recipes](../../prepare-daynight-local/references/fixtures.md). For
content, use recognizable but nonsensitive samples: Chinese and English long
names, an unbroken repository-style path, a code block, a table and several
paragraphs where the user path needs them. Avoid giant payloads or stress-test
inventories as substitutes for representative content.
