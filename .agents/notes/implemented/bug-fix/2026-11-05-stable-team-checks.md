# Agent Note: Stable Team Checks

Status: implemented

## Problem

An identity check can cause a previously loaded Team directory to lose later
pages and replace an already confirmed Team workspace with loading. Users lose
menu position and focus even when the account and all returned data are unchanged.
A retained display must still observe real membership and data changes.

## Decision

Revalidate the complete loaded directory prefix from the first page with fresh
cursors, publishing it atomically after success. Preserve equal results and
invalidate an older revalidation when pagination supersedes it. Resume interrupted
initial and pagination requests after admission returns. A real failure retains
loaded entries and exposes a retry; explicit refresh continues to read.

Keep the confirmed preference ready while its same target is checked by exact
GET. Confirmed Team and membership versions are reconciled independently so a
late read or receipt cannot regress either. Identity, scope, navigation and
storage arbitration still govern publication and trusted 404 fallback; guarded
operations retain their outcomes while confirmed denial isolates private content. This extends the [browser preference decision](../../archived/feature/2026-11-04-browser-team-preference.md)
without treating an incomplete directory as proof of access or revocation.

## Alternatives

**Reload only the first page.** This does perform a fresh read but discards
loaded pages and interrupts interaction when nothing changed.

**Keep the snapshot without revalidation.** This avoids disruption but leaves
real membership, role and name changes unobserved until a later explicit action.

## Consequences

Background checks may read multiple pages and publish only after the prefix is
complete. A failure can leave older content visible alongside a recoverable error;
that content does not authorize requests or writes. A concurrent page request
supersedes the older read so it cannot roll pagination back.
