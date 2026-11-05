# Agent Note: Pending Interaction Navigation

Status: implemented

## Problem

The composer treated every unsuccessful send gate as read-only after its other
notices. Waiting for an approval, question or form also disables sending, while
the user still needs to answer. The resulting read-only message misrepresented
the session. On a small viewport or while reading other entries, the actual
request could be outside the visible timeline.

## Decision

Suppress only the read-only fallback when the activity is `waiting_input` and
a pending interaction passes the existing response gate. Higher priority
notices and all operation gates retain their meaning. The
[Session requirements](../../../../docs/spec/task-sessions.md) own the visible
behavior; the [protocol design](../../../../docs/design/task-session-protocol.md)
owns its relationship to response admission and local reading state.

The timeline offers a localized request locator only for an offscreen,
answerable card. It uses the rendered card's geometry and disabled controls so
local response submission and completion do not wait for a provider snapshot
to remove the locator. A partial view of a tall card is sufficient; otherwise
forms larger than the timeline would retain an unusable locator indefinitely.
Multiple pending requests use timeline order to select the first hidden card.

The button shares the bottom navigation area with Latest. Activating it moves
the timeline to the card, pauses following, captures the new reading position
and focuses the card without answering it. The focus target is outside the
ordinary Tab sequence. Native activity labels retain their existing English
spelling; the locator prefix follows the page locale.

## Alternatives

**Replace read-only with a permanent answer instruction.** A visible interaction
card already exposes the required action, and a second instruction consumes
the space needed to answer on a phone.

**Enable Send while waiting.** This would change provider admission semantics
to fix a presentation error. The request locator and notice selection do not
require a change to sending, interruption, response delivery or draft ownership.

**Use snapshot state alone for the locator.** An interaction may still be
pending in the snapshot after the card locally submits or completes a response.
Checking rendered controls prevents navigation to a card that cannot be answered.

## Consequences

Waiting sessions no longer claim to be read-only merely because ordinary input
is blocked. Offscreen requests remain reachable without forcing a user's
reading position to change when the request arrives. Geometry checks require
real browser validation alongside gate and focus regression tests. This does
not redesign narrow-screen layout or alter native provider behavior.
