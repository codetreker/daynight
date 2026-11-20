# UI Design

These principles apply when designing, adding, modifying, or reviewing UI.
This document owns the general UI principles, including data-update continuity,
semantic color roles, exact palette, and their visual hierarchy. Product
specifications and design documents own the behavior of specific interfaces
and reference these rules.

Use the shared [MarkdownView](../packages/daynight-web/src/ui/markdown/MarkdownView.tsx) component for Markdown rendering.

## Web typography

The shared [typography definitions](../packages/daynight-web/src/styles/typography.css)
provide semantic sizes relative to the browser's default root font size. At a
16px root, the roles are:

| Role | Variable | Size | Use |
|---|---|---|---|
| Metadata | `--text-metadata` | 12px | IDs, times, and secondary counts |
| Interface | `--text-interface` | 14px | Navigation, list titles, controls, status, errors, code, and tables |
| Reading | `--text-reading` | 16px | Task and Goal descriptions, discussions, Session and Bot messages, and Markdown previews |
| Section heading | `--text-section-heading` | 18px | Headings within a page |
| Detail heading | `--text-detail-heading` | 22px | Detail titles |
| Page heading | `--text-page-heading` | 28px | Page titles |

The [ordinary Task row](spec/daynight-web.md#项目普通-task-行) uses metadata for its secondary status labels.

Use a shared role or inherit it; do not override the variables locally or add
numeric fallbacks. The browser controls the root size, and the body uses the
interface role as its baseline. Reading text should use a 1.75 line height;
controls and lists should use 1.5. Keep roles consistent across viewport widths:
wrap, rearrange, or scroll content instead of shrinking text. Preserve existing
touch target dimensions and the 16 CSS px minimum on touch fields and coarse-pointer
task filters through the shared `--text-touch-field` size (`max(1rem, 16px)`).
Project task filters retain the interface role on narrow fine-pointer screens
while preserving their touch-sized targets.
Terminal text uses `--text-terminal` (12px at a 16px root) as its base and retains independent scaling; external diagrams retain
their own rendering boundary. Any necessary first-party special size belongs
in the shared definitions with its reason.

The Web entry stylesheet loads the shared definitions. All first-party production
styles, including public landing demonstrations, Setup, authentication, workspace,
Bot and attachment interfaces, use these roles. The Web harness runs the
[typography ownership checker](../packages/daynight-web/scripts/typography-policy.mts)
over every production CSS, TS and TSX source, including unreferenced files. Run it
independently with `pnpm --filter @codetreker/daynight-web test:typography-policy`.
It rejects fixed sizes, numeric fallbacks, unregistered size aliases and local
role definitions, including obsolete declarations hidden by later overrides.
`font` shorthands must inherit or contain a registered role as their size.

Selection and native-select styles own their registered font-size parameters;
those parameters resolve to shared roles. Terminal size may multiply
`--text-terminal` by `--terminal-text-scale` with a unitless scale fallback of
`1`. Mermaid's typed `MermaidConfig.themeVariables` controls external diagram
rendering. These rendering mechanisms do not exempt other declarations in their
files. First-party surrounding controls and character icons still use shared
roles.

The TypeScript inspection covers statically readable inline font properties,
constant aliases and strings, JSX, DOM style assignments, `setProperty`,
`cssText` and `setAttribute`. Dynamic font values at recognized declarations
fail. CSS strings that cannot be resolved statically, arbitrary runtime functions
and dynamically computed property names are outside static evaluation. Static
ownership does not prove rendered geometry.
Verify consumers with browser font preferences, desktop and 320px layouts, long
content and applicable interaction states.

## Brand mark

Use the D letter mark for Web brand entries: an independent vertical stem and
rounded arc separated by clear space. The arc is `#7567e8`; the stem is
`#b3a9ff` on dark surfaces and `color-mix(in srgb, #7567e8 76%, #fff)` on
light surfaces. Preserve the two shapes and their separation in monochrome.
The shared decorative `BrandMark` selects its palette for the actual surface;
its parent retains the accessible name and navigation. Layouts own its size.
The matching SVG favicon adapts its stem to the browser color scheme and is
published as a hashed asset.

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

Preserve the existing overdue precedence: eligible ordinary Task rows and graph
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
uses neutral helper text; actual work has its separate activity marker. Ordinary
Task rows and graph nodes show an automatic execution permission label only when
`allowAgents=true`, using background `#EAF6EF`, border `#B9D9C5`, and foreground
`#256A48`. The compact graph label retains the full accessible name and tooltip.
Permission does not establish acquisition, activity, or completion. Existing
checked-switch brand colors remain control selection cues.

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

## Shared Controls

- Use [NativeSelect](design/native-select.md) for native single-line, list and multiple selection controls.
- Use [SelectTrigger](design/native-select.md#自定义菜单入口) for custom selection menu entries with shared presentation.
- Use [CopyButton](design/daynight-web.md#复制控件的职责) for icon-only and text copy actions.

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
- Actual data changes update the affected content under the
  [continuity rule](#preserve-interface-continuity-when-data-changes). Confirmed
  account changes, session expiry, and access revocation must still trigger the
  required isolation and cleanup. Actual failures must remain visible and
  recoverable under the applicable error policy.
- An explicit refresh may show the progress of that operation. Navigating to
  another resource may load its target content. Neither action implicitly
  resets unrelated retained interface state.

Keeping existing content visible does not grant request, publication, or
mutation permission. Existing authentication and authorization gates remain
enforced while a check is pending.

## Preserve interface continuity when data changes

When data is added, modified, or deleted, incrementally update the affected
content and related information in the current interface. Preserve interaction
state that remains valid, including unrelated selections, expansion, scroll
positions, focus, drafts, and graph viewports. A local change must not refresh
the entire page, close or reopen its view, replace the whole view with a
loading placeholder, or reset unrelated state. Continuity must hold throughout
the update; restoring state after an interruption is insufficient.

When a change invalidates interaction state, clear only the invalid part and
make necessary layout adjustments. An adjustment alone does not authorize a
viewport reset. For example, deleting a Task from a dependency graph removes its
node and associated edges and updates affected information while the graph
remains open, retaining zoom, pan, and other valid interaction state.

Incremental update constrains what the user sees, not the internal method:
background full-data fetches, internal recalculation, and framework rerenders are
allowed when they do not cause these visible interruptions. A deleted member,
missing original entry, or missing original locating Task alone does not prove
the containing view's resource is invalid. Actual resource deletion, identity
loss, and access revocation still require their existing security cleanup;
explicit navigation, closing, and layout actions follow their own interaction
rules. Actual errors remain visible and recoverable.

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

## Share single-series bar charts

Use [BarChart](../packages/daynight-web/src/ui/bar-chart/index.tsx) for ordered,
nonnegative integer series. Callers provide full labels, values, a stable axis
maximum and value formatting. The component provides complete readings on hover,
touch and keyboard, with one Tab stop and arrow, Home and End navigation.
The axis label row accommodates its line height and top spacing so labels fit
without vertical overflow, while narrow charts remain horizontally scrollable.
