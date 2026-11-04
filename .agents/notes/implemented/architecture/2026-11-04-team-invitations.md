# Agent Note: Team Invitations and Receiver

Status: implemented

## Problem

A person outside a Team needs a way to join without a global user directory or
an administrator adding an arbitrary identity. An invitation link must work
when delivered, including across login, and its result must reflect a confirmed
membership for the account that accepted it. Concurrent acceptance, revocation
and Team deletion must not leave a consumed link without its member or an
orphaned invitation.

## Decision

Ordinary Team administrators create single-use, seven-day bearer invitations.
Only a hash of the `dnteam_` secret is stored. The Team transaction orders
acceptance and revocation by locking Team then invitation; acceptance checks
validity before the real membership, preserves an existing role without
consumption, and commits a new member with consumption. Team deletion removes
its invitation children in the same transaction. The [Team lifecycle decision](2026-11-04-team-lifecycle.md)
retains existence locking and the [Project invitation decision](2026-11-04-project-invitation-results.md)
retains the independent Project grant contract.

The public `/team-invitations` entry captures and removes the fragment before
login or requests, retains the secret only for the existing short-lived login
flow, and confirms the current account before accepting. A confirmed receipt
shows the real Team name, ID and membership outcome with a safe return entry.
It does not depend on a Team workspace. The [authentication requirements](../../../../docs/spec/daynight-auth.md#team-邀请)
and [design](../../../../docs/design/daynight-auth.md#数据与并发) own the API and
secret lifecycle.

## Alternatives

**Wait for the Team workspace to provide the receiver.** An API-created link
would lead to an unusable page until a later delivery. A minimal receiver makes
the invitation capability usable while leaving final Team navigation to the
workspace that owns it.

## Consequences

The API and receiver must ship together. A lost write receipt remains unknown:
a later membership read cannot prove that the original acceptance committed,
and the client cannot replay it automatically. The minimal success view avoids
inventing a Team page; adding that page can replace the return navigation while
reusing the receiver. Invitation metadata cannot reconstruct a lost secret.
