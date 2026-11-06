# Agent Note: Worker Project Isolation

Status: implemented

## Problem

A Worker can retain references to Projects that its account can no longer read.
Treating one Project's 404 as a failure of the entire inventory prevents other
Projects from progressing. Treating it as an empty inventory instead falsely
ends claims and can destroy resources whose ownership remains unresolved.

## Decision

The Worker records successful inventory coverage separately from unavailable
Project IDs. Only a successful complete Project query can establish absence for
that Project. Candidate admission uses the target Project's inventory and
resource observation, while retained resources and unresolved stopping
responsibilities continue to count against global capacity. An unavailable ID
alone consumes no slot. Bootstrap and native control resolve the relevant
Project independently; an explicit ID is never replaced by another Project
with the same repository.

When a legacy local selection cannot be fully imported because a Project is
unavailable, the Worker applies a temporary process-local view and retries the
complete import. It does not publish a partial cloud configuration. Existing
cloud configuration remains authoritative. Local mappings and worktree markers
remain capacity responsibilities even after deselection; unconfirmed scans do
not release capacity.

The reporter invalidates its complete inventory when coverage fails or a
Project is unavailable and sends the existing null inventory alongside telemetry
until full coverage returns. A new claim cannot turn a null inventory into a
complete observation.
The [worker design](../../../../docs/design/daynight-worker.md) and
[reporting design](../../../../docs/design/daynight-worker-reporting.md) own the
runtime details.

This partially supersedes the global collection requirement in the
[claim inventory decision](2026-10-26-worker-claim-inventory.md) and the
failure retention rule in the [reporting decision](2026-10-28-worker-runtime-reporting.md).
It also partially supersedes the global discovery gate in the [claim record
decision](../simplification/2026-10-27-worker-claim-records.md). These decisions
retain their original rationale for complete project queries and resource
accounting.

## Alternatives

**Treat 404 as an empty Project inventory.** This would let healthy Projects
proceed, but would also authorize cleanup of claims and resources whose absence
was never established.

**Keep all Projects as a single admission gate.** This preserves a complete
account-wide observation but makes one stale configuration disable unrelated
execution, even when its resources are accounted for separately.

## Consequences

Healthy Projects can progress without inventing ownership facts for unavailable
ones. Account-wide task reporting becomes unavailable during partial coverage,
while machine telemetry remains current. Retained resources and uncertain stop
responsibilities continue to limit capacity and may require later intervention.
