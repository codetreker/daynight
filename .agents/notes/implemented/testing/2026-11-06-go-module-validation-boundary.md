# Agent Note: Go Module Validation Boundary

Status: implemented

## Problem

A Go validation job installed the complete CLI, executed installed-client
assertions and handed a normally issued PAT to Node deadline probes. A second Go
job ran a test-only package containing built-process workflows, installed CLI
commands, boundary matrices and competing writers. The job and source-language
boundaries hid the actual owner of each assertion and made service validation
depend on client packaging and process setup.

## Decision

The Go gate builds and verifies the Go module. It runs build, vet, module tests
and the original pinned coverage gates, with no CLI build, installation,
subprocess, installed receipt or PAT budget-file handoff. The former
`cmd/e2e_tests` package and its dedicated job are removed together with the
CLI-located service/deadline orchestration and its exclusive support code.

Go's executable still embeds production Web resources. Preparing those real
assets is a compilation dependency, not execution of Web tests. Real PostgreSQL
and UniAuth fixtures remain dependencies of the Go tests that own database,
authentication and HTTP behavior. Coverage uses the complete production package
list and preserves critical, package, function and exact total thresholds.
`DAYNIGHT_TEST_RACE` keeps its local/main-enabled and PR-disabled policy. The
Go-owned coverage runner owns its watchdog and SIGINT/SIGTERM handling. It
terminates the complete detached command group, escalates remaining descendants
to SIGKILL and waits for command closure before reporting the original failure.

Client request, output, timeout, unknown-result and retry rules belong to CLI
module tests. UI state and asynchronous-response rules belong to Web module
tests. Service authorization, transactions, locks, boundaries and concurrency
belong to Go module tests. Product E2E has a separate responsibility: a small
normal-data journey through installed CLI, production Web and the real service.
It does not own boundary, conflict, fault or competing-writer matrices.

The [package extraction](../../archived/testing/2026-11-03-server-e2e-package.md) and
[CI split](../../archived/testing/2026-11-04-server-e2e-ci-jobs.md) records retain the earlier rationale.
They separated process fixtures and runner lifetimes while preserving the mixed
assertion set. This decision replaces that assertion and resource ownership;
[the input-selection record](../../archived/testing/2026-11-04-server-ci-input-selection.md) preserves
the conservative routing choices independently of actual Go test execution.

## Alternatives

**Retain installed authentication and deadline probes in coverage.** The earlier
split kept the normal PAT producer, its consumers and cleanup together, avoiding
cross-job credentials while retaining handler coverage. That made Go validation
pay for client build/install and mixed client behavior with server coverage.
The assertion owner now determines the verification location.

**Move the complete former package into product E2E.** This would retain its
boundary, refusal, fault and race matrices under another runner name. Product
E2E proves normal component connections; those matrices belong to their modules.

**Add replacements before removing misplaced tests.** This avoids a temporary
validation gap but preserves simultaneous old/new ownership during migration.
The selected order removes misplaced validation first, retains immutable
assertion provenance, then restores each valid guarantee at its owner. An
intermediate coverage failure remains visible and is not final delivery.

## Consequences

Go validation no longer depends on CLI artifacts or client credentials. Its raw
coverage profile and errors remain direct observations of the service module.
The [server guide](../../../../packages/daynight-server/README.md#go-module-validation-and-ci-evidence)
owns commands and artifact interpretation.

Removal does not establish replacement coverage or a successful new product
E2E. Valid guarantees must be accounted for at their final owners; a green total
percentage alone cannot establish that every behavior was retained. Production
coverage thresholds and failure propagation remain unchanged throughout the
migration. Historical process receipts prove only their exact original source,
artifacts and execution scope.
