# Agent Note: Step Text Admission

Status: implemented

## Problem

A single Step can consume a large share of the complete collection budget.
Transport limits do not constrain every caller, and the encoded collection size
alone does not bound individual fields.

## Decision

Step add and change apply the [shared text policy](2026-11-07-api-input-policy.md)
to the complete target candidate before encoding the collection and persisting
the mutation. The [Step contract](../../../../docs/spec/daynight-task-steps.md)
defines the write field and collection limits and their failure behavior. Reads
use pure stored-field projection without repeat structural or capacity checks,
as recorded in the [canonical batch-read decision](../simplification/2026-11-09-task-canonical-batch-reads.md).
Move and delete do not apply the target field budget to existing values.

## Alternatives

**Apply limits to the codec's structural validation.** Reads and unrelated moves
or deletions would reject previously stored long text.

**Rely on the collection budget or transport alone.** Neither independently
bounds each decoded field for every write entry point.

## Consequences

Partial updates check retained text as part of the target candidate. Existing
long values remain readable and removable, but a change must bring the entire
target within the field limits. Exact JSON encoding remains necessary because
individually legal Steps can exceed the collection budget together.
