# Agent Note: Reconcile Bot Hosting Independently of Creation Identity

Status: implemented

## Problem

A rebuilt Worker has a new identity and an empty remote inventory, while its
assistants still own valid local execution records. Treating the creating Worker
as the only possible host prevents discovering those assistants. Rewriting their
creation identity would invalidate frozen configuration and original execution
evidence. A lost recovery response also leaves the client unable to decide whether
it may use a new grant or submit another operation.

## Decision

Local discovery scans Bot directories before consulting remote inventory. It
validates the service and account and holds each Bot's existing exclusive lock.
The original record owner, frozen definition and Controller identities remain
unchanged. A different hosting Worker is represented by the independent recovery
receipt, following the [server recovery decision](2026-11-19-bot-server-takeover.md).
An unavailable directory or inventory observation does not authorize replacement
and does not suppress other independently verifiable local Bots.

Each dedicated Bot stores its recovery identity, original request, generated
Controller token and receipt in private durable recovery state under its own
directory. Persisting a request consumes its one submission opportunity. An
interruption thereafter permits only querying that original operation, including
when the service has no receipt yet. Historical success and current authorization
remain separate; a new grant requires its own operation and token after the
previous result has been resolved. A complete, authenticated HTTP 409
`resource_conflict`, `session_conflict`, `version_conflict` or `archive_conflict`
response to the original submission proves a rejected
transaction under the recovery service's error contract. The client durably
retains that operation and refusal before permitting a later operation with a
new identity. Query failures, missing receipts, malformed responses and unknown
transaction outcomes never provide that proof.

The Session API registers recovery for an existing platform Session and switches
grant and report requests to the versioned recovery API. Each new operation
reads the existing account-authorized Bot observation to obtain the committed
Session binding, while durable intent and fresh authenticated Controller
observation or stopping evidence establish the original local execution.
Renewal observes the live Controller before deriving its local evidence.
An ordinary Session read cannot precede recovery authorization: it
requires the old parent credential, which a valid same-account replacement PAT
must be able to supersede. Recovery retains its dedicated proof checks; ordinary
Session access and synchronized input retain their existing authorization.

The service may still have a null native binding after the Controller creates
its native Session. A same-generation grant uses that observed service binding
without clearing the local native identity; the original Controller synchronizes
it after receiving the grant. Requiring equality would deadlock when the expired
parent credential prevents that synchronization. A new Controller generation
still requires the service's original nonnull native binding and complete stop
proof. Providers that create their native identity on first input may renew a
same-generation null binding. If that binding advances between observation and
submission, a confirmed conflict ends only that rejected operation; the next
attempt reads again and uses a new operation ID and token.

An unregistered dedicated Bot may already be stopped when its recovery identity
is first registered. The local process manager can prepare the next generation
before that registration. Registration therefore carries the already validated
exact predecessor evidence through local generation checks while preserving the
service's predecessor in its receipt. Only the later grant applies the stop proof
and advances the service generation; missing or mismatched evidence still blocks
registration.

New recovery operations wait until the service acknowledges the current Worker's
machine report. Both configuration-protocol and ordinary report paths establish
that fact from a successful service receipt. The gate precedes durable request
preparation, because a Worker without a reported machine is rejected before the
service saves an operation receipt. Existing operation queries remain available
while this prerequisite is pending. A later local configuration-application
failure does not erase the already acknowledged remote machine identity.

The process manager
authenticates and reconnects a live original Controller before considering a new
process. Only the existing complete stopping and native recovery checks permit
another Controller generation. A hosting change does not replay user input or
change the assistant's business-task claims. Input remains subject to the current
Session's synchronization and permission checks.
The [initialization recovery decision](../bug-fix/2026-11-25-bot-initialization-retry.md)
defines the Bot-only exception for a Codex thread that was never requested;
its separate assertion does not relax ordinary Session grants or process-stop
requirements.

Committed legacy migration can register its retained recovery identity without
making copied old paths executable. Its execution fence remains until a verified
Provider recovery point and dedicated executable generation exist. Missing native
material produces an explicit failure and retains the original evidence. The
[runtime design](../../../../docs/design/worker-bot-runtime.md) owns the detailed
discovery, persistence and lifecycle behavior.

## Alternatives

**Rewrite the local owner to the new Worker.** The public definition deliberately
retains its creating Worker and frozen configuration. Rewriting those fields
would require changing original tickets and would confuse creation provenance
with current authority.

**Use the new Worker's remote inventory as the discovery source.** That inventory
cannot contain a Bot bound to its predecessor, so loss of the public index would
make the original private records unreachable.

**Retry registration or grant after an unknown response.** The service may have
committed and revoked the old connection already. Retaining the original request
and querying its receipt preserves the distinction between a missing response
and a rejected operation, at the cost of retaining unresolved state.

**Read the ordinary Session before requesting recovery.** Its parent-credential
check prevents a new PAT from reaching the operation that replaces an expired
parent. Account-authorized Bot observation plus local execution evidence and
dedicated recovery authorization avoids that dependency without relaxing
ordinary Session access.

**Wait for local and service native IDs to be equal.** Local publication precedes
relay synchronization, and an expired parent credential can prevent the relay
from making progress until recovery grants new authority. Conversely, cached
local state may lag a live Controller. Separate current service binding from
original local execution evidence and refresh both before new submissions.

**Require a nonnull native ID for every live grant.** Providers may create their
native Session only on first input. Blocking their renewal prevents the input
that establishes the ID. Keep same-generation null grants and handle a racing
binding transition through the service's confirmed transaction refusal.

**Start takeover as soon as local configuration permits execution.** A live
Controller can be discovered before the new Worker's first report is accepted.
Preparing the operation at that point consumes its sole submission opportunity
without ensuring the service can identify the machine. Waiting for the actual
report receipt preserves query-only reconciliation after genuinely unknown writes.

**Remove the legacy migration fence after registration.** Registration proves
remote recovery identity, not the completeness of Provider files or the safety
of executable paths. Keeping the fence preserves immutable stopping evidence and
allows a separately verified activation without manufacturing a new conversation.

## Consequences

Same-machine hosting can change without relying on public Worker indexes or
recreating a native Session. A lock, valid current account and accepted service
receipt are all necessary; local bytes alone grant no execution authority.

Private recovery state survives restarts and unknown responses, and participates
in the Bot's precise deletion plan. Confirmed refusals retain their original
requests and request IDs; the existing file byte limit is checked before
publication, so exhausted history capacity preserves the pending operation and
the last readable state. An unresolved operation can require external
reconciliation rather than automatic resubmission. Legacy native-material import,
cross-machine handoff and a new claim for assistant business tasks are not implied
by hosting recovery. Provider compatibility remains owned by each adapter's
verified recovery format.
