# Agent Note: Serial Terminal Session Discovery

Status: implemented

## Problem

A visible terminal viewer can receive repeated visibility notifications while
the current claim has no registered Session. Starting a new current read on
each notification bypasses reconnect delay and repeatedly replaces the empty
view with loading. This amplifies requests and disturbs the interface while a
Worker is still registering.

## Decision

The terminal client owns one discovery or reconnect attempt and its timer.
Unchanged visibility cannot bypass a pending attempt or timer; it can restore
discovery when a transient admission gate was closed as a timer fired. A `not_registered` result for the assigned
claim keeps the empty view while a delayed serial read looks for registration;
`not_applicable` stops automatic discovery. Explicit refresh and a new visible
period can read again. Errors remain visible until a later result, and access
loss or a different claim invalidates the viewer. The
[Herdr Session design](../../../../docs/design/herdr-session-web.md) describes
the resulting lifecycle.

## Alternatives

**Increase the reconnect delay alone.** Repeated visibility checks would still
start requests outside that timer and would not prevent concurrent discovery or
loading flashes.

**Stop discovery for every empty result.** This avoids polling but would require
manual action to find a Session registered after the initial read. Distinguishing
the two server statuses retains that recovery without polling inapplicable runs.

## Consequences

An unregistered execution creates bounded background reads while visible;
hidden or invalidated viewers cancel their transport and timer. The client
retains the existing Session fence and does not substitute historical records.
Protocol and authorization failures remain errors rather than successful empty
states. The separate Web native client retains its own discovery lifecycle.
