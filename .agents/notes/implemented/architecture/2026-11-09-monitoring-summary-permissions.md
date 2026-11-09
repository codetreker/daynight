# Agent Note: Permission-Filtered Worker Monitoring Summaries

Status: implemented

## Problem

A Worker list needs actual admission reasons without fetching each complete
observation. Reasons may refer to projects or tasks whose current visibility
changes independently of the stored observation. The bounded Redis header cannot
expose private identifiers to the browser or replace a current permission check.

## Decision

The v2 stored summary contains bounded compact permission references and stable
reason indexes. A batch read admits Workers, reads their headers, rechecks the
Workers and referenced resources in a current snapshot, then filters and
deduplicates reason codes into a separate public summary. The public response
contains no references or hidden counts. The [monitoring contract](../../../../docs/spec/daynight-worker-monitoring.md)
owns the encoding and projection; the [design](../../../../docs/design/daynight-worker-monitoring.md)
owns their responsibilities. This extends the [current monitoring storage decision](2026-11-09-worker-current-monitoring.md),
whose single-key CAS, expiry and failure isolation remain in force.

The strict v2 format uses a write-drain and natural TTL barrier when old frames
may exist. The barrier preserves the original one-hour retention without a
migration or mixed-version parser; production use follows the documented
transition and its own authorization.

## Alternatives

**Fetch each complete observation for the list.** This would multiply reads and
load potentially large bodies to obtain a small summary, abandoning the bounded
header-only batch contract.

**Publish reasons without references.** Project- and task-scoped reasons cannot
be filtered against current access after storage, so this could expose private
facts or suppress valid visible reasons.

**Migrate or accept both stored formats.** Compatibility and reverse migration
would preserve short-lived snapshots across a release but add ongoing codec and
rollback complexity. A bounded monitoring interruption and natural expiration
satisfy the existing temporary-observation contract.

## Consequences

The header now holds private permission references and must remain inaccessible
to HTTP and logs. A second permission snapshot and whole-batch errors preserve
current projection at the cost of another database read. Old or corrupt frames
are errors until safely expired or otherwise resolved; a version transition can
interrupt monitoring for an hour plus deployment time without controlling the
Worker's business operations.
