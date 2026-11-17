# Agent Note: Personal Owners in GitHub App Grants

Status: implemented

## Problem

App administrators cannot distinguish Personal Teams in grant management when each is labeled only as a Personal Team and a Team UUID. The actor managing an App is not necessarily the owner of the Team being granted access.

## Decision

Grant-specific Team references include the actual Personal Team owner's user UUID and nullable name, obtained through the existing database relationship. Ordinary Teams explicitly have no personal owner. The canonical Team name remains null for Personal Teams. The [grant design](../../../../docs/design/github-app-team-grants.md) describes the projection, display and access boundaries. This extends the [grant decision](2026-11-16-github-app-team-grants.md), which avoided a global Team directory and private Project disclosure.

## Alternatives

**Keep the generic Personal Team label.** This avoids reading owner data but leaves administrators unable to identify the grant target without separately resolving a UUID.

**Expose a general user or Team directory.** A broader directory would disclose more personal information and require access rules beyond grant administration. The grant projection needs only the owner's UUID and name.

## Consequences

App administrators can distinguish grant targets without gaining Team membership or Project access. Owner names are personal data exposed within the existing App administrator grant boundary; email and avatar are excluded. A missing owner is an integrity failure rather than a fabricated identity or silently omitted grant. Names may be absent or duplicated, so the owner UUID supplies the fallback and the Team UUID remains visible.
