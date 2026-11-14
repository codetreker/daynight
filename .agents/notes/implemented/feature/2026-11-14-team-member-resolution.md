# Agent Note: Resolve Existing Team Members by External Identity

Status: implemented

## Problem

An administrator reconciling a known external identity with a Team cannot obtain
the membership ID and version from a different-role direct-add conflict. The
member directory does not expose external identities, and guessing from profiles
cannot establish the mapping.

## Decision

An ordinary Team administrator can resolve one external identity through a
read-only POST. The existing identity validator canonicalizes the key. A locked
Team transaction checks the current user credential and administrator, reads
only an existing identity and its membership in that Team, rechecks credential
validity and confirms transaction completion before returning. Missing identity
and missing membership have the same null result. The request creates no account,
credential or membership and does not disclose the key in the response.

The [requirements](../../../../docs/spec/daynight-auth.md#team-生命周期) own
the public contract and the [design](../../../../docs/design/daynight-auth.md#按外部身份解析-team-成员)
owns its transaction boundary. The [direct-member decision](2026-11-13-direct-team-members.md)
retains its initialization and conflict behavior.

## Alternatives

**Return a membership in the direct-add conflict.** This would change the
existing error contract and couple an identity lookup to a membership write.
The separate read preserves direct-add behavior and does not initialize users.

## Consequences

The caller can obtain the actual membership version without changing the target.
The result is a point-in-time fact, not authorization for a later write; the
existing role update must recheck authority and compare the observed version.
The endpoint does not provide general identity search or prove the caller's
external identity evidence.
