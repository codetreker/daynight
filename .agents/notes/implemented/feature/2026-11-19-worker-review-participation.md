# Agent Note: Independent Worker review participation

Status: implemented

## Problem

Accounts need persistent control over which Workers may become PR review
candidates. A manual preference must survive reports from installed Workers and
must be editable while a Worker is offline. Concurrent edits must expose stale
observations without changing execution configuration or online status.

## Decision

Store `review_enabled` and `review_version` on the account-owned Worker row,
defaulting to false and 1 for both migrated and newly registered Workers.
Expose an independent authenticated GET/PUT resource with exact decimal version
strings. Core computes changes; the DAO applies an owner-scoped version CAS,
including unchanged writes. Actual changes increment the version, and version
exhaustion refuses changes without preventing a matching unchanged write.

The [resource design](../../../../docs/design/worker-review-participation.md)
owns the HTTP contract, module boundaries and validation responsibilities.

## Alternatives

**Include the preference in Worker configuration.** This would couple a
server-managed review candidate preference to installed Workers' configuration
validation and target revisions. Independent columns and a resource preserve
those existing protocols and their write ownership.

**Extend Worker reports or directory responses.** Reports describe observed
runtime state, while this preference belongs to the account. Adding an
unnegotiated field to existing responses also breaks strict installed parsers.
The independent resource can be adopted without upgrading reporting Workers.

## Consequences

Settings survive reports and configuration updates and remain readable outside
the directory's recent-activity window. Existing protocols and timestamps retain
their meaning. Consumers observe and submit a separate version, and stale
same-value requests can fail rather than conceal a concurrent edit. Reviewer
assignment and execution require their own consumers; saving the preference
alone does not start either operation.
