# Agent Note: Web Execution Evidence Beside the Worker Claim Index

Status: implemented

## Problem

The worker can reconcile Herdr from current terminal resources and a small
claim/session index. A private Web Controller also needs durable native-call
receipts, connection fencing and process-stop evidence. Applying Herdr's NULL
session recovery or process-local cleanup rules to that Controller can replay
an uncertain input or replace a writer that is still running. An immediate-stop
deadline captured by the coordinator can also precede the backend cleanup start
by a millisecond, causing strict persistence validation to reject shutdown before
it attempts to stop that writer.

## Decision

The shared worker index retains project/task/claim, status, agent, native session
ID and claim-frozen control mode. Herdr keeps current-resource reconciliation,
current applicable launch settings and process-local jobs. Web owns a separate
`web-executions.sqlite` with frozen execution configuration, original launch
identity, recovery budget, cleanup operation and deadline. Controller journals
continue to own native input receipts, projections and the durable outbox.

The [minimal worker record decision](../simplification/2026-10-27-worker-claim-records.md)
remains the Herdr lifecycle owner. The [mode decision](2026-10-27-task-session-mode-contract.md)
extends the shared index with frozen routing; the [session design](../../../../docs/design/task-session-protocol.md)
owns Web recovery and operation semantics. Neither backend can reinterpret an
existing claim using the latest configured mode. Missing Web provenance is a
visible recovery failure, not proof that no native process was started.

A new Task Worker native session uses the unattended full-access policy.
Independent Test Sessions retain native defaults, and native resume preserves
confirmed settings rather than overwriting later browser choices.

Worker exit directly stops owned agents and preserves unfinished worktrees and
claims. Normal Web claim-end cleanup retains its original operation and deadline,
then requires independent native stop proof before deleting the worktree. A
force withdrawal freezes Session writes in the service transaction and lets the
worker reconcile the absent claim; it does not assert immediate native shutdown.
For the first cleanup record, an already elapsed deadline is normalized to its
start time, representing zero remaining cleanup budget. Existing records retain
their original start and deadline; retries cannot extend that budget. Immediate
shutdown still bypasses the cleanup prompt and proves the original processes
stopped.

Web Controller grants are maintained every 30 seconds, independently of claim
discovery polling. Renewal starts with no more than 120 seconds remaining and
validates the original execution ticket. Preparation, launch and credential writes
are serialized per execution; shutdown cancels and joins maintenance before
closing the execution store.

## Alternatives

**Restore the detailed worker ledger for both modes.** That would replace
Herdr's current resource reconciliation, reintroduce persistent management
intents and change existing recovery behavior solely to support Web sessions.

**Use only the minimal index for Web.** A native session ID cannot establish
whether a prompt was accepted, an old process stopped, or a cleanup was already
submitted. Reconstructing those facts from a NULL ID or missing local record
would weaken the Controller's no-replay and single-writer guarantees.

**Renew only during claim discovery.** The 60-second default poll matches the
former renewal window, leaving no request margin; a longer configured poll can
exceed the grant lifetime. Native-channel authorization cannot depend on that
user-controlled scheduling interval.

## Consequences

Web has an additional persistence owner and must validate it against the claim,
account, service, worktree and native identity. The shared coordinator accounts
for both backends' resources when computing capacity and same-task barriers.
A local record deletion cannot authorize replacement or destructive cleanup.
Schema upgrades preserve known minimal-index rows and assign legacy Herdr mode;
the retired rich worker schema remains explicitly rejected. Private Controller
journals and native history are not deleted by resetting the worker index.
The [SQLite migration decision](2026-10-30-cli-sqlite-migrations.md) gives Web
execution state its independent version 1 and preserves existing stored JSON
strings during unversioned adoption. Controller journal versioning remains with
its own store, and no format migration changes the claim or native-call evidence
ownership described here.
