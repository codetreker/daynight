# UI Design Principles

Apply these principles when designing, implementing, or reviewing Daynight UI.
Shared standards define visual values and reusable behavior. Product
specifications define what a particular interface does, and implementation
guides define how it is built and verified.

## Web typography

All UI text whose size Daynight controls must select one size from the shared
scale or inherit an already selected size. Name the sizes by magnitude, not
purpose. Components must not hard-code, override, or invent sizes. Change a
local size by selecting another shared size. Respect browser text preferences
and zoom; reflow or scroll content as space narrows without shrinking the text.

See the [shared typography standard](spec/web-typography.md) for the scale and
how it applies to different renderers and accessibility settings.

## Semantic color roles

Use the same visual role for the same meaning. Preserve visible labels and any
counts or icons needed to understand state without color. Selection and keyboard
focus must be recognizable together without obscuring underlying state. Dependency
graphs distinguish prerequisites and successors with their shared palette roles,
text legends and accessible relationship descriptions; retain lifecycle fills and
independent selection and keyboard focus cues. Use the
[shared palette](design/web-visual-tokens.md#任务状态与交互色) for exact values.

### Attention, activity, health, and policy

Keep lifecycle, activity, attention, failure, availability, and permission
distinct. Available or permitted does not mean running; running does not mean
complete. An item that remains readable and actionable must not look disabled
merely because its work has ended.

## Accessible and responsive presentation

Keep text and controls distinguishable against their actual backgrounds in all
applicable interaction states. Meet the shared contrast requirements: at least
`4.5:1` for normal text and `3:1` for required non-text control and state cues.
Support keyboard interaction, visible focus, and touch targets. Verify real
interfaces with supported languages, narrow layouts, enlarged text, long content,
and applicable loading, empty, failure, and disabled states. Presentation alone
must not write business data.

See WCAG guidance on [use of color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html),
[text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html),
[non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html),
and [focus appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html).

## Express business rules through controls and interaction

Use availability, selection, busy states, and interaction to communicate what
users can do. For example, a busy refresh button already shows that a refresh
is running. Keep actual business information, field labels, and errors visible.
When a disabled control's reason is not apparent, make it available on demand.
Help offered on hover must also be available through keyboard focus.

## Shared controls

Reuse shared components for equivalent interactions and content. Keep controls
predictable across interfaces while preserving native semantics and feature-owned
behavior. Refer to the applicable component contract for its inputs,
presentation, and interaction rules:
[selection](design/native-select.md),
[copy](design/web-copy-button.md),
[Markdown](design/shared-markdown.md), and [charts](design/web-bar-chart.md).

## Brand mark

Use the shared brand mark consistently across entry points. Preserve its
recognizability across backgrounds and without color. Refer to the
[brand specification](design/web-visual-tokens.md#品牌标志).

## Keep rendered interfaces stable during background checks

Background checks must not interrupt reading or editing. Keep the displayed
interface and valid interaction state throughout the check, including recovery
reads. Do not disable local editing or add transient placeholders or status
rows simply because a check is pending. Switching tabs or windows, restoring
focus or visibility, and returning to a view do not request a visible refresh.
If the results are unchanged, the interface remains unchanged. Explicit
refresh and navigation may show progress without resetting unrelated state.
Keep failures visible and recoverable. Retaining content does not grant access
or write permission; enforce identity and authorization changes immediately
when confirmed.

## Preserve interface continuity when data changes

Update affected content in place and preserve valid focus, selections, drafts,
open views, and scroll positions throughout the update. Clear only state that
is no longer valid. Reflow does not justify resetting the user's view. Actual
resource loss or access revocation still requires the affected state to be
cleared. Keep actual failures visible and recoverable. Feature specifications
own the exact behavior when a resource changes.

## Follow browser navigation

Browser Back and Forward follow the existing navigation. Temporary interfaces
must not intercept navigation, add history entries, or implement restoration to
simulate an explicit close. Feature-specific navigation and draft protection
continue to apply.

## Keep global language selection at page level

Application-wide settings belong to the application or page. Dialogs and
overlays inherit them without duplicating their controls or changing existing
focus and interaction state. The [language specification](spec/daynight-web-i18n.md#语言选择与保存)
defines where the language selector appears.
