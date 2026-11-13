# Agent Note: Self-contained product E2E

Status: implemented

## Problem

Module tests with controlled API responses cannot prove that the compiled CLI,
production Web and complete Server share authentication and persisted data.
Existing focused service checks also rely on a partial UniAuth fixture or a
domain host. A product journey needs the complete runtime without a pre-existing
deployment, remote credentials or a live upstream identity provider.

## Decision

`packages/e2e_tests` owns an explicit Linux product E2E entry. It builds the
current checkout's CLI, production Web and full Go Server, and the unmodified
UniAuth production command and Console at a fixed source revision. Normal
sequential browser and CLI journeys exercise the complete product entry points.
The normal journey also reads the device-issued CLI PAT by its actual identity
in the browser account list after a successful CLI request. It checks the
recorded approximate and full local time across the assembled system; detailed
credential lifecycle and failure cases remain with their owning module tests.
The tag journey creates independently tagged Goal and child Tasks through the
CLI, edits and filters them in Web, and checks renamed and deleted catalog entries
and their associations across both clients after reload. Module and store tests
retain the error, concurrency and capacity matrices.

Every run owns an internal database network, a private ingress bridge, a
PostgreSQL instance and data volume, an application container, private
credentials and storage. Public addresses are
loopback-only ports. Inside the application container, local forwarders preserve
those same public origin identities while production services retain their
loopback listeners. The host browser and compiled CLI use those public origins. After product
processes stop, parent cleanup uses a tracked network-free helper container to
restore private mount ownership to the host run-directory owner. This remains
available after forced runtime termination; otherwise root-owned nonempty
attachment directories cannot be removed by the host cleanup process.

The pinned UniAuth GitHub provider uses fixed HTTPS endpoints. A local allowlisted
CONNECT proxy serves their OAuth protocol with per-run TLS trust and a verified
test identity. The production provider still performs actual TLS, PKCE, token
and identity exchanges. The proxy has no upstream forwarding path, and the
application container removes its default route before starting services. The
connected ingress and database routes remain available, while external runtime
connections cannot be routed. App registration goes through
the real Console after normal authentication, rather than writing auth data.

An independent Linux CI job selects the framework and actual production build
inputs and runs the same explicit command. Selected E2E must succeed at the
final gate. CI reserves a separate always-run recovery step: resource ownership
is persisted before creation, and normal/recovery cleanup use the same mechanism.
Preparation and execution steps are individually bounded; their declared
maxima include cleanup and upload and remain below the job limit. Recovery
preserves the original scenario and cleanup receipt instead of turning an
interrupted run green. Artifact uploads include only results and logs.

The framework owns its process, provider and cleanup tests. Product journeys
stay normal and sequential; module boundaries, concurrency and stress suites
remain with their established owners. Preparation may retrieve pinned build
dependencies and sources; running tests require no remote service.

## Alternatives

**Reuse the existing UniAuth fixture.** It exercises real gateway components but
bypasses the complete command, Console and normal App provisioning. It cannot
prove the assembled authentication runtime required by a complete product E2E.

**Use live GitHub or an existing auth deployment.** This requires external
accounts, secrets, service availability and manual authorization. It prevents a
self-contained repeatable run and couples failures to another environment.

**Call internal product functions or use a domain host.** This can validate a
focused module contract but omits complete startup, routing, authentication and
production resource assembly. It does not establish the cross-client journey.

## Consequences

The framework adds an independent build and runtime owner while reusing normal
product build commands. Its initial journey proves same-data task operations;
additional normal workflows can use the same fixtures without multiplying
platform or fault matrices.

Go, source and container caches make repeated preparation cheaper. Preparation
still requires tools and potentially dependency access; runtime isolation does
not claim an offline build. The upstream source pin and local provider must be
reviewed when UniAuth's protocol changes.

Per-run cleanup remains part of success, and source/artifact identities bound
the retained result. The independent hosted job does not replace module, installed CLI or deployment
checks; module-only fixture changes do not schedule a complete product journey.
