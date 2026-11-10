# Agent Note: Composable assistant Session presentation

Status: implemented

## Problem

An assistant conversation needs one title area, a readable message column and a
stable input area. The shared Session already owns identity admission, native
controls, receipts, history and focus. Giving the assistant an independent chat
implementation would duplicate those responsibilities, while changing shared
styles globally would also change Task and Test consumers. Welcome content must
not mistake filtered or incomplete history for a new conversation.

## Decision

The [assistant Session design](../../../../docs/design/bot-session-view.md) uses
optional presentation slots on the existing SessionView and SessionComposer.
SessionView supplies current header state and actual control nodes; the Bot host
composes them with the assistant name, details and navigation inside the shared
header. State, refs, handlers, errors, recovery diagnostics and admission remain
with their existing owners. Default consumers omit the optional presentation.

The Bot host consistently selects the assistant variant and empty slot for each
mounted pane. Shared readiness checks admit welcome content only for confirmed
empty live history. Suggestions update the admitted draft and focus the original
input without dispatching an operation. The welcome layer does not replace the
Timeline or its reading handle. Bot-scoped CSS changes reading and input
appearance without changing the renderer or global Session styles.

The host enables the shared compact-menu option for short visible viewports and
uses the shared default footer. The original custom-footer slots remain intact.
The [responsive footer decision](../bug-fix/2026-11-06-responsive-session-footer.md)
owns action grouping; the [reading-column decision](../bug-fix/2026-11-06-session-reading-column.md)
owns measured alignment, including scrollbar occupancy. These mechanisms are
reused rather than recreated inside the Bot host.

The attachment slot permits bounded normal-flow content while keeping textarea
and footer ownership unchanged. It does not implement uploads or native image
input. Existing authorized image-resource rendering remains available. The
[image design](../../../../docs/design/session-image-contracts.md) owns the separate image
protocol and draft/resource lifecycle requirements.

## Alternatives

**Build a separate assistant renderer and composer.** This would duplicate
sending, interruption, settings confirmation, unknown receipts and read-only
admission. Optional composition retains one implementation of those controls
and lets Task/Test consumers retain their default presentation.

**Hide the duplicate title and controls with CSS.** This cannot reliably compose
state before a snapshot exists and risks removing the only refresh, error or
capability control from keyboard access. Supplying actual nodes preserves their
handlers, accessible names and focus references in a single title area.

**Apply the assistant visual rules globally.** Task and Test pages have their own
layout consumers. An explicit variant together with the Bot pane ancestor limits
the visual change without creating a second rendering model.

**Replace the Timeline with a welcome component.** Remounting loses DOM and
reading identity, and a filtered empty view need not mean empty history. A
stable sibling layer keeps the existing timeline mounted and leaves loading,
errors and archive states under shared ownership.

## Consequences

The assistant can change layout while preserving binding, bounded cache,
restoration, operation and native-provider semantics. The historical
[cache decision](../../archived/architecture/2026-11-04-bot-session-cache.md)
retains the original resource and identity trade-offs; presentation does not
replace that mechanism.

Hosts must keep slot structure stable, render each supplied control once and
preserve the shared focus boundary and textarea identity. CSS depends on the
shared structural classes, so structural changes require checking both default
and assistant consumers. Readiness and stale-callback checks remain centralized
but must be maintained as Session lifecycle rules evolve.

Attachment growth can consume reading space and may collapse in extreme
viewports to preserve input controls. Connecting image input requires real
capability and resource support plus renewed height and control-width checks;
a layout slot alone is not an upload feature. DOM tests establish operation and
identity behavior, browser geometry establishes layout behavior, and neither
prototype nor controlled-browser success establishes live Provider acceptance.
