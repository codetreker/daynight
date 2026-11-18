# Agent Note: Project Administrator Candidate Search

Status: implemented

## Problem

Project administrators need to discover registered accounts by partial name or
email. A Project administrator can have an independent grant without membership
in its owner Team, so Team directory authorization cannot cover Project management.

## Decision

An effective Project administrator can search registered account profiles through
a read-only POST. Inherited, independently granted and Personal Project access
use the existing effective-role calculation. Each page revalidates the actual
credential and Project authority in the same snapshot as the directory query.
Snapshot completion failures suppress all results.

Team and Project searches share a neutral account-candidate DAO and profile model.
The Team cursor format remains unchanged; Project cursors bind their own resource,
user, credential, normalized query and page size. Neither cursor grants access.
The [requirements](../../../../docs/spec/daynight-auth.md#项目管理员候选搜索)
and [design](../../../../docs/design/daynight-auth.md#项目管理员候选搜索) own
the public contract and implementation. The existing
[Team decision](2026-11-17-team-member-candidates.md) retains its authority rules.

## Alternatives

**Require Team administration.** Independent Project administrators and ordinary
Team members promoted only within a Project would lose account discovery despite
having authority to manage that Project.

**Reuse the Team endpoint or cursor.** Team identity and authority do not establish
Project authority. Independent cursors prevent accidental resource substitution
while sharing the database query without embedding authorization in SQL.

**Add a substring index or retain cross-page snapshots.** Existing UUID ordering
supports seek pagination. No workload evidence establishes a useful additional
index, and this search does not require persistent snapshot state.

## Consequences

Effective Project administrators can discover service-wide account profiles;
results do not prove membership or authorize a later write. Each page uses current
facts, so account changes can alter later matches. Materialization is bounded by
the page limit, while low-selectivity literal matching can scan many users and
profile sizes can produce large responses. Query plans and actual workload must
inform any future indexing decision. Query text, cursors and profiles remain
excluded from diagnostics.
