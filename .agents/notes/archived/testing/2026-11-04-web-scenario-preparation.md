# Agent Note: Shared Web Scenario Preparation

Status: implemented

## Problem

The four status journeys repeatedly acquire normal API and installed-CLI
credentials and create projects for the same Alice identity. Permission, platform
and assignment also create separate projects while exercising distinct tasks.
Those setup operations are independent of the cases' mutable business resources.

Reducing repetition requires explicit ownership. Browser sessions, task state,
controlled failures and per-case evidence must remain isolated. Client credentials
must stay outside public artifacts, and the worker must clean its owned private
client roots when it finishes.

## Decision

The common Playwright base registers one lazy worker fixture. A test-scoped
family option selects status or task-control preparation without changing the
worker fixture fingerprint. Resources bind to one exact service origin and
worker incarnation; restarted workers prepare new resources, including when a
single selected scenario runs without its usual predecessors.

The four status scenarios share one API PAT, an independently acquired CLI
PAT/client, and a project created through the installed CLI. Both PATs use normal
UniAuth acquisition. Every status case creates a new API request context,
validates the installed CLI source and artifact hashes, and owns its command,
write, fault and snapshot evidence. The setup receipt records source identity,
worker identity and the actual CLI project-creation command once; cases reference
that receipt rather than claiming the command ran again.

Permission, platform and assignment share only a project. Their API contexts and
normal credential acquisition remain case-owned. Assignment keeps its own Bob
login, invitation and acceptance assertions; membership can grow once while
Alice remains owner. All seven scenarios create fresh mutable tasks and retain
fresh browser contexts, pages, storage and normal browser logins.

Case completion drains its pending CLI commands before attaching evidence.
Worker teardown drains preparation and closes only its owned CLI client;
partial status preparation also closes an acquired client before propagating
failure. Client close removes its private home; target-database cleanup owns the
server PAT records. The acceptance runner retains run-wide recovery after both
targets finish. The [functional target decision](2026-11-04-web-functional-target-overlap.md)
owns that barrier, complete inventories and target isolation. The
[Web validation guide](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns the runtime and receipt details.

## Alternatives

**Keep all preparation case-owned.** This has less shared state and simpler
resource lifetimes, but repeats normal credential and project setup. It remains
a valid trade-off if the shared lifecycle costs more than its measured benefit.

**Reuse browser sessions or mutable tasks.** That would change authentication
coverage and allow one case's storage or business writes to affect another.
Sharing is limited to the specified credentials and project containers; fresh
browser login and task creation remain part of each scenario.

## Consequences

When all four status cases use one worker, normal login operations decrease from
twelve to six and PAT creation from eight to two. Their four projects become one.
The three control cases create one project when they share a worker; their
normal authentication is unchanged. Worker replacement can repeat preparation,
so these counts do not prescribe a single process for the complete suite.

The cache, origin binding, credential lifetime and partial-failure cleanup add
maintenance cost. Fewer fixture projects also change later project-list work.
A paired local experiment confirmed the operation reductions and complete
functional/authentication cleanup, but cache warmth, host load and unchanged
operations varied substantially. It did not establish a causal whole-job or
hosted-CI speedup. Any timing comparison must retain its exact source, workload,
runner and cache conditions; passing verification alone does not establish a
performance result.
