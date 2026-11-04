# Agent Note: Project Ownership Transfer

Status: implemented

## Problem

A Project needs to move between Teams without changing its identity or copying
independent grants and invitations. The source administrator must confirm both
ownership and destination metadata, including when ownership changes away and
back. Team deletion and Thread admission must remain correct during the move.

## Decision

The service exposes a minimal destination preview and a versioned transfer to
current owner Team administrators. The destination need not contain the actor.
Preview reads one snapshot; transfer checks the actor before domain SQL, locks
Project, ownership, then both Team rows in UUID order, and rechecks authority
and exact versions. A same-owner transfer verifies the same observations without
writing. A real transfer advances ownership and Project update time, preserving
Project grants and invitations. The committed receipt includes nullable actor
access calculated within the transaction. An unconfirmed commit or lost response
is unknown, including when a later Project read returns 404.

Thread admission locks ownership before reading the destination Team in a new
statement. A waiting Read Committed statement can return an updated ownership
row but retain an older snapshot for its joined Team; the new statement uses the
stable team ID after the lock. Source member and grant locks retain their existing
order. The [Team lifecycle decision](2026-11-04-team-lifecycle.md) owns the
complementary deletion existence check, and the [Personal ownership decision](2026-11-04-personal-project-ownership.md)
retains the original source and migration rationale. The
[authentication design](../../../../docs/design/daynight-auth.md) owns the current
transaction and API contract.

## Alternatives

**Copy Team members into Project grants.** This would make transfer alter
independent grants and require later reconciliation. Calculating access from real
sources preserves the existing grant identities and versions.

**Join the destination Team while locking ownership.** PostgreSQL can recheck a
waited ownership row against its updated version while retaining the statement's
older snapshot for the joined Team. Reading the Team after the ownership lock
avoids a false integrity error without taking a Project lock in Thread admission.

## Consequences

The transfer receipt remains usable after the actor loses Project access, while
an unknown result cannot be reconstructed from current state. The Team locks
serialize transfer with rename and deletion; cross-Team transfers acquire them
in a stable order. Destination metadata is exposed only to a source administrator
who supplies its UUID, with no Team directory or search. Client commands and UI
remain separate capabilities.
