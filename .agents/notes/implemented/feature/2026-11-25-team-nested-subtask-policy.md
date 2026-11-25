# Agent Note: Team Nested Subtask Policy

Status: implemented

## Problem

Teams need to limit new multi-level ordinary Task trees while retaining existing
relationships and allowing projects to move between Teams without rewriting history.
The policy must be manageable without changing established Team response shapes.

## Decision

The owning Team controls `allowNestedSubtask`, defaulting to false. A versioned
settings endpoint exposes it to members and administrators; shared Task creation
checks it only when the parent already has an ordinary parent. The [parent write
design](../../../../docs/design/daynight-task-parent-writes.md) owns the transaction,
release ordering and historical-tree behavior. The Team General panel uses the independent
settings resource, retaining drafts and unknown results with the Team owner. Reads
are ordered by identity, Team, generation and confirmed version; explicit readback
shows current facts without attributing them to an unknown write. This narrows creation admission in
the [ordinary parent write protocol](2026-11-23-task-parent-write-protocol.md).

## Alternatives

**Project setting.** A project-level switch would not express one Team policy
across projects or automatically follow ownership transfers.

**Extend the existing Team response and rename request.** Strict existing clients
would reject an added response field, and the shared rename/delete input would
couple unrelated operations.

**Infer settings from Team metadata.** The metadata response does not carry the
policy, and a delayed metadata read cannot establish the setting or its write
outcome. An independent read also supports old servers without changing their DTO.

## Consequences

Existing trees remain readable and executable; disabling only rejects new deeper
ordinary edges. The policy read uses the current committed Team setting at its
statement snapshot. Old Server writers must drain before migration and new writer
cutover, because a running old instance can still admit nested creation.
