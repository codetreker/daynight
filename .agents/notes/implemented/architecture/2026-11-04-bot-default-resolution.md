# Agent Note: Bot default resolution and successful preferences

Status: implemented

## Problem

Name-only creation needs a deterministic hosting choice without inheriting paths
or provider settings from a different machine. Requests can finish out of order,
lose their HTTP response, or fail before a native session is synchronized. Saving
form values or resolving retries against current defaults would change user intent.

## Decision

Public creation resolves only a missing Bot identity inside the existing
[definition transaction](2026-11-04-bot-definition-storage.md). Replays compare
the normalized request fingerprint and return the frozen configuration before
consulting Worker availability. A namespaced transaction advisory lock serializes
lookup and resolution for the same normalized ID, including the resolved kernel.
The freshness clock is sampled after Worker reads so a concurrent heartbeat
cannot appear to come from the future in a ReadCommitted creation transaction.
Defaults preview shares the resolver and has no
write side effects.

Explicit Worker selection never falls back. Automatic selection tries the last
successful explicit Worker, then available configurations ordered by first
registration time and Worker ID. Each Worker's cwd and provider preferences are
independent, and model/args always come from that Worker's chosen provider report.
The existing assistant observation freshness checks gate eligibility. Server-side
path syntax checks do not claim access to the Worker's filesystem.

Separate user-Worker and per-Worker configuration preference tables maintain a
creation-order watermark for each explicit field. Conditional upserts permit
out-of-order completion without reverting newer successful choices or overwriting
fields omitted by the newer request. The internal preference helper consumes a
persisted, undeleted, ready Bot with a bound Session and joins the lifecycle
caller's transaction. That caller must authenticate and verify the current native
fence and synchronization before recording ready and invoking the helper.

The [specification](../../../../docs/spec/assistant.md) and
[design](../../../../docs/design/assistant.md) own the public fields and transaction
contract. No public client request can assert successful startup or save preferences.

## Alternatives

**Save preferences at creation.** This would let cancellation, pending startup or
failed preflight alter subsequent defaults. Persisting a pending Bot therefore
never submits preferences.

**Use one watermark for a Worker's entire configuration.** A later provider-only
choice could suppress an earlier successful explicit directory, even though the
later request did not choose a directory. Independent field watermarks preserve
both intentions while preventing older values from replacing newer explicit ones.

**Commit preferences in a separate transaction.** A lifecycle rollback could leave
preferences from a startup that never committed. Joining the existing transaction
also preserves the Bot-before-Session lock order needed by deletion.

## Consequences

The API can create frozen pending definitions from a name and a stable request ID.
All registered owner Workers remain visible in defaults observations so an old
explicit selection can explain its failure. The response and resolution work grow
with that user's Worker inventory; this is separate from task-list pagination.

Native startup, filesystem preflight, Session binding and success reports remain
separate lifecycle work. The callback's durable readiness check is not independent
proof of a live native session. Those consumers must use the existing transaction
and verification contract; a client boolean or spawn receipt cannot replace it.
The full assistant entry remains disabled until its hosting and UI are composed.
