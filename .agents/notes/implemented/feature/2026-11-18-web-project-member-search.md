# Agent Note: Web Project Member Search

Status: implemented

## Problem

Project administrators need to find an existing account and grant access without
an invitation or Team membership. A delayed or missing write response cannot
establish the current roster, and permission may change during the operation.

## Decision

The Project members panel shares candidate presentation and pagination with
Team search, while its independent addition operation retains its identity and
Project scope across navigation. A complete roster identifies existing access.
The [Project settings specification](../../../../docs/spec/project-settings.md)
and [Web design](../../../../docs/design/daynight-web.md) own the interaction,
observation ordering and recovery rules. The [server addition decision](2026-11-18-existing-project-members.md)
owns the direct grant transaction.

## Alternatives

**Use invitations for existing accounts.** The recipient would still need to
accept, so the administrator could not provide immediate access.

**Unlock after reading the roster.** Current presence or absence cannot prove
whether the original write committed; another request could duplicate an
unresolved operation.

## Consequences

An administrator can add a selected account without changing Team membership.
An unknown result prevents another direct addition in the same Project and
identity session even after a roster check, while existing grant and invitation
operations remain available. A new roster observation takes precedence over a
late receipt; recovering permission requires fresh candidate reads.
