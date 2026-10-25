# Agent Note: Task-management Service Design Baseline

Status: implemented

## Problem

Repository-linked work needs durable projects, editable tasks and dependencies
that remain valid when clients update different tasks concurrently. The existing
foreground PR reviewer stores review execution state, which does not describe
task ownership, task dependencies or task completion. Reusing that state as a
task database would conflate independent lifecycles.

## Decision

The adopted [requirements](../../../../docs/spec/daynight-server.md) and
[design](../../../../docs/design/daynight-server.md) define an independent Go
service backed by PostgreSQL, located at `packages/daynight-server/`. This note
records the delivered design baseline. The executable, schema and HTTP endpoints
are delivered incrementally. The
[runtime foundation](2026-10-19-server-runtime-foundation.md) implements startup,
HTTP lifecycle and strict coverage gates. The
[transactional storage](2026-10-19-server-transactional-storage.md) provides
migrations, scoped writes and snapshot reads. The
[project API](../feature/2026-10-19-project-management-api.md) implements repository
registration and project queries. The
[task policy](../feature/2026-10-19-task-dependency-policy.md) implements dependency,
state and versioned use cases. The
[task HTTP boundary](../feature/2026-10-19-task-management-http.md) exposes these
operations with strict request semantics.
[Built-process acceptance](../testing/2026-10-19-server-process-acceptance.md)
verifies restart persistence, HTTP races, cancellation and resource ownership.

The selected layers are API definitions, HTTP server, application service and
core models, with concrete PostgreSQL storage inside `core/store`. Application
use cases own domain policy and transactions; storage supplies queries, locking,
migrations and atomic persistence. A second storage interface or implementation
is unnecessary for the selected PostgreSQL deployment.

Projects register a repository address without checking access or starting Git
operations. They do not change the existing client review configuration or SQLite
state. The [foreground CLI decision](2026-10-16-foreground-review-cli.md) retains
ownership of that execution model; this design does not supersede it.

The original service exposed three editable states through general updates.
Reader preparation and approval actions later introduced proposed. The adopted
[status assignment decision](2026-10-24-task-status-assignment.md) removes that
state and those actions, defaults creation to todo and gives status a dedicated
versioned resource. It preserves the project transaction and restores arbitrary
transitions with direct-dependent reopening protection.

Dependencies stay inside a project. Every active/done task requires completed
direct predecessors; done can reopen only when no direct active/done dependent
would become invalid. Ordinary and external edges have identical execution
constraints. Each task write
locks its project row before fresh `READ COMMITTED` queries, validates the
candidate graph and status, and commits fields and edges together. Task versions
add client conflict detection without replacing cross-task exclusion.

Real PostgreSQL tests provide evidence for transaction, migration, cancellation
and concurrent graph/state behavior. Race-enabled `go-cov --ci` gates total,
package and function coverage at strictly greater than 90%, at least 85% and at
least 80%, respectively, with critical block checks retained. The overall gate
uses statement counts from the same raw coverage profile so equality and rounded
display values cannot weaken the requirement. The runtime foundation records
this stricter replacement of the original inclusive total threshold. The design pins a tool revision containing the exclusion
denominator fix and keeps tests with the packages whose coverage they must prove.
The original CI aggregate required both the Go service checks and the existing
native CLI checks. The later [module-scoped CI decision](../process/2026-10-21-module-scoped-pr-ci.md)
selects affected PR modules and retains all checks on main pushes without
changing the individual validation gates.

## Alternatives

**Combine task management with the TypeScript reviewer.** The reviewer owns a
foreground process, local clone paths and SQLite review revisions. Task
management has a separate PostgreSQL lifecycle and caller-facing resource
contract. An independent module preserves those existing ownership boundaries.

**Allow dependencies across projects.** This expands graph validation, locking,
resource lookup and future authorization beyond one project. The adopted scope
keeps one project as the transaction and dependency boundary. Supporting
cross-project dependencies later would require a deliberate redesign of those
rules, not just relaxing an input check.

**Display dependencies without gating status writes.** That would allow a task
to be started or completed while a predecessor is unfinished. The selected
semantics require enforcement on every relevant state or dependency mutation,
including concurrent lifecycle and dependency changes. The original policy also
guarded reopening because general updates could move status backward.

**Use serializable transactions instead of a project row lock.** Serializable
isolation would require bounded whole-operation retries and an explicit policy
for exhausted serialization failures. A project already bounds every edge, so
locking that row provides a visible order for task mutations and fresh reads.
This choice should be reconsidered if measured contention inside one project
becomes a delivery constraint.

## Consequences

The design and implementation tasks share a stable definition of completion.
Each implementation task includes its own behavior tests; the final acceptance
task verifies the built binary and the full cross-layer lifecycle. Documentation
and the breakdown are delivered without claiming that future service behavior
has been tested or shipped.

Project-level locking serializes task writes within a project. Different
projects can proceed independently. The database intentionally has no foreign
keys: the locked service write path validates references, local constraints
guard individual rows. The original design had no deletion API;
[retained task deletion](../feature/2026-10-25-task-soft-deletion.md) now supplies
reference maintenance under that same project lock: undeleted references block
strict deletion, while [explicit incoming removal](../feature/2026-10-25-task-delete-remove-depends.md)
can detach them atomically with source-version updates. New dependencies cannot
reference marked targets. Introducing another writer still requires the same
reference-maintenance discipline.

The original deployment was loopback-only for local CLI and internal program
callers. The [authentication activation](2026-10-22-authentication-activation.md)
now authenticates HTTP callers and checks project membership in resource
lookups while preserving the numeric-loopback listener. Its configured public
origin and existing entry point are independent of that listener. A project ID
is never an authorization credential; changing a listener alone does not deliver
authenticated deployment.

UI, task execution and PR/review integration are additive capabilities outside
the task-management contract. Their affordable addition depends on keeping
resource mutation separate from external execution and on retaining opaque task
identities. The adopted [read-only dashboard design](2026-10-20-task-dashboard-mvp-design.md)
adds a browser consumer and a complete-graph read while retaining those boundaries;
the complete graph read is implemented and browser delivery remains pending.
Current requests only persist and read task-management state. Delete
operations require dependency and reference rules; cross-project edges require
reconsidering the transaction boundary. Neither is an implicit future promise.
