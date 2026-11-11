# Agent Note: Web Project Ownership Transfer

Status: implemented

## Problem

An owner Team admin needs to transfer a Project without changing its identity or
independent grants. The actor can lose access as a result, and a missing response
cannot establish whether the transfer committed. A paginated Team list cannot
prove that a source Team is inaccessible.

## Decision

Project settings show the actual owner and use confirmed `canTransfer` for the
transfer control; dispatch requires fresh ProjectAccess. The dialog previews a selected or
explicit same-service target before a versioned confirmation. The server receipt
establishes success and supplies the actor's remaining access. When access is
lost, the matching Task cache generation is revoked before navigation. Submission
captures the editor instance, in-memory draft revision and navigation context.
Closing the dialog, resetting its draft and automatic navigation require those
owners still to match; a late receipt cannot replace a newer editor or route.
The receipt and resource facts retain their original admission rules, and the
shared operation's pending and promise timing is unchanged. The source Team is
checked by ID; only a confirmed 404 chooses Personal. A failed check
retains the successful result and permits retrying navigation. Unknown writes
retain a read-only check and are never automatically replayed. Confirmed Project
revocation clears unsubmitted private previews without discarding a dispatched
transfer or its result; its unknown check does not reveal withdrawn Project or
Team details.

The [service transfer decision](../../archived/architecture/2026-11-04-project-transfer.md) records the rationale for the transaction and receipt. The [browser Team preference decision](../../archived/feature/2026-11-04-browser-team-preference.md) records the rationale for selection persistence.
The [stable Project checks decision](../bug-fix/2026-11-05-stable-project-checks.md)
separates retained presentation from fresh mutation admission.

## Alternatives

**Infer transfer success from a later Project read.** A 404 can mean a successful
transfer or a separate access change, and a matching owner does not recover the
original receipt. It cannot safely establish success or authorize replay.

**Use the loaded Team list for return navigation.** Its pages can omit an
accessible source, so absence would send the actor to Personal incorrectly.

## Consequences

The existing reminder form and explicit Project identity remain intact. Users
can transfer to a Team they have not joined while seeing the predicted loss of
access. Cache cleanup and source navigation can fail independently of an already
confirmed transfer; their errors remain visible and retryable. If the user has
changed editor or location, the confirmed result remains available without
automatically taking over the newer presentation.
