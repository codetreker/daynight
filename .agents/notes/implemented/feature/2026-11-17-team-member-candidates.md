# Agent Note: Team Administrator Candidate Search

Status: implemented

## Problem

Team administrators need to discover existing accounts by partial name or email
without initializing another account or knowing an external identity. A Team's
member directory cannot find accounts outside that Team.

## Decision

An ordinary Team administrator can search existing account profiles through a
read-only POST. Each page checks the current credential and administrator in the
same snapshot as the query. Results contain account IDs and nullable profiles,
not membership facts. ASCII-folded literal substring matching and UUID keyset
pagination provide bounded materialization; a scoped cursor identifies the
query and position but does not confer authority. The [requirements](../../../../docs/spec/daynight-auth.md#team-生命周期)
and [design](../../../../docs/design/daynight-auth.md#team-管理员候选搜索) own
the public contract and implementation boundaries.

## Alternatives

**Reuse external identity resolution or direct addition.** Resolution requires a
known identity and only finds existing Team members; direct addition can create
an account. Neither provides discovery without changing its existing contract.

**Index substrings or keep a cross-page snapshot.** No account-scale or latency
measurement established a need for a text index. A persistent snapshot or global
epoch would add storage and coordination for a guarantee the search does not
require. Each page instead uses current facts and reauthorizes.

## Consequences

Ordinary Team administrators can discover profiles across the service, including
accounts outside their Team. A caller can create such a Team, so this is not an
organization-limited directory. The query can scan the user table, and legal
profiles can make a page large; item limits do not bound scan or response bytes.
Changes between pages may shift matches before the current position. Search
input, cursor and profiles must stay out of diagnostic logs. Index selection
requires evidence from actual workload and plans.
The [Project search decision](2026-11-18-project-member-candidates.md) shares
the neutral account query while retaining separate authority and cursor formats.
