# Agent Note: Add Existing Team Members by Local ID

Status: implemented

## Problem

An administrator who discovers a registered account needs to add that exact
account without initializing an identity or changing an existing membership's
role. Profile values and authority may change between discovery and the write.

## Decision

The local UUID endpoint checks current credentials and ordinary Team admin
access in a single Team write transaction, reads the stored profile and member
relationship, inserts a missing relationship as member, and refreshes webhook
eligibility before rechecking the credential. Existing relationships of either
role return unchanged. A missing account has a distinct rejection, and only a
confirmed commit returns a receipt. The [requirements](../../../../docs/spec/daynight-auth.md#team-生命周期)
and [design](../../../../docs/design/daynight-auth.md#按本地-uuid-添加既有-team-成员)
own the public contract and transaction details.

## Alternatives

**Reuse external identity addition.** That operation can initialize an account
and rejects an existing relationship with a different role. Changing it would
break its established contract and cannot guarantee a selected local identity.

## Consequences

The receipt contains the current stored profile and membership, while concurrent
additions converge under the Team lock. Existing Project grants, Team metadata,
Personal Teams and invitation state remain independent. Unknown commit outcomes
and lost responses cannot be replayed automatically.
