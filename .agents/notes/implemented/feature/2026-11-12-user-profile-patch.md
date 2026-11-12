# Agent Note: Complete User Initialization and Sparse Profile Updates

Status: implemented

## Problem

Backend callers need to obtain one complete local account for an exact external
identity without replacing its existing profile. People also need to change
their own name or avatar while preserving independent concurrent updates,
identity fields and the canonical Personal Team. A credential can expire while
the update waits for the user row, and a partial account or an unconfirmed commit
cannot authorize a subsequent operation.

## Decision

Identity exposes strict EnsureUser and PatchUser operations within its existing
transaction scope. EnsureUser uses the external identity's unique key and
read-committed insert-or-read: INSERT with ON CONFLICT DO NOTHING RETURNING,
then an exact-key SELECT in the next statement on conflict. Both branches return
the actual user. The inserted flag describes only the current transaction's
candidate, while the service returns a complete account only after confirmed
commit. User, Personal Team and owner admin initialization share that transaction.
Existing profile fields are preserved and native UniAuth login keeps its upstream
profile replacement behavior.

PATCH /api/v1/me carries field presence separately from nullable string values.
The DAO updates only submitted profile columns and updated_at; its natural row
lock serializes writers without overwriting omitted fields. The strict identity
transaction validates the complete profile and Personal Team and rechecks the
credential with fresh time after the user-row wait. Native credentials use
a dedicated IdentityDAO reader check using FOR SHARE. This admits sibling
credential readers while excluding revocation and expiry writes. Finite expiry
is rechecked after acquiring the credential lock against database and application
time. The injected same-transaction family DAO checks the fixed API
tuple for internal API principals, preserving the existing oauth-to-identity
implementation dependency direction. Public OAuth admission keeps its existing
scope.

The [authentication design](../../../../docs/design/daynight-auth.md#完整用户初始化与本人资料更新)
owns input, encoding, transaction and response contracts. The
[Identity boundary decision](../architecture/2026-11-05-server-identity-boundaries.md)
owns the existing Core, service and HTTP separation. Normal assembled API proof
uses real Cookie/PAT authentication and persisted reads; mechanism tests own
expiry, contention, capacity and completion failures.

## Alternatives

**Reuse native login upsert for initialization.** It would replace stored name,
avatar and email from a caller whose purpose is only to ensure account existence.
The exact external key must identify the account without changing existing data.

**Read the profile and write its complete replacement.** Independent updates
could overwrite omitted fields observed before another writer committed. Sparse
SQL preserves each field's update intent without requiring a new CAS version.

**Reuse the device operation runner.** That runner can commit useful device
writes alongside domain refusals. Profile and account initialization require
complete rollback on those failures, so they use strict completion handling.

**Reuse the PAT management UPDATE lock.** A profile write can hold PAT B while
waiting for its user row. A TestSession registration retry under PAT A can hold
that user row while checking the original PAT B with a shared lock. An exclusive
PAT lock closes that cycle and lets PostgreSQL abort a valid request. Profile
admission therefore uses a shared native reader capability; PAT management keeps
its existing exclusive lock.

## Consequences

Callers receive a complete, validated account or a visible error; unknown commit
outcomes stop successor work. Profile updates retain nullable values and the
existing user representation. An extra credential check prevents expiry during
user-row waits from committing the update, while the API family accessor remains
bound to the transaction that updates the user. Row contention and the final
profile encoding remain within the operation deadline. Native login remains the
authoritative source of upstream profile replacement, so a later login can
replace locally edited name and avatar values.
