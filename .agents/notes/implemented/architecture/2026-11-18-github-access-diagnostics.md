# Agent Note: Independent GitHub Installation Access Diagnostics

Status: implemented

## Problem

Installation access rechecks shared PR Webhook diagnostics with actual PR
processing, so an installation event could appear as a PR receipt or clear a PR
error without synchronizing any PR. Removing those writes would also remove the
rate-limit deadline previously persisted as a side effect of channel failure.
Existing rows do not identify which kind of work produced their diagnostics.

## Decision

Access work owns access facts, hint acknowledgement and recovery scheduling.
Only PR and poll work update their respective diagnostics. Access retry records
its own deadline and the shared rate-limit deadline independently; later
installation signals preserve the latter. The
[executor design](../../../../docs/design/github-sync-executor.md) owns these
runtime rules.

Migration 085 normalizes the six mixed Webhook fields once, advancing only
affected revisions while preserving claims, queues and schedules. The
[storage design](../../../../docs/design/github-pr-storage.md) owns the exact
fields and atomicity. The preparation build retains App PR reception, allowing
state separation to be deployed before changing the traffic source. This
extends the [App-scoped reception decision](2026-11-16-github-app-webhook.md).

## Alternatives

**Infer the source of historical diagnostics.** The stored fields have no source
tag, so retaining selected values would misclassify some installation results as
PR results.

**Normalize state when activating project reception.** An older binary rejects
the additional migration ledger entry. Delivering the complete migration set in
a preparation build provides a same-database rollback target with App PR
reception; activation must use the identical ledger.

## Consequences

Installation recovery preserves independent PR and poll errors. Historical PR
diagnostics are also cleared because their source cannot be distinguished;
subsequent PR work repopulates them. Deployment must drain old writers before
normalization, and rollback artifacts must retain the complete migration set.
