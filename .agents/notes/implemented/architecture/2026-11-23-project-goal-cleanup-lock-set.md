# Agent Note: Project Goal Cleanup Lock Set

Status: implemented

## Problem

Project transfer and deletion remove Goal relationships whose downstream may belong to another Project. Publishing those changes through each downstream Project's existing Task synchronization watermark requires the cleanup transaction to order itself with ordinary writes in every affected Project. Graph serialization alone does not order those writes or protect the watermark.

## Decision

The four Project lifecycle operations preflight source owner administration. A transaction discovers the source and downstream Projects of incident Goal edges, locks those Project rows in UUID order, and then acquires the source Team graph lock. It rechecks the affected set under the graph lock. If the set grew, the transaction rolls back and repeats discovery within the original operation deadline; the business callback runs only after the set is stable and checks authorization again. Only a confirmed rollback before the callback is retried. Unknown commit or cleanup outcomes are not replayed. The [server design](../../../../docs/design/daynight-server.md#项目生命周期中的-goal-边清理) owns the current transaction details.

This revises the remote-lock choice in the [Project cleanup decision](2026-11-19-project-goal-dependency-cleanup.md). Cleanup still advances the relationship revision and does not yet change the downstream Task metadata version.

## Alternatives

**Keep only the Team graph lock.** It orders graph mutations but an unrelated write in the downstream Project could advance a Task watermark ahead of an uncommitted cleanup.

**Acquire newly discovered Project locks under the Team lock.** A concurrent graph writer may hold that Project while waiting for the Team lock, creating a lock cycle.

## Consequences

Lifecycle operations can wait on downstream Project writers and may retry if an edge arrives during acquisition. UUID ordering, cancellation and the existing deadline bound the acquisition; source authorization is rechecked in the committed transaction. The lock set enables a subsequent cleanup change to update downstream Task metadata atomically.
