# Agent Note: Canonical Microsoft Identity Keys

Status: implemented

## Problem

An external identity key selects the local user that owns credentials, Team
membership and Projects. A change to Microsoft's upstream key spelling would
otherwise create another user, leaving the original user's resources with the
old account. Both gateway versions must identify the same local account during
the format transition.

## Decision

Microsoft keys use `msft:<oid>@<tid>` internally. The Identity service accepts
that form and `microsoft:<tid>:<oid>` after existing profile capacity admission,
then invokes the Core Identity conversion before opening the user transaction.
Both components must be nonempty and contain neither `:` nor `@`; ambiguous
keys are rejected as upstream identity errors. Other external identity keys
remain opaque and retain their original values.

Migration 064 converts stored Microsoft keys while preserving local user UUIDs,
profile timestamps, credentials and resource ownership. Malformed Microsoft
keys fail validation; existing target keys fail the unique constraint. Either
failure rolls back the migration without automatically merging accounts. The
[authentication design](../../../../docs/design/daynight-auth.md#uniauth-一次性交接)
owns the complete conversion and upgrade contract. This refines the full-key
mapping recorded in the historical
[identity foundation decision](../../archived/architecture/2026-10-22-identity-credentials.md).

## Alternatives

**Normalize only in UniAuth.** Daynight would receive a different key after the
gateway upgrade and create another local user. Migrating stored keys alone
would also break logins while the original gateway output remains active.

**Convert only while reading the local user.** Alternate stored spellings could
still represent one external identity as different rows. Canonicalizing before
the unique-key write preserves one persistent key for each Microsoft identity.

**Retain only the object ID.** The same object ID in another tenant must remain
a distinct identity. The canonical format includes both components and the
provider prefix.

## Consequences

Daynight can be upgraded before UniAuth, accepting either gateway output without
changing the local account. Old Daynight instances must stop before migration
so that they cannot reintroduce the old key spelling. A malformed stored key or
an existing canonical-key collision requires data correction before startup;
neither condition is silently repaired. Microsoft provider selection remains
`microsoft`; the `msft` prefix belongs only to its identity key.
