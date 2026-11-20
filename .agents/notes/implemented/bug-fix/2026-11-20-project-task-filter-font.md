# Agent Note: Project Task Filter Font on Narrow Screens

Status: implemented

## Problem

On narrow screens with a fine pointer, project task filter values grow to the
same 16 CSS px minimum used for touch fields while adjacent labels retain the
interface size. This makes the values disproportionately large even though
narrow layouts still benefit from larger targets.

## Decision

The shared selection presentation provides `responsive-target` for ordinary
project task filters and expression search filters. It retains responsive target
and badge geometry, but uses the interface font role at 800px and below with a
fine pointer. Coarse and other pointer environments retain the existing
responsive font behavior. Both custom triggers and native selects use the same
parameters; feature owners retain their menus, data and focus behavior.

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

Fine-pointer task values align with the interface role and continue to scale with
the browser root size, while narrow targets retain their minimum dimensions.
Other selection consumers keep their existing behavior. The new shared mode adds
an explicit presentation choice and must be applied to each relevant task filter;
visual geometry and native interactions require browser validation.
