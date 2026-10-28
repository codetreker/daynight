# Agent Note: Online Test Session Directory

Status: implemented

## Problem

Repeated test runs leave archived records that obscure the sessions currently
available for debugging. Filtering only a displayed page can also hide online
sessions behind pages filled with old records.

## Decision

The Web directory requests an online-filtered list. The service filters before
pagination using active lifecycle, connected or synchronizing state, fresh
heartbeat and valid connection credentials. A new unconsumed grant does not
invalidate the existing live connection. Cursors bind the filter mode.

This changes the page behavior of the [directory decision](2026-10-28-test-session-directory.md).
The unfiltered API and direct history URLs remain available; Controller resume
continues to use its local stopped-execution evidence. The [requirements](../../../../docs/spec/controller-test-sessions.md)
and [design](../../../../docs/design/task-session-protocol.md) own current behavior.

## Alternatives

**Hide archived rows after fetching a page.** It leaves empty pages and can
conceal online records behind arbitrary amounts of archived history.

**Delete archived sessions.** Removing stored context is unnecessary for a
navigation preference and would undermine history review and resume.

## Consequences

Online status is an observation, not a promise that the connection stays alive.
Refresh obtains a new view, while following a link rechecks authorization.
Disconnected sessions disappear without being deleted or automatically stopped.
