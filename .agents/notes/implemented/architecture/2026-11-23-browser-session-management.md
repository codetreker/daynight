# Agent Note: Browser Session Management

Status: implemented

## Problem

An account owner needs to identify and end an individual browser login without
invalidating unrelated credentials. A stale page must not revoke a session after
its own browser identity has changed, and a delayed operation must not revive or
authorize an expired session. Historical sessions have no reliable device data.

## Decision

The account credential API lists active browser sessions with the current session
separate and pages the rest by creation time and ID. A cursor is scoped to the
account and calling session. New logins store bounded browser and operating
system classifications; raw user agents and IP addresses are not stored, and
historical unknowns remain null. Only the main-site session Cookie admits these
operations; writes also require the exact Origin.

Revocation binds the expected account and calling session, locks caller and
target in a consistent ID order, and checks validity using the primary clock
after locking. It deletes only the target shared session, so its main-site and
preview credentials and subsequent authorization checks stop together. Current
session logout remains a separate operation. An unconfirmed commit is resolved
by reading the target, not replaying the write. The [authentication design](../../../../docs/design/daynight-auth.md#主站-session-与-pat)
owns the protocol and transaction details; the [activity decision](2026-11-23-browser-session-activity.md)
owns renewal and its lock-after-time guarantees.

## Alternatives

**Store the raw user agent or network address.** These fields expose more client
information than the device label needs, and older sessions cannot reliably be
reconstructed from them.

**Lock caller first and target second.** Two sessions revoking one another can
take the locks in opposite order. Sorting the IDs gives both transactions the
same order while retaining the validity checks needed after waiting.

**Revoke all sessions together.** The confirmed scope requires individual
revocation and does not include bulk logout; a separate capability would need
its own interaction and concurrency contract.

## Consequences

Account owners can inspect and revoke individual sessions without disclosing
credentials or changing PAT and OAuth lifetimes. Unknown historical device data
remains unknown. The account/time index adds storage and write cost to session
issuance; expiry and credential hash indexes retain their existing roles.
