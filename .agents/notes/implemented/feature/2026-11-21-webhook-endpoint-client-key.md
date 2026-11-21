# Agent Note: Webhook Endpoint Creation Key

Status: implemented

## Problem

A caller that creates a Webhook endpoint for a purpose of its own, such as the
Assistant Task inbox subscription panel, cannot prevent two concurrent or
repeated creations from producing two live endpoints. Operation IDs make one
request idempotent, but two tabs or a lost response followed by a new request
use different operation IDs. The panel can only detect duplicates afterwards,
and any client-side compensation races with other writers.

## Decision

Endpoint creation accepts an optional caller-chosen `clientKey` of 1-200 visible
ASCII bytes. Among an owner's live endpoints the key is unique; a create that
reuses it returns `409 endpoint_exists` without an effect or receipt. Callers
allowed to read the owner's endpoints receive the holder's ID and configuration
version in the error details, so they can reload the holder instead of
guessing. The key is immutable after creation and the deletion tombstone clears
it, which releases the key for a later create. Reads return the key, and the
list accepts it as a filter, so a caller finds its endpoint by its own identity.

The create transaction checks for a live holder after the configuration source
locks and every authorization check, immediately before writing. A partial
unique index over `(owner_kind, owner_id, client_key)` for live keyed rows is
the database guarantee, because Personal owners have no owner-level lock that
serializes all of their creates. The keyed write runs in a savepoint so a
collision keeps the transaction usable for reading the committed holder. The
key is part of the normalized intent fingerprint and is omitted from it when
absent, so receipts recorded before the field existed still match their
replays. The [management design](../../../../docs/design/webhook-management.md#创建键)
owns the transaction and response details.

## Alternatives

**Uniqueness by destination URL.** The destination already distinguishes most
purposes, but it is mutable configuration and may legitimately repeat across
endpoints. Binding identity to it would refuse valid configurations, change
meaning when a destination is edited and expose URL comparison rules, including
tokens in queries, as a public contract.

**An inbox-owned subscription API.** The Assistant Task inbox could own its
subscription and create the endpoint internally. That duplicates the endpoint
management, eligibility and receipt contracts in a second module and couples
the inbox to Webhook internals, while other callers would still lack a way to
name their endpoints.

**Pre-reading endpoints in the frontend.** Listing endpoints before creating
one is a check-then-insert without concurrency protection: two tabs both see
no endpoint and both create. It also requires the panel to recognize its
endpoint by destination matching and to compensate after races, which the
server already owns.

## Consequences

- Concurrent same-key creates for one owner produce one endpoint; the others
  receive `endpoint_exists`. Personal creates wait on the unique index rather
  than a lock, and the refused transaction performs one extra read.
- Every keyed endpoint write pays for a savepoint; unkeyed writes are unchanged.
- Active endpoint and list projections gain a `clientKey` field. Released CLI
  and Web parsers that reject unknown fields need the accompanying versions
  that accept it.
- The key carries no server-side meaning; callers choose a namespace that
  cannot collide with their other uses.
