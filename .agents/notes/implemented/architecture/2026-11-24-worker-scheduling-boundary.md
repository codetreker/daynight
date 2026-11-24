# Agent Note: Keep Worker Execution Independent of Server Scheduling

Status: implemented

## Problem

The server required a Worker management registration, evidence of host stop
and durable save, and explicit activation before the Worker could receive work.
A Worker whose local directory was lost could retain its configured Worker ID
and valid credentials yet fail to register because its predecessor epoch was
stored in that directory. The coupling also made an unavailable scheduling
service an authority over whether the local execution scope could be rebuilt.

## Decision

The server owns scheduling and authorization for each business resource. The
Worker owns local process startup, shutdown, saved state and recovery. Ordinary
scheduling uses the candidate and claim interfaces. Those interfaces may check
eligibility, assignment and current claim ownership. Bot and Session operations
continue to check the original host, grant, execution and operation identity.

A Worker stops and saves its own execution by reconciling the exact claim,
ticket, journal and native process boundary. Monitoring remains observational.
Code and design review must reject a requirement for Worker management
registration, a host-wide stop/save report or activation before ordinary
scheduling. An operation on a specific business resource can still require
evidence owned by that resource, such as a stopped claim for voluntary release.

The [Worker design](../../../../docs/design/daynight-worker.md#worker-与服务端的职责边界)
owns the responsibilities and their runtime contracts. This replaces the
archived [service authority](../../archived/architecture/2026-11-20-worker-lifecycle-authority.md),
[local lifecycle integration](../../archived/architecture/2026-11-21-worker-local-lifecycle.md)
and [Web controls](../../archived/architecture/2026-11-20-web-worker-lifecycle-observations.md)
decisions.

## Alternatives

**Replace management epochs with instance UUIDs.** This removes the need to
supply a predecessor epoch after local state loss. The server would still
require an instance registration and activation before normal scheduling.

**Keep the service and host stop handshake.** This lets Web request shutdown and
report stop/save progress under a single operation. It makes normal scheduling
and recovery depend on state published by both the Worker and the server.

## Consequences

The Web and CLI controls for the retired protocol are removed. A saved disable
intent from that protocol has no effect on scheduling after the upgrade.
Ordinary online status and monitoring remain available. Existing execution
recovery uses the original business identity and local evidence. Operators
use local process control for host shutdown. The server continues to return
authoritative results for claims, Session operations and other business writes.

The previously published 0.73.0 Worker requires the retired routes to start and
stay active. The server migration also removes columns read by the old server.
For a deployment, stop Worker processes that require the retired routes, make
the replacement CLI available on their hosts, and take old server processes off
the database before applying the migration. Start the new server and resume
those Workers with the replacement CLI after readiness. Keep their local
execution records through the cutover. Reload existing Web tabs after deployment.
