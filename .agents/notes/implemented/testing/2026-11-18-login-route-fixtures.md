# Agent Note: Login Route Fixtures

Status: implemented

## Problem

Several login route tests used a real gateway and database to obtain an
admission or completion result. Their assertions concern HTTP input, redirect
and cookie handling. The capacity response also inserted a full quota of
login rows to obtain a failure that Store tests verify under actual locking.

## Decision

Controlled identity operations provide validation, admission and completion
results while the real HTTP login and callback handlers handle requests.
The secure bootstrap checks the actual HTTPS cookie configuration without
entering login admission. The redirect cases verify both requests and
their cookies. The capacity response retains the retry header and issues
no cookie on rejection.

Real Store and Identity tests retain the byte limits, saved return paths,
capacity contention, one-time consumption and persisted effects.

## Alternatives

**Use native login setup for each route outcome.** It supplies authentic
facts but repeats persistence and gateway setup for adapter assertions.

**Substitute the redirect handler.** It would bypass the route's actual
cookie and error-writing behavior.

## Consequences

The selected route tests run without PostgreSQL or UniAuth. The remaining
identity lifecycle and capacity tests still use their real mechanisms.
