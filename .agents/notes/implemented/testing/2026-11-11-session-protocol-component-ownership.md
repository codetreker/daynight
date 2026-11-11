# Agent Note: Session Protocol Component Ownership

Status: implemented

## Problem

Session protocol scenarios in the root server package exercise channel fences,
serialization, terminal recovery and startup evidence through a complete
application fixture. Their protocol assertions belong with the route owners,
but replacing all collaborators with operation callbacks would discard the
service and engine behavior on which those scenarios depend.

## Decision

Session protocol component tests assemble the actual routes, Session service,
engine and authentication, with controlled DAO facts and real WebSocket, TCP
and file mechanisms where a scenario observes them. Task startup update rules
are tested with the actual Task routes and service. Authentication callback
path validation belongs to its configuration package. Root retains the shared
application and cross-route witnesses, including failed startup readback and
shared engine behavior.

This partially supersedes the [Session HTTP use-case decision](2026-11-09-session-http-use-cases.md):
direct operation callbacks remain appropriate for adapter-only cases, while
protocol scenarios that depend on real service and engine cooperation retain
those collaborators.

## Alternatives

**Use direct operation callbacks for every Session HTTP test.** They isolate
adapter behavior but cannot demonstrate the business fence, relay sequencing
and recovery behavior exercised by these protocol scenarios.

**Keep all protocol scenarios in the root package.** This preserves the
mechanisms but leaves route-specific failures and their fixtures away from the
implementation that owns them.

## Consequences

Component scenarios do not require a database or gateway, and supplied DAO
facts and transaction outcomes are not evidence of physical persistence. The
remaining root witnesses retain their shared fixture until their own consumers
move. Each scenario must keep its transport, timing, rejection and resource
lifetime observations at the responsible owner.
