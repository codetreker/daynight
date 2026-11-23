# Agent Note: Step Text Admission

Status: implemented

## Problem

A single Step can consume a large share of the complete collection budget.
Transport limits do not constrain every caller, and the encoded collection size
alone does not bound individual fields.

## Decision

The [application retirement](../simplification/2026-11-23-retire-task-steps-application.md) removes Step
admission, codec and dedicated tests. This record preserves why field admission
was separate from read projection and collection capacity.

Step add and change originally applied the [shared text policy](2026-11-07-api-input-policy.md)
to the complete target candidate before encoding the collection and persisting
the mutation. The [Step contract](../../../../docs/spec/daynight-task-steps.md)
now defines the application and storage retirement boundary. Reads
used pure stored-field projection without repeat structural or capacity checks,
as recorded in the [canonical batch-read decision](../simplification/2026-11-09-task-canonical-batch-reads.md).
Move and delete did not apply the target field budget to existing values.

## Alternatives

**Apply limits to the codec's structural validation.** Reads and unrelated moves
or deletions would reject previously stored long text.

**Rely on the collection budget or transport alone.** Neither independently
bounds each decoded field for every write entry point.

## Consequences

Partial updates checked retained text as part of the target candidate. Existing
long values remained readable and removable, but a change had to bring the entire
target within the field limits. Exact JSON encoding was necessary because
individually legal Steps could exceed the collection budget together.
