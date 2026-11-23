# Agent Note: Task Read Scope Projections

Status: implemented

## Problem

Task queries combine task content, project settings and Session observations.
Independent credential permissions need to preserve task queries and their
pagination while preventing those combined responses from revealing other
resources. Existing CLI readers require complete, strictly parseable observation
objects even when Session facts cannot be returned.

## Decision

Explicit scoped task services and protocol registrations share the existing
queries. Admission checks task-read permission after resource visibility and
before task content, search fences or observation sources are read. Production
assembly uses the scoped constructors and registrations. Read, search and
mutation registrations compose in the same protocol host; scoped MCP registrations
own disjoint tool sets so enabling writes cannot duplicate the read tools.

Full Graph and Sync require project-read permission. A negotiated REST task-only
Graph and the MCP Graph fallback contain only the project ID, including dependency
views. Full observed Graph carries its project-read requirement in a request-local
service copy. Initial admission and fresh snapshots after live sampling check the
current credential for that requirement alongside task-read and sampled
Session-read permissions. A refusal discards the entire response; a later
task-only call on the same service retains its independent requirements. Other
task relationships and statistics retain their original meaning.

Without Session-read permission, services construct unavailable observations from
task facts before reading Session sources or sampling live state. Execution-owned
task properties are removed from output copies. Aggregates count visible active
tasks as unknown before pagination; no real Session presence, count, identity,
state or time contributes to the response. Sync retains the complete active-task
observation key set independently of its task update window.

The [internal contract](../../../../docs/design/credential-scope-internal.md)
owns operation requirements and wire projections. The
[observation design](../../../../docs/design/task-session-observation.md) and
[sync design](../../../../docs/design/daynight-task-sync.md) own their mechanisms.

## Alternatives

**Reject implicit Session expansion.** Existing CLI task queries request Session
observations automatically. Rejecting those requests would prevent ordinary task
reads despite task-read permission. Parseable unavailable observations preserve
task results and the existing partial-result behavior.

**Filter observations after sampling.** That would still query protected sources
and let source failures, timing and actual execution facts influence responses.
Permission determines the observation path before source access.

**Require project-read permission for every task query.** Basic task operations
need resource visibility, not access to project settings. Restricting only full
Project responses keeps task-only credentials useful without expanding access.

## Consequences

Task pagination and snapshot completion remain authoritative. Grouped unknown
counts describe tasks within the existing aggregation scope; they do not count
Sessions. Legacy CLI clients can parse unavailable observations and retain their
partial-result exit status. Candidate clients can negotiate a minimal project
representation. Independent Session APIs retain their own direct admission.

The APIs depend on explicit authenticated authorization snapshots. Production
authentication supplies those snapshots; the [activation decision](2026-11-21-credential-scope-activation.md)
owns coordinated issuance, route classification and migration.
