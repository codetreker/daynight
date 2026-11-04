# Agent Note: Web Scoped Invitation Management

Status: implemented

## Problem

Team and Project administrators need to issue and revoke bearer invitations in
its actual scope without exposing a reusable secret in a directory or confusing
Team membership with a Project grant. A recipient also needs to enter the Team
that a confirmed acceptance actually joined.

## Decision

The Team members and Project grants hosts manage their own invitation metadata,
using their respective authorization and service routes. A creation receipt is
the only source of the one-time link; the result dialog keeps it in memory until
closed. Unconfirmed writes are not replayed, and a fresh list observes current
metadata without proving the original outcome. The existing
[Team receiver](../architecture/2026-11-04-team-invitations.md) retains its
login and acceptance lifecycle. Its confirmed receipt links to the real Team
route, where the existing account-scoped Team preference validates and saves the
selection. Project acceptance continues to enter the original Project.

## Alternatives

**Keep the Team receipt's return-to-projects action.** This leaves a successful
recipient in an unrelated remembered context and requires manually locating the
Team. The confirmed Team ID already identifies the correct workspace.

## Consequences

Lists cannot recover a lost link, and an unknown creation requires review of the
current metadata before another action. Personal Teams cannot issue Team links;
their Projects retain independent invitation management. Neither host searches
for recipients or accepts on another person's behalf.
