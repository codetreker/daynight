# Agent Note: Personal Session Startup Grace

Status: implemented

## Problem

An Agent can still be initializing shortly after a Task enters progress. Showing
the personal list's Session check warning immediately can therefore ask the user
to investigate before initialization has had a reasonable opportunity to finish.

## Decision

The personal in-progress list suppresses its complete Session warning for the
first two minutes of the current Task execution interval. The server's
`task.startedAt` defines that interval, so a process restart within it does not
restart the grace period. The [Web specification](../../../../docs/spec/daynight-web.md#我的进行中任务)
owns the visible states and boundary; the [Web design](../../../../docs/design/daynight-web.md#我的进行中任务)
owns the clock and presentation mechanism.

The rule applies after the final display state is resolved, including the
disconnected and archived fallback. Existing expiry and unavailable precedence
remains intact, and no server observation or other view is changed.

## Alternatives

No alternative was recorded for this fixed presentation window.

## Consequences

Early transient warnings no longer distract from newly started work, while a
fresh warning still appears at the boundary. A genuine warning can also be
hidden for up to two minutes; unavailable and expired observations remain
visible. Tasks with unknown start time do not receive a grace period. Reusing the
execution clock avoids a second timer and keeps refresh and visibility changes
from creating a new interval.
