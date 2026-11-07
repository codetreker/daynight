# Agent Note: Bounded Input Limit Inventory

Status: implemented

## Problem

Existing stored values and files may exceed candidate limits. Enabling online
admission without inspecting them can make previously readable resources
unusable. A scanner that materializes large rows or file bodies can itself
exhaust resources, and raw JSON size does not establish normalized size.

## Decision

A separate offline command visits a read-only repeatable-read database snapshot
with bounded projections and checks file metadata in each resource namespace.
It applies the shared [candidate policy](2026-11-07-api-input-policy.md) and
production measurement rules to candidates that fit the inspection budgets.
Unresolved values and incomplete scans prevent a clear result. The bounded
JSONL report identifies its source, policy, specification and data sources;
activation verification compares it with independently obtained current facts
and a continuously stopped-writer window. The
[contract](../../../../docs/spec/daynight-api-input-limits.md#存量检查与启用门槛)
owns the limits and operator obligations.

## Alternatives

**Enable the policy without inventory.** Existing data could fail the new write
or response rules, and there would be no evidence of what needs owner action.

**Read complete rows or files before checking.** A single legacy value could
consume excessive memory; raw representation length also cannot prove the size
of a normalized value.

**Treat a database snapshot or maintenance lock as a writer fence.** Application
and file writers do not participate in that lock, so the operator must establish
and preserve a separate stopped-writer window.

## Consequences

The scan and its report are bounded and do not change stored data. Budget
exhaustion and incomplete information block activation rather than inventing a
conversion. Comparing identities cannot authenticate an untrusted report or prove
that writers remained stopped; operations must preserve both evidence and the
window. Complete directories and cumulative disk consumption retain their
existing growth risks.
