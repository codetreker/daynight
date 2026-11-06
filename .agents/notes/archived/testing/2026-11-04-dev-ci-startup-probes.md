# Agent Note: Isolated Deployment Startup Probes

Status: implemented

## Problem

The isolated deployment repeatedly starts, restarts and recreates PostgreSQL,
the gateway and the service while verifying readiness, attachment persistence
and paired backup restoration. Health-probe scheduling contributes to those
waits independently of the actual service and backup work.

Docker uses a five-second startup probe interval by default, even when the
ordinary healthcheck interval is shorter. The dev-ci stack's startup grace
periods therefore retain a probe cadence that is longer than its ordinary
two-second checks. The [Docker healthcheck reference](https://docs.docker.com/reference/dockerfile/#healthcheck)
distinguishes the startup interval from the regular interval.

## Decision

The isolated `deployment/dev-ci/compose.yaml` healthchecks set
`start_interval: 250ms` for PostgreSQL, gateway and server. Their existing
`start_period` values, normal two-second interval, probe commands, timeouts,
retry counts, healthy dependencies and Compose readiness waits retain their
semantics. PostgreSQL still probes TCP, so the temporary initialization socket
cannot admit the application early. The normal localhost stack retains its
existing cadence.

The faster startup period checks actual readiness; no successful probe is
synthesized. The existing real-container lifecycle, volume survival, paired
restore, isolation and cleanup checks remain the verification owners. dev-ci and
Web production browser acceptance require Compose 2.20.2 or newer, which
introduced `start_interval` in the [Compose healthcheck definition](https://docs.docker.com/reference/compose-file/services/#healthcheck).
The existing Docker Engine 28 minimum supports this scheduling mode.

The [dev-ci guide](../../../../deployment/dev-ci/README.md) owns invocation and
resource isolation, and the [Web acceptance guide](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns the browser deployment requirements.

## Alternatives

**Reduce the ordinary interval alone.** Startup probes use their own interval
while the grace period is active, so changing only the regular cadence would
leave the observed startup wait and increase healthy-stack probe frequency.

**Remove grace periods or readiness gates.** Grace periods govern failure
accounting, while dependencies and `--wait` establish actual readiness. Removing
those guarantees would change what startup and restoration acceptance prove.
The shorter startup cadence preserves them.

**Use a 100ms startup interval.** Container exec probes have their own process
cost. A 250ms interval bounds the scheduling wait without multiplying that work
as aggressively during initialization. Actual readiness and host load still
bound the result.

## Consequences

Short startup probe gaps can reduce repeated deployment waits. Actual process
startup, database recovery, image preparation and restoration remain part of the
runtime, so the interval does not promise a fixed elapsed-time improvement.
Normal health monitoring and production localhost behavior retain their existing
cadence. Source-bound real-container observations remain necessary to measure
benefit and verify that each restored stack reaches genuine readiness.
