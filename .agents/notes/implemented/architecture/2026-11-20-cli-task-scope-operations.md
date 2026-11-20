# Agent Note: CLI Task Scope Operations

Status: implemented

## Problem

Task commands previously read Project metadata before using an explicit Project
ID and returned full Task data after an update. These reads prevent a credential
with only Task read or a specific write permission from performing its authorized
operation, and a full response exposes unrelated existing fields.

## Decision

Explicit Project IDs go directly to show, list and graph. Graph negotiates the
task-only Project projection and accepts the legacy full Project response when
the server does not acknowledge the projection. An update with an explicit
Project and version requests a minimal receipt in one PATCH. It validates the
resource and version and reduces a legacy full response to the same receipt
without replaying the mutation. Other command preflight and Goal confirmations
retain their existing behavior. An implicit observation unavailable solely due
to missing Session read permission is a notice; other partial observations remain
failures. Scope refusals remain distinguishable from ordinary forbidden responses.

The [Task read](2026-11-20-task-read-scope-projection.md) and [write](2026-11-20-task-write-scope-admission.md)
decisions own the corresponding server admission and projection mechanisms.

## Alternatives

**Require Project and Task reads for every operation.** This makes an independent
write scope unusable and requires Project read for an already identified Task.

**Retry a write when the receipt is unsupported.** A lost or ambiguous response
cannot prove that the first mutation failed. Parsing the single legacy response
preserves compatibility without risking a duplicate write.

## Consequences

Callers needing full Task details perform a separate authorized read. Explicit
versions retain their exact precision and conflicts do not cause automatic retries.
Scoped server assembly remains separately enabled; these client changes also
operate with existing services.
