# Agent Note: Shared Selection Presentation

Status: implemented

## Problem

Assignee, status and tag filters share one task toolbar but independently define
their trigger heights, fonts, arrows and focus styles. Their desktop and touch
densities diverge even when each menu works correctly. A native selection owner
also needs to retain its internal structure and browser behavior when custom
menus share its presentation.

## Decision

`ui/selection-control` owns common density and touch parameters, a decorative
arrow and the stateless SelectTrigger. NativeSelect consumes the same parameters
while retaining exclusive ownership of native creation and internal CSS.
SelectTrigger renders a real button or a direct details summary and forwards
element-specific refs, events and ARIA. Static layout classes allow external
placement without granting presentation ownership. The [component design](../../../../docs/design/native-select.md)
owns the complete API and geometry.

Task filter consumers explicitly select filter/responsive-target/task presentation.
The later [narrow filter font decision](../bug-fix/2026-11-20-project-task-filter-font.md)
separates fine-pointer text size from responsive target size. The [ordinary toolbar
size decision](../bug-fix/2026-11-20-project-task-filter-xs.md) selects `xs` for
labels, closed values and counts inside that toolbar while retaining shared
geometry and expression search defaults.
AssigneePicker exposes it only to the filter caller; row, detail and form editing
keep their existing appearance. Status selection and preference persistence,
assignee lookup, and tag data, panels, chips and positioning stay feature-owned.
AST ownership checks protect common tokens, hosts, arrows and resolved layout
aliases while preserving the original native restrictions.

The [native selection decision](2026-11-14-shared-native-select.md) retains its
native semantics and ownership rationale. Its presentation parameters are shared
with custom selection triggers without moving menu behavior into NativeSelect.

## Alternatives

**Normalize each feature's CSS separately.** Independent copies of geometry and
state styling can diverge again, especially across touch modes and focus rules.

**Make NativeSelect a general menu framework.** Assignee search, status checkboxes
and tag details have different data and interaction lifecycles. Replacing them
would expand a presentation correction into new menu behavior and duplicate
browser-native selection responsibilities.

**Extract parameters and migrate filters in separate deliveries.** The extraction
and adoption form one bounded presentation capability with no new asynchronous or
business contract. A single focused delivery keeps its visual regression and
ownership enforcement reviewable together.

## Consequences

One owner controls compact, filter, form and touch geometry. Native internal
selectors stay separate, so native list/multiple selection and other consumers
retain their calculated presentation. Custom hosts cannot receive arbitrary
className/style; feature layout aliases are statically checked. This adds a small
presentation API and guard responsibility, but no menu state or network owner.

Actual browser fixtures own rendered geometry, focus and import-order evidence;
module tests own refs, events and element semantics. Neither source checks nor
prototype measurements prove production layout. Physical device picker behavior
remains distinct from headless browser evidence.
