# Agent Note: Persistent Web Recovery Pauses

Status: implemented

## Problem

A stopped Web Controller can exhaust automatic recovery while its task still
reports executing. An exception alone records neither a durable pause nor a
remote waiting summary. A process-local failure limit also disappears when the
worker restarts, and a pause checked after launch preparation cannot prevent
another attempt. The original claim must retain responsibility for its native
session and resources even when no further execution is allowed.

Generation allocation can also precede a failure in worktree verification or
launch preparation. The Controller has not started, so its journal still names
the predecessor; requiring a current-generation journal for every later retry
would make that recoverable execution permanently unavailable.

## Decision

The [Web execution evidence decision](../architecture/2026-10-28-web-execution-evidence.md)
keeps Web recovery separate from Herdr's process-local business recovery. Web uses its
existing `recovery.count`, `pauseReason` and `retryAuthorized` fields to retain
automatic recovery exhaustion and execution failure pauses across restarts.
Saving a pause preserves identity and count, revokes consumed retry authorization,
and commits without a later exception rolling back the same transaction.

Execution checks the durable pause before worktree preparation, initialization,
Controller preparation or launch, and native input. An orderly shutdown marker
cannot override a pause. Older exhausted records without a reason or orderly
shutdown provenance are reconciled against the original journal and process
evidence before launch; uncertainty
retains a diagnostic wait. A healthy last permitted generation remains healthy
at the count limit, including its normal orderly restart.

The coordinator reconciles summaries independently of execution permission.
Blocked Web execution publishes the existing waiting phase with the original
native session ID and no Herdr binding. Failed updates retain the local pause
and retry from a new remote version without spending native recovery budget.
Matching summaries require no write. Neither waiting nor a local pause releases
the active claim, its capacity slot or resources, or completes the task.

Explicit retry grants one original-identity recovery attempt under the existing
runner lock and active-claim checks. Full process-stop proof and the exact native
identity and generation remain required. The pause reason and retry flag
distinguish an unconsumed authorization from a generated attempt awaiting
readiness. Generation creation and count advancement commit atomically; the
flag remains set until a matching ready observation, so interruption cannot
authorize another generation. Initialization remains waiting, failure pauses
again, and initial assignment receipts prevent replay.

A generation can be allocated before worktree verification or launch preparation
fails, leaving only its predecessor's journal. A new explicit retry can continue
that allocated generation only when launch submission is `not-submitted`, no
current Controller or native process evidence exists, and the journal matches
the original execution, claim, Session and native identity at the immediately
preceding generation. Complete predecessor stop proof is rechecked against OS
process state. Consuming the new authorization and incrementing the recovery
count commit atomically while preserving generation, launch ID and initial
operation ID and clearing orderly-restart provenance. An unknown or acknowledged
launch cannot use predecessor evidence to infer that no writer exists.

`task.properties.paused` retains its independent Herdr continuation-ping meaning.
The [worker design](../../../../docs/design/daynight-worker.md#web-backend-与执行证据)
owns the runtime mechanism and the [worker requirements](../../../../docs/spec/daynight-worker.md#w-09sqlite对账退出与恢复)
own observable guarantees.

## Alternatives

**Keep the failure pause in memory.** Restart would erase the reason and permit
another automatic attempt at the same stopped execution. It also leaves no
persistent fact from which a later coordinator can publish waiting.

**Publish waiting only in the exception path.** A lost remote update would leave
the summary stale once execution is blocked. Reconciliation must remain active
without repeating native recovery.

**Restart indefinitely or release the claim.** Unlimited attempts repeatedly
replay the failing recovery path. Releasing ownership would discard the original
claim's capacity and cleanup responsibility before its resources are settled.

**Reuse the task's paused property or add a new wire field.** The task property
already controls Herdr continuation pings, while local execution evidence and the
existing waiting phase express this failure without changing that contract or
the Session protocol.

## Consequences

A failed execution remains diagnosable and recoverable without a replacement
native conversation. Automatic restart cannot bypass the stop, and remote
summary failures cannot consume native recovery attempts. Operators must use
explicit retry after resolving the underlying failure; a retained claim keeps
occupying capacity until recovery or normal claim-end cleanup.

Existing orderly-shutdown markers with an error-free journal remain valid
provenance; the stored data cannot reconstruct every earlier process state. New
shutdowns identify stopped or failed exhausted executions before stopping and
preserve unfinished explicit retries as pauses.

The local pause and remote summary are not one transaction. The remote task can
remain stale while the service is unreachable, but subsequent successful
inventory reads reconcile it. Terminal cleanup retains its independent
[persistent retry schedule](2026-11-04-worker-cleanup-retry.md), original deadline
and notification state for both backends. Its backoff does not consume execution
recovery budget, and a recovery pause cannot release that cleanup responsibility.
This decision changes no cleanup scheduling, fairness policy or Herdr business
recovery behavior. Controlled store/backend checks establish these boundaries;
real provider and combined integration acceptance require their own execution
evidence.
