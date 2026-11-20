# Agent Note: Session Producer Scope Admission

Status: implemented

## Problem

Session production spans registration, controller grants, live connections,
archives, images and usage uploads. Their short-lived credentials and persisted
records can outlive a policy change or a controller reconnect. A principal that
owns the same Session is not necessarily the credential that authorized an
existing grant or connection.

## Decision

Scoped Session and usage assembly uses current, transaction-bound authorization
of the actual PAT for `session:produce` at production boundaries. Task
registration checks its caller; an active Task connection checks its original
connection parent. Independent Test and Bot Sessions retain both the current
grant parent and the active connection parent. When these differ, each is
checked independently; equal IDs are deduplicated. Existing identity, validity,
resource and fence checks remain in force.

Usage grants retain their original parent and resource binding. Later production
and delivery recheck that parent rather than substituting a newer controller
credential. Existing persisted results and recovery receipts retain their original
completion semantics. Fixed profiles retain their own protocol restrictions.
The legacy production assembly remains in place until scoped authorization is
enabled. The [internal design](../../../../docs/design/credential-scope-internal.md)
describes the resulting admission contract.

## Alternatives

**Use only the current request or grant parent.** A reconnect can change that
identity while the prior connection or usage grant remains active, allowing a
revoked parent to continue producing or delivering data.

**Cache scope in the child credential.** A saved selection would not reflect
later revocation. Reading current authority at each existing boundary preserves
the original binding without granting a child token general permissions.

## Consequences

Scope revocation prevents subsequent producer work and delivery at the next
existing check, while already committed results remain stored. The scoped
constructors require an authority source tied to the same transaction or
snapshot; production activation must supply it for each protected path. These
checks do not replace the existing resource authorization or make a Session
producer a general-purpose user credential.
