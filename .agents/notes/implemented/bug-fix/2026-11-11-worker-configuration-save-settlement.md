# Agent Note: Worker Configuration Save Settlement

Status: implemented

## Problem

An admission pause can outlast an in-flight configuration save. If its local
pending state and caller promise wait for admission to reopen, the editor stays
busy indefinitely even when the write has already produced a result or its
preparation has been cancelled. Finishing the local operation must also preserve
later edits and must not imply that an interrupted request rolled back.

## Decision

The Worker configuration editor separates local operation settlement from
resource publication. It retains the original account, Worker, operation,
dispatch and trusted receipt, and cancels preparation and admission waits with
the operation's own signal. A dispatched write without confirmation retains the
existing unknown and reconciliation behavior; confirmed and known refusal
outcomes retain their classifications. Neither cancellation nor local settlement
authorizes another write.

The editor owns cancellable publication under the original identity and
admission rules. A temporary pause may resume publication of the same result;
superseding or disposing its owner cancels the work and receives its errors.
Draft revision and editor ownership protect subsequent input from an older
result's destructive effects. Further saves use the existing revision,
permission and freshness checks. The [configuration specification](../../../../docs/spec/daynight-worker-configuration.md#web-消费者)
owns the observable behavior.

## Alternatives

**Keep the save pending until admission resumes.** The
[original editor decision](../../archived/architecture/2026-11-04-web-worker-configuration-editor.md)
preserved an in-flight write during a temporary identity check because a pause
is not itself a resource change. A pause can now remain closed indefinitely, so
tying the promise and busy state to publication prevents local settlement.
The original reason to keep the draft and avoid inferring rollback remains.

**Retry the PUT after cancellation.** Dispatch may already have reached the
server. A retry is a new write decision, not evidence about the first request;
the existing read-only reconciliation avoids replaying an unknown result.

## Consequences

The editor can release local busy state while keeping existing configuration and
draft input. A confirmed result still requires admission before its resource is
installed, and an unknown result still blocks a new save until reconciliation.
The in-memory revision and publication owner add lifecycle state but do not
change the wire protocol or persist drafts across editor lifetimes. This decision
does not enable the root account-change pause or alter other consumers.
