# Agent Note: GitHub App Execution Authorization

Status: implemented

## Problem

An in-flight GitHub synchronization can outlive its App credentials, Team grant or Project ownership. A lease tied only to a Project generation cannot independently establish that the original App authorization remains current. Adding new requirements to the running fixed App path would also stop existing connections before the coordinated public cutover.

## Decision

Independent App execution uses a dedicated production work transaction and DAO. Admission captures the App UUID, credential version, immutable grant and owner Team; subsequent transactions require that exact identity together with the original generation, lease token and database expiry. Every work operation checks the same current authorization. Project, ownership, Team, App, grant, connection and pending locks follow one order, with no network request inside the transaction.

The App executor borrows its client only after a confirmed claim and releases it after all use. The provider owns client resources, while the database owns authorization. Unknown claims stop without replay and recover by lease expiry. A single App runner bounds scans and concurrency across Apps and exposes unexpected termination to readiness and supervision. The [execution design](../../../../docs/design/github-app-execution.md) owns the mechanisms and lifecycle contract.

The fixed App constructors and lease predicate retain their behavior. Both execution modes use the same synchronization algorithm through explicit work, snapshot and remote capabilities; each admission path retains its own authorization responsibility.

## Alternatives

**Add App and grant requirements to the existing lease predicate.** Existing global connections have no independent App identity. This would change their behavior before the public configuration, connection and data transition is delivered.

**Adapt the fixed App Store to independent Apps.** This would make current authorization depend on assumptions hidden in an older admission component and complicate removal of that component. A dedicated work scope makes the required identity explicit.

**Duplicate the complete synchronization algorithm.** Polling, hint acknowledgement and repository identity handling would have two owners. Shared execution mechanics preserve these rules while keeping authorization and client acquisition explicit.

## Consequences

Revocation, credential changes and ownership changes cannot authorize publication by an earlier execution, including repository observations and hint mutations. Every short work transaction incurs authorization reads and locks. An unknown claim can delay that Project until lease expiry. Requests that crossed a checkpoint before revocation may still reach GitHub, but their results remain fenced.

The components are independently constructible and tested. Their public runtime adoption remains a separate coordinated change; the existing fixed App path retains its original authorization guarantees until that adoption.
