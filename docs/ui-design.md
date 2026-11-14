# UI Design

These principles apply when designing, adding, modifying, or reviewing UI.
This document owns the semantic color roles, exact palette, and their visual
hierarchy. Product specifications and design documents own the behavior of
specific interfaces and reference these rules for their colors.

## Semantic color roles

Keep lifecycle, activity, attention, operational health, policy, and interaction
meaning separate. Preserve state labels and the applicable counts or icons;
color is an additional cue.

### Palette and lifecycle meaning

| Role | Default background | Hover background | Border | Status text, dot, or state rail |
|---|---|---|---|---|
| `proposed` | `#F0EBFF` | `#E5DCFF` | `#C9B8EC` | `#64469C` |
| `todo` | `#FAFBFC` | `#F0F3F7` | `#D5DCE5` | `#526174` |
| `in_progress` | `#E9F1FF` | `#DCE8FF` | `#B6CEF4` | `#285B9F` |
| `done` | `#EAF6EF` | `#DCEEE4` | `#B9D9C5` | `#256A48` |
| `cancelled` | `#E9EBEE` | `#DDE1E6` | `#BFC6CE` | `#59616C` |
| `ended` | `#F1F3F5` | `#E4E8EC` | `#C9D0D7` | `#52606D` |
| `attention` | `#FFF7E8` | `#FFF0D6` | `#D4A04A` | `#805B27` |
| `error` / `danger` | `#FFF0EF` | `#FFE2DF` | `#DF9D96` | `#A3322B` |

Use lavender for unconfirmed proposals, near-white for accepted work waiting to
start, blue for work in progress, green for successful completion, and gray for
cancellation. Cancelled items retain readable content and their reading actions;
their styling does not make the entire item disabled or strike through its title.

`ended` is a neutral summary of mixed completed and cancelled work. Real ended
statistics retain done/cancelled counts. It is not a TaskStatus or a claim that
every item succeeded.
Shared Steps map `todo`, `in_progress`, and `done` to the corresponding roles;
`skipped` reuses the neutral cancelled palette with its own label. These mappings
do not add lifecycle states or change transition rules.

Apply the same role to list rows, chain headings, Goal headings, graph cards,
status chips, menu dots, and overview numbers. A real Goal uses its own state
independently of child progress. Expanded containers remain neutral, and each
child uses its own state. Keep item opacity at `1`; use the role's own hover
background while retaining its labels, layout, and actions.

### Attention, activity, health, and policy

Orange expresses a need for attention: overdue work, blocking, pause, waiting
for input, or a condition requiring inspection. Red expresses an explicit
failure or a dangerous action. Ordinary lifecycle backgrounds use neither role.
An error feedback panel does not create a failed Task lifecycle state.

Preserve the existing overdue precedence: eligible standalone Tasks and graph
cards may use the attention background over their lifecycle background, while
retaining the genuine in-progress label and overdue icon or explanation. This
override does not propagate to chain or overview summaries. Blocked and paused
items retain their lifecycle background with attention badges, counts, or an
existing strip.

Actual Session work, running tools, and active Worker claims use activity blue
from `in_progress`. Completed tool results use `done`; failed results use `error`.
Waiting for input uses `attention`. Session summary `notice` and `warning` both
use `attention`, retaining their distinct text and aggregation priority; a
warning name, disconnection, or stopped Session alone does not establish failure.

A green online dot expresses runtime availability. Its adjacent header label
uses neutral helper text; actual work has its separate activity marker. Automatic
execution permission uses a neutral outlined label with explicit on/off text:
background `#FAFBFC`, border `#D5DCE5`, and foreground `#526174`. Permission does not
establish acquisition or activity. Existing checked-switch brand colors remain
control selection cues.

### Progress and interaction hierarchy

Completion progress tracks use done green `#256A48` for the completed portion.
Cancelled tasks do not contribute a segment or enter the completion denominator.
Real ended statistics still include both done and cancelled; the [Web progress
requirements](spec/daynight-web.md#项目整体进度) define the display projection
and its zero-denominator behavior.

Use title text `#172132` and helper text `#556176` on the affected task/status
surfaces, including graph metadata, completion labels, and assignee information.
Status foregrounds come from the role table. Recheck these together with hover
backgrounds rather than replacing backgrounds alone.

Task/status keyboard focus uses dark `#344054`; selection and dependency
inspection use `#52649B`. Preserve the lifecycle or attention fill beneath them.
For graph nodes, keep a 2px selection outline outside the node with a 2px offset,
and put a separate 2px focus outline inside the actual focused body with a -3px
offset. Both cues must remain visible together without overflow clipping. Other
task/status controls retain their existing focus geometry with the dark color.
Overview positioning retains its independent outline. Decorative row borders
are not the sole indicator of state or focus.

These interaction colors apply to task/status controls and graph inspection.
They do not redefine unrelated brand treatments, including the
[Bot composer surface](spec/bot-session-view.md), or replace operational-health
colors merely because an existing control uses green or purple.

### Readability and verification

Normal text must have at least `4.5:1` contrast on its actual background in default,
hover, focused, selected, and overdue combinations. Required non-text control or
state cues must have at least `3:1` contrast against adjacent colors. Disabled
controls retain identifiable labels and the applicable reason; cancellation
alone does not qualify a readable item as a disabled control.

Verify actual consumers in both languages, desktop and 320px layouts, long
content, empty/loading/failure states, retries, and applicable disabled controls.
Check simultaneous selection and keyboard focus, mixed done/cancelled progress,
external nodes, pause/blocking/permission combinations, and warning precedence.
Preserve filtering, sorting, pagination, expansion, navigation, graph interaction,
focus, and drafts. Presentation alone must not issue business writes.

Retain accurate labels, mixed-outcome counts, and warning or pause indicators
under grayscale and color-vision differences. Palette arithmetic and screenshots
do not establish recognition by every reader. The normative accessibility
references are [Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html),
[Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html),
[Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html),
and [Focus Appearance, Level AAA](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html).

## Express business rules through controls and interaction

Prefer control availability, selected states, busy states, and interaction flows
to express business rules. Do not add visible status messages or operating
instructions that repeat what those controls and interactions already express.

| Situation | Expression through the UI | Redundant text to omit |
|---|---|---|
| A refresh is running | The refresh button is busy and disabled | "Refreshing, please wait" |
| A setting is enabled | The switch is on | "Currently enabled" |
| An item is selected | The item has a selected state | "You have selected this item" |

Business information such as task status, field labels, and actual errors must
remain clear and visible. These are information the user needs to read, even
when controls also reflect them.

When context does not explain why a control is disabled, its reason may be
presented on demand near the control. Hover explanations must also be available
through keyboard focus.

## Share native selection presentation

Use [NativeSelect](design/native-select.md) for native single-line, list and
multiple selection controls. The common component owns the native element,
decorative arrow, text clearance, font, border, background, density, focus,
disabled, invalid, pending and touch presentation. A page chooses the public
variant and supplies options, values, labels, constraints, events and real refs.
Search pickers, navigation menus and action menus retain their own semantics.

Consumer classes may set external width, margins and flex/grid placement through
`wrapperClassName`. They must not restyle the internal control, add a second
arrow, restore native single-line appearance or override common touch sizing.
Keep complete option labels, shrink the surrounding layout when necessary and
verify the rendered result in narrow rows and forms. The component imports its
own CSS so public and authentication entries have the same appearance without
requiring the workspace shell.

Use the common compact, filter and form densities rather than per-page heights.
Opt into responsive or named-container touch sizing where the interface calls
for it; ordinary compact controls do not enlarge automatically. Native
`:disabled`, including fieldset inheritance, remains the source of disabled
presentation. Invalid and pending borders do not remove keyboard focus cues.
List controls keep their native size, scrolling and multi-selection without a
dropdown arrow or single-line height.

Enclosing Escape handlers own their existing close and focus-restoration rules.
They must respect prevented events and IME input, and use the shared native popup
predicate to preserve an open system selector's first Escape cancellation.
Stopping propagation for that case must retain the native default action and
keep the outer dialog or draft open. The common component does not intercept
selection or keyboard events.

## Keep rendered interfaces stable during background checks

Run identity, permission, and data checks in the background while preserving
the interface that has already been displayed.

- Switching windows or browser tabs, restoring focus or visibility, and
  returning to a previously visited page do not request a visible refresh.
  These events may trigger background checks.
- During a check, preserve displayed content, selected tabs, open dialogs and
  menus, drafts, unapplied selections, loaded pages, expanded items, scroll
  positions, focus, text selection, and graph viewports. A pending check must
  not by itself hide or remount content, clear a list, replace content with a
  loading placeholder, close an overlay, reset interaction state, disable local
  editing, or insert and remove status rows that shift existing content.
- When the confirmed identity, permissions, and data are unchanged, completion
  of the check must leave the displayed interface and interaction state
  unchanged. Preserving only the final state is insufficient: the interface
  must remain stable throughout the wait and recovery reads.
- Actual data changes may update the affected content. Confirmed account
  changes, session expiry, and access revocation must still trigger the
  required isolation and cleanup. Actual failures must remain visible and
  recoverable under the applicable error policy.
- An explicit refresh may show the progress of that operation. Navigating to
  another resource may load its target content. Neither action implicitly
  resets unrelated retained interface state.

Keeping existing content visible does not grant request, publication, or
mutation permission. Existing authentication and authorization gates remain
enforced while a check is pending.

## Keep global language selection at page level

The main Web interface provides its global language selector in the page
header. Standalone pages may retain their existing language selectors in their
existing locations.

Dialogs, overlays, and their own headers must not provide additional global
language selectors. Modal, fullscreen, or other presentation modes must not
cause a selector to be added, duplicated, relocated, or assigned its own
mode-dependent visibility rules. An overlay's header is not the main Web
header.

Overlays inherit the current application language. Preserve existing modal
isolation, focus behavior, and fullscreen layouts; the containing page regions
continue to follow their existing layout and interaction rules.
