# Agent Note: Current Project Access Projection

Status: implemented

## Problem

A complete member directory mixes profile display, stored grant observations and
the caller's current authority. Resource controls need current authority even when
profiles fail to load or membership facts change without a task edit. A delayed
response must not restore a prior account, project or authorization observation.

## Decision

GET project access and TaskSync expose the same required
`{effectiveRole,directGrant}` projection. The nullable grant contains only its real
project/user IDs, role, positive int64 version and timestamps. The current direct
source produces its actual grant; failed admission remains an error. Computed and
stored roles are read separately in one canonical statement. TaskSync retains its
existing admission result inside the same read snapshot as project and task data,
including empty deltas. Existing [grant transactions](2026-10-22-project-membership.md)
continue to read direct facts for mutation and invitation no-ops.

One identity/project-bound memory provider consumes successful sync observations
and explicit access reads. The existing five-second sync refreshes ordinary graph
pages. Other pages use a visible thirty-second fallback; focus, visibility restore
and management entry revalidate. Concurrent GETs coalesce. Request-start ordering,
identity and project lifetime fences reject older observations, and management
revalidation stays blocking until a fresh result. Before the access HTTP request,
the existing cache lifecycle prepares a real persisted/in-flight generation ticket,
including cold scopes without an online projection. Current trusted denial retires
that captured generation through the existing revocation fence, so a delayed delta
cannot reauthorize cached private details. Replacement generations reject stale
denials. Lifecycle or storage preparation errors remain visible and block
management until retry; network errors preserve their separate meaning.

Member/settings resource reads retain independent loading, failure and retry
ownership. Confirmed access withdrawal invalidates their pending read generation
or lifetime before a late response can republish private content, with an
unavailable render guard as well. This does not cancel accepted writes or erase
unknown outcomes. Temporary access failure cannot discard the only recoverable
resource result or retry path; successful authority refresh must expose a usable
resource or start a fresh read without replacing a valid settings draft.

Access stays outside persistent Project and Task records. Existing member reads
retain claim-owner name/email, loading, failure/retry and former-member display;
the caller's controls use access independently. Nested grant versions are decoded
losslessly only at their declared protocol path, preserving opaque task-property
JSON values. The [auth design](../../../../docs/design/daynight-auth.md) and
[task-sync design](../../../../docs/design/daynight-task-sync.md) own the complete
public and lifecycle contracts.

## Alternatives

**Infer the caller's authority from the member directory.** This transfers all
profiles for a single role and makes control availability depend on a display
resource. It also confuses stored grant facts with the effective decision.

**Fetch access independently on every graph refresh.** This adds a request and
can pair role with a different snapshot. The existing successful sync already has
the required admission result.

**Capture only the currently authorized in-memory manifest.** This avoids a
storage read for role-only pages, but a cold scope can have persisted details and
an in-flight delta without an authorized memory projection. A later denial would
then leave that generation eligible for publication. Reusing the existing
lifecycle ticket before HTTP preserves the denial boundary without another cache
format or a synthetic generation.

**Persist access alongside task summaries.** A reusable content cache would then
appear to authorize operations after membership or identity changes. Keeping the
projection in its current identity lifetime preserves separate content and
permission ownership without a cache-format migration.

## Consequences

Current controls share one live role source without requesting a directory just
for self-role checks. Profile errors remain observable without authorizing or
suppressing an otherwise valid claim operation. Freshness failures disable
role-dependent submission until revalidation, while every server request still
authorizes independently. The access endpoint, sync codec and actual CLI/Web
consumers change together; member JSON and direct-grant transaction policies stay
with their existing owners.
