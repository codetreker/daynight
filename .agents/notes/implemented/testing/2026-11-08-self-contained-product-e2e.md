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
CLI, reads and updates the same tag color through stateless MCP using the
device-issued PAT in Node, and checks both associated Web markers before and
after reload. It also checks the default gray, edits and filters associations,
and checks renamed and deleted catalog entries across clients. Module and store
tests retain the error, concurrency and capacity matrices.

Every run owns an internal database network, a private ingress bridge, a
PostgreSQL instance and data volume, an ephemeral Redis monitoring store, an application container, private
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
The Redis container has no published port or persistent volume and is included
in the exact owner-checked cleanup and absence proof. Existing receipts without
its identity must be cleaned by their original runner rather than inferred.

Worker product journeys also register their original runner and gated process
identities before the test can launch a detached Controller. Parent cleanup and
independent recovery verify and stop the original processes before removing the
fixture or its private execution evidence. Chromium launch intent and the
original process-group identity are persisted separately, so a failed Playwright
run can verify that the recorded browser group stopped without relying on
`browser.close()` alone. A missing or conflicting proof keeps the responsibility
visible instead of turning process absence into a guessed successful cleanup.
The product E2E guide owns the recovery procedure.

Worker completion is versioned. An explicit conflict rejects the attempted
write, so the fixture can read the Task again, verify the original active
assignment and authorization, and make a bounded new decision. An unknown
outcome cannot justify a replay. This keeps concurrent Task updates from making
the normal journey fail while preserving the original claim.

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

**Use a shared or simulated monitoring store.** A shared Redis would couple runs
and weaken resource ownership; a simulated API would not establish that the real
Server can read monitoring through its configured store.

**Infer browser shutdown from Playwright exit or close.** Chromium is detached,
and a close result alone does not establish that its original process group has
stopped. Recovery needs the persisted identity and a confirmed stop.

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
the retained result. A failed process observation can retain private fixture
state until its original ownership can be established; it is excluded from CI
artifact uploads. The independent hosted job does not replace module, installed CLI or deployment
checks; module-only fixture changes do not schedule a complete product journey.
