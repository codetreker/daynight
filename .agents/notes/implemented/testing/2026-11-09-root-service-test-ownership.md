# Agent Note: Root Service Test Ownership

Status: implemented

## Problem

Root service tests opened PostgreSQL, created identities and domain resources,
and repeated Task, Project and Worker scenarios to observe application assembly
or return-value handling. This coupled feedback to schema and unrelated fixture
work. Some scenarios also observed real snapshots, locks, rollback or persisted
configuration, so removing their database setup without separating those proofs
would lose meaningful detection.

Application tests must exercise the assembly that production uses. A separately
constructed test App could remain green when production omits a shared module,
readiness binding, background worker or cleanup path. Supplied transaction
results also cannot establish that the real backend committed or released a
resource.

## Decision

The root `internal/service` suite owns App composition, opening, readiness,
background supervision, partial startup, resource retention and close retry.
`OpenAppWithLogger` calls the same private `openApp` body that tests exercise.
Instance-owned `appOpeners` select file and persistence construction; production
selects `local.New` and PostgreSQL, while tests supply only those lower resource
boundaries. There is no process-wide factory replacement or independently
assembled test application.

App opening and public `OpenPersistence` both execute `openPersistence`. That
helper binds the same backend instance to `Persistence.Transactions`, `Ready`
and `Close`. Tests therefore observe production dependency wiring and resource
ownership while controlling backend facts. Transaction callbacks and supplied
completion outcomes remain separate from any claim about real persistence.

Root fixtures supply explicit startup, maintenance, domain and failure facts on
the existing DAO and transaction contracts. They check calls and arguments,
reject unconfigured background access, and cancel and drain work before releasing
its dependencies. Recorded writes do not compute subsequent reads or simulate a
database. Real Session Engine state, local files, transfer permits, reader
lifetimes and Webhook workers remain when those mechanisms are being observed.

The root test binary clears database and UniAuth fixture variables for both its
ordinary suite and the explicitly tagged Webhook partial-start witness. Native
configuration, UniAuth client, storage, malformed DSN and database-open failures
still execute the public entry points. Identity HTTP tests retain real local
transport, response and cancellation behavior. Successful native application
composition and process lifecycle remain covered by the independent
[startup/shutdown entry](../../../../packages/daynight-server/scripts/startup-shutdown.sh).

Mixed domain and database assertions follow their actual owners:

| Owner | Retained proof |
|---|---|
| [Core Task candidates](../../../../packages/daynight-server/internal/core/task/mutation_coverage_test.go), [query cursors](../../../../packages/daynight-server/internal/core/query/page_test.go) and [Worker rules](../../../../packages/daynight-server/internal/core/worker/) | Candidate and cursor validation, Worker configuration and inventory rules over explicit domain inputs and DAO results |
| [Task](../../../../packages/daynight-server/internal/service/task/), [Project](../../../../packages/daynight-server/internal/service/project/), [Team](../../../../packages/daynight-server/internal/service/team/), [Worker](../../../../packages/daynight-server/internal/service/worker/), [Bot](../../../../packages/daynight-server/internal/service/bot/) and [Attachment](../../../../packages/daynight-server/internal/service/attachment/) services | Domain orchestration, authorization and projection order, cursor and error contracts, completion precedence and result suppression through strict lower expectations |
| [Project projection snapshots](../../../../packages/daynight-server/internal/core/store/postgres/project_projection_snapshot_test.go) | Current ownership, actor access and participant data share the actual database snapshot; ordinary Task writes retain their authorization-source lock behavior |
| [Task/Session transactions](../../../../packages/daynight-server/internal/core/store/postgres/task_session_test.go) | Atomic deletion, Session freeze and cache epoch changes, with real failure rollback and persisted readback |
| [Transaction completion](../../../../packages/daynight-server/internal/core/store/postgres/transaction_test.go) | Actual commit, cancellation and lost acknowledgement, including the snapshot wrapper's unknown outcome and original error chain |
| [Webhook startup queries](../../../../packages/daynight-server/internal/core/store/postgres/webhook_startup_test.go) | Native empty and modified policy rows, ordered policy versions and current signing-key/revision-wait references; App tests separately verify startup rejection and cleanup from supplied facts |
| [Task DAO](../../../../packages/daynight-server/internal/core/store/postgres/task/mutation_contract_test.go) and [Worker configuration](../../../../packages/daynight-server/internal/core/store/postgres/worker/configuration_contract_test.go)/[snapshot](../../../../packages/daynight-server/internal/core/store/postgres/worker/snapshot_contract_test.go) contracts | Exact SQL behavior, mapping, persisted fields, unchanged Task data, atomic report rollback and Worker configuration CAS |

Equivalent existing lower tests consolidate repeated matrices; unique inputs,
assertions and failure observations remain executed by their owner. Store
receivers use direct scopes and DAOs rather than reproducing full upper service
flows. Normal API integration and product E2E keep their existing normal-flow
scope. Production capacities, timing defaults, test selection and quality gates
retain their existing contracts.

The [test-writing rules](../../../../docs/writing_tests.md) own layer boundaries.
The [application lifecycle decision](../architecture/2026-11-06-server-application-lifecycle.md)
retains production ownership and shutdown rationale. Earlier
[Worker test consolidation](2026-11-08-worker-test-cost.md) left distinct Task and
Project cases in the root; those domain cases now follow this allocation. The
[server guide](../../../../packages/daynight-server/README.md#application-service-tests)
owns focused commands and validation prerequisites.

## Alternatives

**Retain complete PostgreSQL fixtures for root assertions.** They can supply
valid stored facts, but repeat database and domain setup for assembly and
completion behavior that can control those facts directly. Physical mechanisms
continue to need isolated PostgreSQL in their Store owner.

**Construct a replacement App in test helpers.** This bypasses production
assembly and can hide missing module, readiness or close wiring. Instance-owned
openers control resource creation while the production assembly and shared
persistence binding still execute.

**Move whole mixed service scenarios into Store.** Their business calls and
fixture costs would remain under a different directory. Direct DAO and scope
witnesses preserve physical observations independently of upper rule matrices.

## Consequences

Root assembly and lifecycle feedback runs without database or authentication
fixture preparation. Real resources remain for the lifetime and transport
mechanisms under test, and native factory success is checked separately by the
process entry. A controlled backend result proves application handling and
wiring; it does not prove SQL, commit, rollback or durability.

Performance comparisons include the root package and receiving domain and Store
packages with matching toolchain, instrumentation, caches and resource limits.
Removed fixture work is distinct from physical work moved to another owner.
Source-bound validation retains measured samples, fault controls and hosted
results; a shorter root-package time alone does not establish lower complete
validation cost or faster CI completion.
