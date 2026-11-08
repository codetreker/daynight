# Agent Note: Claim Profile Recovery

Status: implemented

## Problem

Claim profile failures still described withdrawal permissions as unavailable
after authorization moved to ProjectAccess. A valid withdrawal control could
therefore contradict its adjacent error. The participant projection also changed
the members response consumed by already-open pages: retrying the same response
with an incompatible decoder cannot restore names. Shared profile observations
were matched only by project, allowing a different account scope to inherit a
previous account's profile snapshot before its effects ran.

## Decision

Profile loading and failures describe only the claim owner's details.
ProjectAccess remains the independent withdrawal authority, including its
refresh and principal fences. Profile snapshots and inherited providers match
both project and TaskCacheScope before rendering; canceled reads cannot publish.
The claim userId remains the lookup key, even when the assignee or viewer differs.

An unreadable response retains a safe request ID when the error supplies one
and explains possible page and service incompatibility without claiming that every protocol error proves a
stale page. The existing independent task URL opens in a new tab. The server's
no-store HTML entry selects current assets; the original document and drafts
remain intact. The UI tells the user to copy drafts before closing that tab and
report persistent failures. Explicit member retry remains useful for transient
failures and repaired responses, but never refreshes the document automatically.

The [Web design](../../../../docs/design/daynight-web.md#认领归属与强制撤回)
owns the presentation and recovery mechanism. The
[participant projection](../architecture/2026-11-04-project-participant-projection.md)
continues to own the single roster DTO and its strict decoder.

## Alternatives

**Accept old and new member DTOs.** This would add a compatibility authorization
shape without repairing already-running old code. The current participant
parser stays strict; invitation and grant DTOs keep their existing owners.

**Retry indefinitely or replace the page automatically.** A repeat request cannot
upgrade an old decoder, and replacing the document can discard discussion or
attachment drafts. A user-opened second document preserves the original state.

**Add a universal asset-version monitor.** The application has no such owner.
A new migration framework is unnecessary for this scoped recovery path and
would still not retrofit the already-loaded pre-monitor clients. The existing
task navigation and server HTML cache policy provide a bounded recovery route.

## Consequences

Profile errors remain visible without granting or withholding permissions.
Current participant responses pass through the real decoder and hook; transport
and protocol failures retain retry, and project/account changes cannot reuse
another scope's profiles. Tests distinguish absent participants from nullable
profiles and changed claims from changed viewers.

Old documents cannot acquire this new explanation without loading current code.
They can use the existing task menu's new-tab action, retaining the original
drafts. New-tab recovery cannot repair a persistently malformed service response
or an old service paired with a newer client. No automatic reload, draft transfer,
production claim mutation, or broad deployment-version compatibility is promised.
