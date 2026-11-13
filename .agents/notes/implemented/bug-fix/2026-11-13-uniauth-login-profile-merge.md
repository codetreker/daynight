# Agent Note: Preserve Missing UniAuth Login Profile Fields

Status: implemented

## Problem

UniAuth can return null for a profile field it did not obtain. Replacing the
stored profile with that response loses previously saved information, including
local edits. Email verification describes a specific email address, so retaining
the old verification value when the address changes would misrepresent the new
address. Separately valid incoming and stored profiles can combine into a profile
whose JSON encoding exceeds the permitted capacity.

## Decision

Native login merges the incoming profile in its single PostgreSQL upsert against
the current conflict row and returns the resulting user. Null name and avatar
preserve the stored values; non-null strings replace them. Null email preserves
both stored email and verification. For the same email, a non-null verification
value replaces the old value, including false; null preserves it. A changed email
stores the incoming nullable verification value. New users retain the admitted
incoming nullable values. Identity and account associations remain independent
of email.

The service admits the original upstream profile before the write transaction,
then validates the merged profile and actual public user representation in the
strict user, Personal Team and session transaction. A final admission failure
rolls back that transaction. The earlier atomic consumption of the login pending
remains committed, requiring a new login. The
[authentication design](../../../../docs/design/daynight-auth.md#uniauth-一次性交接)
owns the detailed limits, error mapping and transaction sequence. This partially
supersedes the login replacement behavior recorded in the
[user initialization and profile update decision](../feature/2026-11-12-user-profile-patch.md);
explicit PATCH still distinguishes omitted fields from null clears, and
EnsureUser still preserves existing profiles.

## Alternatives

**Replace every field with the incoming profile.** This loses stored information
when UniAuth does not provide a field, even though the identity is valid.

**Read the existing profile and write a merged replacement.** A concurrent PATCH
could commit after the read, and a complete replacement would overwrite its
updates. Merging against the locked conflict row preserves the database's
serialization order.

**Validate only the incoming profile.** A separately valid stored field and
incoming field may together exceed the encoded profile limit. Validation of the
actual merged result must occur before the transaction can commit.

## Consequences

Missing upstream fields no longer erase existing values, while supplied fields
can still replace local edits. Changing email with no verification value clears
the old verification fact rather than assuming either true or false. Row-lock
contention and final encoding remain within the operation deadline. An invalid
merged representation prevents a session and rolls back user and Personal Team
writes, but cannot undo the separately committed one-time pending consumption.
