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
previous result has been resolved.

The Session API registers recovery for an existing platform Session and switches
grant and report requests to the versioned recovery API. The process manager
authenticates and reconnects a live original Controller before considering a new
process. Only the existing complete stopping and native recovery checks permit
another Controller generation. A hosting change does not replay user input or
change the assistant's business-task claims. Input remains subject to the current
Session's synchronization and permission checks.

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

**Remove the legacy migration fence after registration.** Registration proves
remote recovery identity, not the completeness of Provider files or the safety
of executable paths. Keeping the fence preserves immutable stopping evidence and
allows a separately verified activation without manufacturing a new conversation.

## Consequences

Same-machine hosting can change without relying on public Worker indexes or
recreating a native Session. A lock, valid current account and accepted service
receipt are all necessary; local bytes alone grant no execution authority.

Private recovery state survives restarts and unknown responses, and participates
in the Bot's precise deletion plan. An unresolved operation can require external
reconciliation rather than automatic resubmission. Legacy native-material import,
cross-machine handoff and a new claim for assistant business tasks are not implied
by hosting recovery. Provider compatibility remains owned by each adapter's
verified recovery format.
