# Agent Note: Assistant Task Scope Admission

Status: implemented

## Problem

Assistant Task definitions, materials, claims and inbox management need separate
credential permissions while preserving Bot identity, claim ownership, resource
visibility and the original secret delivery rules. A shared HTTP method cannot
identify every business action or the pre-existing data returned by a response.

## Decision

Assistant Task core classifies the requested actions and combines their scope
requirements. Task and appendix deletion use the same permission across their
supported entry points. Full responses containing existing resources require
read permission. Inbox management uses its own capability, while the independent
inbound token protocol remains unchanged.

Scoped admission reads the current policy through a transaction-bound reader,
after the applicable identity and resource checks and before effects, and repeats
credential and policy checks before completion. The existing Bot and claim checks
remain mandatory. The route inventory and business admission share the same scope
contract. The existing production assembly retains its credential path until
scoped assembly and authoritative storage are connected.

## Alternatives

**Transport-only admission.** HTTP methods do not distinguish a deletion encoded
as a PATCH or a combined update, and other callers can reuse the same operations.
Classifying the action in core keeps those paths under the same business rules.

**Request snapshot only.** An existing transaction already rechecks credential
authority; using a stale snapshot there would allow a concurrent scope edit to be
missed. A transaction-bound reader preserves that boundary.

## Consequences

Scope permission does not confer Bot identity, claim ownership or access to
another user's task. A rejected operation cannot publish the generated inbox
secret. The transaction reader must hold the credential lock until completion;
production activation and the authoritative storage implementation remain
separate work. The [credential scope contract](2026-11-20-credential-scope-contract.md)
owns the shared vocabulary and the [Assistant Task design](../../../../docs/design/assistant-task.md)
describes the component boundary.
