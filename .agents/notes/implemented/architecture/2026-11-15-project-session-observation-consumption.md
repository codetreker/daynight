# Agent Note: Project Session observation consumption

Status: implemented

## Problem

The sparse Session map used by chain and Goal summaries does not distinguish an
absent current execution, an unregistered Session, a failed observation or an
expired observation. Project Task rows need those distinctions and a separately
verified reading entry. A late response can also refer to an older Task version
or execution, while database Task times and Session Engine times can differ.

## Decision

Project Task rows consume the complete TaskSync observation in a page-local
store independent of the existing sparse summary store. Admission binds the
current principal, project, cache generation, epoch, in-progress ordinary Task,
exact Task version and nullable execution binding. Missing or mismatched
observations display as unobserved, not as an absent execution, and cannot retain
an old entry. Individual or whole-read failures display unavailable; a successful non-unavailable
observation past its deadline displays expired. Whole-read failure is scoped to
the currently authorized project and is cleared on loss of admission. The independent,
chain-member and Goal-member rows use this data and a separate Session action;
chain and Goal headings keep the existing summary and aggregation rules.

The body receipt's monotonic time advances both server response clocks in their
own domains. The database clock determines the Task's 120-second warning grace;
the Engine clock determines each observation's expiry from its freshness and
observation times. Warning suppression does not revoke a separately confirmed
entry, while expiry and loss of admission do. The [Session status design](../../../../docs/design/task-session-status.md)
owns the detailed display and lifecycle rules. The [complete observation decision](2026-11-15-task-sync-complete-observations.md)
owns the server protocol; the [list admission decision](2026-11-08-task-sync-session-list.md)
retains the separate sparse summary's original rationale.

## Alternatives

**Reuse the sparse summary store for all rows.** Its web-only eligibility and
missing-key semantics cannot represent no execution, Herdr, unavailable or
expired without changing chain and Goal aggregation.

**Read Current for every row.** Per-Task requests duplicate the project sync,
add authorization and scheduling work, and do not provide the same project
snapshot binding. The batch response carries the necessary facts once per sync.

**Use receipt time as the Session observation time.** Early samples in a batch
and the final server recheck may precede receipt substantially; treating them as
new would extend stale entries. The Engine response anchor preserves the age of
each sample while the database anchor keeps Task age in its own clock domain.

## Consequences

The complete and sparse projections require independent admission and lifecycle
handling but share the existing project request and body receipt. Session-only
updates remain in memory and do not write Task data or invalidate detail bodies.
Per-sample deadlines and startup grace require a shared local timer; visibility,
authorization and execution changes can withdraw an entry without a new row
request. Processing and transport between server anchors and body receipt remain
an error in the client clock estimate, rather than a claimed elimination of delay.
