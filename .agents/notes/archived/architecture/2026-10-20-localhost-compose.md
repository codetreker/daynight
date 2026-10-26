# Agent Note: Localhost Compose Deployment

Status: implemented

## Problem

Running the project/task API locally requires a matching Go toolchain,
PostgreSQL configuration, database readiness and a persistent data location.
The service's required loopback listener cannot be reached by ordinary Docker
bridge port publishing. A local deployment must start these components together
and preserve projects and tasks when containers are replaced.

## Decision

The [localhost deployment](../../../../deployment/localhost/README.md) owns a
Compose stack and a location-independent startup script. Each startup recreates
all containers together while retaining the named database volume, so the same
command also restores coherent network namespaces after an interrupted run.
The stack builds the embedded dashboard and independent Go module using pinned
Node/pnpm and Go stages, runs PostgreSQL at the same version as CI and waits for
database-backed API health checks. The
[embedded deployment decision](2026-10-20-embedded-dashboard-deployment.md) owns
the frontend build prerequisite and isolated dev-ci environment; the original
loopback forwarding and persistence rationale remains unchanged. Embedded
service migrations retain ownership of schema initialization.

A gateway owns the network namespace shared with the server. nginx forwards
TCP from container port `80` to the service's `127.0.0.1:8787` listener; only
host `127.0.0.1` receives a published API port. The database has no published
host port. TCP forwarding leaves HTTP parsing, size limits and request logging
with the service. The gateway owns the published port and network namespace;
the server joins that namespace as a dependent service. Compose dependency ordering starts
the server after the gateway is running and PostgreSQL is healthy; gateway
health checks can fail until the server is ready without a dependency cycle.
The [service design baseline](2026-10-19-daynight-server-task-design.md) retains
ownership of the local-only runtime and independent reviewer lifecycle.

The PostgreSQL 18 volume mounts at `/var/lib/postgresql`, containing its
version-specific data directory. Ordinary `down` preserves the named volume;
`down --volumes` explicitly deletes it. The guide owns development database credentials, port selection and the
whole-stack recreation procedure for gateway changes. The
[authentication activation](../../implemented/architecture/2026-10-22-authentication-activation.md) now requires
a private `.env` with explicit App/public-origin/callback configuration and
uses public `/readyz` rather than a project-list health check. The listener,
namespace sharing, UID and two-volume persistence choices remain unchanged.

## Alternatives

**Use host networking.** This reaches the existing loopback listener directly,
but Docker Desktop requires an explicit host-networking setting. Bridge
networking supports a normal Linux-container installation without that step.

**Allow a wildcard application listener.** A normal published port would then
reach the service directly, but this changes the deliberate runtime restriction
and requires defining when unauthenticated non-loopback listeners are allowed.
The local deployment preserves that restriction through namespace sharing.

**Proxy HTTP through nginx.** HTTP forwarding introduces another HTTP parser,
body and timeout limits, and request logging behavior. A TCP gateway has no
need to interpret the API and preserves the service's existing HTTP handling.

## Consequences

The host needs Docker with Linux containers, not Go, Node.js or a separately
configured database. First startup requires image, npm dependency and Go-module downloads.
Three containers run one local dashboard/API stack with explicit names:
`daynight-postgres`, `daynight-gateway` and
`daynight-server`. The names keep the containers identifiable in Docker
tools and permit one localhost stack per Docker daemon, regardless of the Compose
project name. Database health gates startup, and
both the direct API and published forwarding path must become healthy before
the startup command succeeds. The service has a longer container stop grace
period than its HTTP drain timeout.

Docker Engine 28+ is required because older engines have a documented
localhost-publishing isolation defect. Compose 2.20+ provides the dependency
and readiness behavior used here. See Docker's
[port publishing](https://docs.docker.com/engine/network/port-publishing/),
[startup ordering](https://docs.docker.com/compose/how-tos/startup-order/) and
[Compose up](https://docs.docker.com/reference/cli/docker/compose/up/) references,
and the [PostgreSQL image](https://hub.docker.com/_/postgres) data-directory
instructions.

Namespace ownership requires coordinating gateway replacement with the server.
Gateway image, configuration and network changes use the same startup command
to recreate the stack while retaining the data volume. Docker can restart a failed gateway without
restarting namespace-sharing dependents; in that case forwarding remains
unavailable until the startup command recreates the stack. Compose restart
operations propagate to the dependent server. Health checks expose this failure
but do not promise unattended availability. The provided credentials and host-loopback
publication describe local development; authenticated remote deployment remains
a separate design. The client review module is not part of this stack. Tests use the separate
[dev-ci deployment](../../../../deployment/dev-ci/README.md), which shares the
production Dockerfile and gateway configuration without operating the daily
containers or persistent dataset.
