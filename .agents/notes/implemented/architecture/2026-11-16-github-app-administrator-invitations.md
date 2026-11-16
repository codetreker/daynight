# Agent Note: GitHub App Administrator Invitations

Status: implemented

## Problem

An independent GitHub App can have several administrators. Concurrent removals must preserve an administrator, and an invitation issued by a removed administrator must not regain authority when that account rejoins. Team and Project membership do not provide the App's administrative identity.

## Decision

App membership uses a sequence allocated version for every insertion. Invitations bind the issuer's exact membership version and hold only a SHA-256 token digest. The App root serializes invitation acceptance, revocation and administrator removal so permission, invitation state and the last administrator decision share one transaction. Business decisions remain in Core; PostgreSQL supplies locks, authoritative time, bounded reads and exact writes. The [administration design](../../../../docs/design/github-app-administration.md) owns the resulting contracts and adoption boundary.

Self removal returns a finite receipt without a subsequent privileged read. Invitation inspection reveals only minimal App identity, expiration and the recipient's membership. Accepting a valid invitation as an existing administrator preserves that membership and leaves the invitation unconsumed. Unknown commits are exposed without replay.

## Alternatives

**Reuse Team invitation issuer rules.** Team member invitations remain useful after some issuer changes, but a full App administrator invitation must lose authority when its precise issuing membership disappears. The independent membership version provides that distinction.

**Protect only the invitation or target member row.** These rows cannot freeze the issuer relationship or the set of remaining administrators. The App root provides a common short lock shared by all participating writes.

## Consequences

Each App serializes its administrative mutations while different Apps remain independent. Sequence values may have gaps after rollback and are never reused for a removed membership. The schema requires no migration beyond the existing registration tables. Adapters remain unmounted until the invitation reception page and its fragment handling are adopted together; this component does not publish an unusable invitation link. The independent App runtime and Project connection access rules are described in the [App cutover](2026-11-17-github-app-cutover.md).
