# Agent Note: Server Session Boundaries

Status: implemented

## Problem

Task, Test and Bot Sessions share live state while each operation also depends
on durable rows, credentials and domain-specific lock ordering. Binding the
live registry to a concrete database transaction makes completion failures
ambiguous and prevents the same engine from being used safely across requests.

## Decision

A shared `core/session` engine owns live content and terminal registries. A
short-lived Operation holds its own drafts, locks and notifications. Session
services select the transaction and coordinate the participating domain
capabilities through a single `SessionScope`; Session SQL resides in the
existing store implementation. The Bot deletion service commits its admission
barrier before removing live state and performs physical cleanup under the
same Bot-before-Session ordering.

An Operation acquires a live cell only after the established database locks and
holds it until the transaction outcome is known. A committed result publishes
its draft and runs notifications after unlocking; not committed and unknown
outcomes discard the draft and reservations. A cleanup error does not erase a
confirmed commit. Deleting a cell removes its registry entry, so a late commit
cannot reinsert it. The HTTP adapters share the same engine and drain their
connections and admitted work before dependencies close.

The [Session protocol decision](2026-11-05-session-protocol-ownership.md) owns
wire formats; the [Bot boundary decision](2026-11-05-server-bot-boundaries.md)
owns definition and deletion responsibilities.

## Alternatives

**Recreate the Session module for each transaction.** This loses the shared
live registry and makes online synchronization or queued content unavailable
across requests.

**Publish in-memory state when the transaction returns no error.** Commit and
cleanup are independent facts, and a failed commit can have an unknown outcome;
using only an error would publish a rollback or discard a confirmed commit.

**Retain the database transaction inside the engine.** This couples live state
to a driver and hides the scope and lock ordering needed by Bot and Task
operations.

## Consequences

The durable ledger remains separate from transient content and terminal input.
Transactions must complete or discard every Operation, including panic and
cancellation paths. The current store remains the sole SQL implementation;
its physical PostgreSQL package ownership is handled separately.
