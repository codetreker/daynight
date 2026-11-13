# Agent Note: Web Task Tag Cache

Status: implemented

## Problem

Task tag names and associations can change independently of other Task content.
Web readers and cached summaries must agree on their current identity and name,
including after an existing browser database is upgraded. An incomplete or
same-version conflicting representation cannot safely drive detail admission.

## Decision

Web Task details, summaries and search results require tag references. The shared
parser validates their identities and names, and summary equality includes the
references. Graph tasks retain their narrower graph representation. Task cache
schema 12 clears incompatible project, summary and detail projections before
parsing; identity, profiles and compatible Session history retain their existing
upgrade rules. A normal versioned delta updates affected summaries and invalidates
their details without rotating the Task cache epoch. The
[task synchronization design](../../../../docs/design/daynight-task-sync.md)
owns the cache and admission mechanisms.

## Alternatives

**Default missing tags to an empty list.** This would make an incompatible cached
record indistinguishable from a confirmed empty association and could admit a
stale detail at the same version.

**Reset the whole project cache on tag changes.** Ordinary Task versions already
identify affected entries; rotating the epoch would discard unrelated projections
and refetchable Session history for a normal rename or deletion.

## Consequences

The server must provide the required field before deploying this reader. An
upgrade rebuilds derived Task projections from a snapshot, while ordinary tag
changes preserve unrelated cached entries. The separate project tag catalogue and editing interface use their own
project-scoped, in-memory reads; they do not extend the Task cache.
