# Agent Note: Ignore retired members in Worker cloud targets

Status: implemented

## Problem

A stored cloud target can retain mode and third-tool members after the two-tool
protocol transition. Rejecting that entire target prevents valid current settings
from applying and leaves schema 10 checkpoints pending, despite the existing
source-preserving decoder accepting other unknown members.

## Decision

Cloud target reception treats `agentControlMode` and `toolPaths.herdr` as unknown
JSON members. GET, report receipts, prompt-combined receipts, manager redecoding
and current schema 11 target reads preserve their full source and exclude them
from the known projection. Current required fields, tool slots, values, envelopes,
capability echoes and equal-revision source comparisons remain strict. Diagnostics
identify invalid current configuration without blaming retained retired members.

An affected pending checkpoint reconciles when its first authenticated GET supplies
the same target. Successful checkpoint installation preserves the reconciled state;
a new process still needs its own native proof. Unknown-only forward revisions
retain the existing application anchor, records and in-flight work. Retired members
produce no application items or execution choices.

This partially supersedes the reception restriction in the
[two-tool protocol decision](../architecture/2026-11-17-worker-two-tool-protocol.md),
the cloud reception restriction in the
[Web checkpoint decision](../architecture/2026-11-17-worker-web-configuration-checkpoint.md),
and clarifies the cloud boundary of the
[Web-only native model](../simplification/2026-11-18-web-only-native-tool-model.md).
The [unknown-source decision](../architecture/2026-11-17-worker-unknown-configuration-preservation.md)
continues to own lossless preservation and application identity.

## Alternatives

**Require an explicit cloud rewrite before applying any settings.** This blocks
valid current settings merely because retained raw authority includes retired
members, unlike every other unknown member. A rewrite remains the explicit way
to remove those members from storage, but is unnecessary for current application.

**Strip or translate retired members during reception.** This would alter raw
authority, weaken equal-revision comparisons and risk presenting a retired choice
as a current execution setting.

## Consequences

Existing targets can apply current settings without losing historical JSON.
Invalid known values and missing current tool slots remain inapplicable. Historical
cache structure decoders, local YAML validation, service writes, tool bootstrap
and old execution ownership retain their independent contracts. No cache schema
change or production data rewrite is required.
