# Agent Note: Bot deletion recovery after execution evidence loss

Status: implemented

## Problem

A deleted Bot projection intentionally omits its former Session definition. A
Worker that has lost the original store can therefore mistake an empty local
record for an execution that never existed. Persisting a null stop proof as local
completion then causes repeated completion receipts that the server rejects for
the real bound Session. Removing the recreated store does not recover the lost
identity or settle either cleanup obligation.

The server can retain `failed/execution_evidence_missing`, but ordinary deletion
observation and repeating DELETE cannot restore execution evidence. A durable
failure without a recovery action leaves the owner unable to finish server data
cleanup even when they understand that the original machine remains unverified.

## Decision

The [assistant design](../../../../docs/design/assistant.md#删除与清理事务)
separates normal proof-based completion from an owner-authorized settlement with
local verification unresolved. The recovery resource is separate from the
existing Bot DTO: installed clients strictly decode both fields and the existing
three cleanup states. A recovery decision retains its operation identity,
operator, reason, time, original deletion, and original Session binding after
Session data is removed.

The [Worker runtime](../../../../docs/design/worker-bot-runtime.md) treats the
existing server failure as a persistent recovery requirement, including local
records already marked complete with a null proof. It retains read-only
reconciliation without repeatedly reporting success. A separate local inspection
reports available evidence; explicit recovery uses the original execution and
existing stop protocol. A missing process name, empty directory, or newly
generated identity cannot stand in for the original stop proof. The server's
binding distinguishes these failures from genuinely never-bound Bots, whose
ordinary null-proof completion remains valid.

Retaining an intent does not make a missing execution row evidence of an
unsubmitted launch. Partial evidence loss is detected before private files are
removed. A rejected historical null receipt enters recovery instead of being
replayed indefinitely; a rejected `never_started` receipt additionally requires
a fresh recovery read matching its original binding and current host.

When that row is missing but the original intent, ticket and journal still
validate, explicit local recovery uses the existing Controller stop mechanism
to stop the retained generation. Its real proof remains in the original journal;
the missing history cannot justify reconstructing an execution row or a partial
private cleanup plan. The CLI distinguishes that stopped generation from the
still-incomplete deletion through its existing failure reason and hint. It
retains the ticket and journal and sends no completed receipt. Automatic retries
and ordinary Worker operation do not use this compensation.

An explicit owner decision permits the existing server cleanup pipeline to run
while Worker cleanup remains failed. The server checks this decision before
accepting later Worker receipts. Otherwise clearing `bots.session_id` during
cleanup would allow a late null proof to masquerade as never-bound completion.
An uncertain decision is observed through its original operation identity;
replaying the same accepted decision does not start another cleanup attempt.
Explicit cleanup retries are fenced by the current Bot version and existing
decision.

The recovery path is limited to Bot deletion failures. Inspection on the hosting
machine and retained execution evidence take precedence; ordinary Worker
operation, Task execution and recovery of running Bots retain their existing
flows. The CLI owns local compensation and explicit unverified settlement.

The [management UI](../../../../docs/design/bot-management-web.md#删除协调)
reads the independent resource for a retained deletion or known Bot ID, presents
hosting-machine CLI instructions, and distinguishes server cleanup with local
verification unresolved from normal completion. It neither submits recovery
decisions nor lists account-wide deletion history. A fresh browser needs the Bot
ID to inspect this result. The existing deletion and Session access barriers
remain in force.
This extends the [browser deletion decision](../architecture/2026-11-05-bot-browser-deletion.md)
and the [completion feedback decision](2026-11-17-bot-deletion-feedback.md), whose
normal proof-based completion behavior remains applicable.

## Alternatives

**Only stop repeated receipts.** This reduces noise and exposes the real failure,
but leaves no way to complete server cleanup after permanent evidence loss.

**Add browser settlement and account-wide recovery discovery.** A broader
recovery design included direct browser confirmation, durable unknown-write
state and a paginated account history. Those features reduce the need to use
the CLI or retain a Bot ID, but add a second mutation workflow and discovery
contract beyond compensation for the affected Bot. They are omitted; the UI
instead explains the original-machine procedure and reads the known deletion.
Adding them later would require browser request persistence and lifecycle
validation, plus an independently authorized and paginated collection. The
per-Bot decision, original identity and read resource stay independent of the
CLI so these additions would not require weakening stop-proof or receipt rules.

**Set Worker cleanup to completed after owner confirmation.** An attestation
cannot establish that the original native process stopped. Such a transition
would erase the distinction that consumers use to interpret deletion success.

**Accept a null proof for every deleted Bot.** The deleted public projection does
not expose whether a Session ever existed. The server retains that fact and must
continue requiring proof for normal bound-session completion.

**Add a waived cleanup state to the existing DTO.** Strict installed clients
would reject the response, including ordinary list and detail reads. A separate
resource exposes the new decision without changing their wire contract.

**Treat a subsequent machine reboot as reconstructed proof.** Without durable
original machine and boot identity, a new boot observation cannot be attributed
to the lost execution. Supporting that evidence in the future requires retaining
its provenance before the failure; the recovery path does not synthesize it.

## Consequences

Owners can complete managed server cleanup without falsely asserting verified
local cleanup. Recovery requires an explicit decision when original evidence
cannot be restored, and the retained decision adds a small permanent audit record.
The independent resource adds reads for affected deleted Bots and requires a
server that implements recovery; unsupported servers remain visibly unresolved.
Users must perform compensation through the CLI, and a browser without retained
deletion state needs a known Bot ID. There is no account recovery collection or
browser recovery write. These limits keep the repair within Bot deletion
failures rather than introducing a general Worker recovery workflow.

Old Workers may continue sending rejected receipts until upgraded, but cannot
overwrite the decision or turn it into verified completion. New Workers retain
the failure across restarts through existing authoritative deletion state rather
than relying on a transient retry flag.

A crash between saving an intent and saving its first execution row is
indistinguishable from later loss of that row. This narrow preparation window
therefore requires explicit recovery too. Persisted `not-submitted` or definitive
launch-rejection evidence still supports ordinary `never_started` completion.

Settlement does not stop an unidentified native process, erase an ordinary cwd
or shared Provider history, or revoke the user's shared PAT. Server cleanup
failures and uncertain responses preserve the same deletion and decision for
observation and explicit retry. Broader recovery evidence can be added only with
verifiable original provenance and must not reinterpret existing unverified
decisions as proof-based completion.
