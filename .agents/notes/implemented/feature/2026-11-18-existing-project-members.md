# Agent Note: Add Existing Project Members by Local ID

Status: implemented

## Problem

Project administrators need to grant an existing account access directly without
changing Team membership, invitations, or an account's existing access. Authority
and access sources can change while the request waits for concurrent writes.

## Decision

A separate local-ID operation grants only member access after checking current
credentials and effective Project administration. Existing access from either
source returns its actual participant unchanged. A narrow transaction coordinates
Project, ownership, Team and credential locks, and commits a new grant and webhook
eligibility together. The [specification](../../../../docs/spec/daynight-auth.md#项目成员与邀请)
and [design](../../../../docs/design/daynight-auth.md#项目准入与独立授权) own the contract and locking details.

## Alternatives

**Extend grant management.** Its existing create precondition requires a current
participant and permits an admin role. Changing it would alter established client
failure and authorization semantics; the [original decision](../../archived/architecture/2026-11-04-project-grant-management.md)
retains that rationale for grant management.

**Use invitations.** Acceptance requires the recipient to act and cannot provide
the requested immediate grant to a selected registered account.

## Consequences

The Project and Team roots serialize relevant access changes even when a target
member row does not exist. A later Team membership may add a second source;
existing grants and roles remain unchanged. An unconfirmed commit cannot be
replayed automatically, and a later read cannot recover its receipt.
