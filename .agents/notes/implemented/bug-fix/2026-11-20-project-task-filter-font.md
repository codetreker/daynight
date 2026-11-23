# Agent Note: Project Task Filter Font on Narrow Screens

Status: implemented

## Problem

On narrow screens with a fine pointer, project task filter values grow to the
same 16 CSS px minimum used for touch fields while adjacent labels retain the
interface size. This makes the values disproportionately large even though
narrow layouts still benefit from larger targets.

## Decision

The shared selection presentation provides `responsive-target`, originally
adopted by ordinary project task filters and expression search filters. It retains
responsive target and badge geometry, but uses the interface font role at 800px
and below with a fine pointer. Coarse and other pointer environments retain the
mode's existing responsive font behavior. Both custom triggers and native selects
use the same parameters; feature owners retain their menus, data and focus behavior.

The [ordinary toolbar size decision](2026-11-20-project-task-filter-xs.md)
partially supersedes that adoption: ordinary labels, closed values and entry
counts select `xs` in their toolbar scope with either pointer type. Expression
search retains the mode's original text policy. The original decision separated
fine-pointer text size from target geometry before the ordinary toolbar received
its own bounded size choice.

The [shared selection decision](../architecture/2026-11-16-shared-selection-presentation.md)
owns presentation and the [semantic typography decision](../architecture/2026-11-20-web-semantic-typography.md)
owns scalable font roles. The [component design](../../../../docs/design/native-select.md)
defines the modes and dimensions.

## Alternatives

**Keep the responsive font for every narrow screen.** This preserves the touch
minimum but leaves fine-pointer task values larger than adjacent interface text.

**Override each filter's font locally.** This duplicates shared selection policy
across native and custom controls and allows the values to diverge.

## Consequences

The mode keeps fine-pointer expression search values aligned with the interface
size and scalable with the browser root while narrow targets retain their minimum
dimensions. Ordinary toolbars retain the same target geometry under their scoped
`xs` choice. Other selection consumers keep their existing behavior. The shared
mode adds an explicit presentation choice that each relevant task filter selects;
visual geometry and native interactions require browser validation.
