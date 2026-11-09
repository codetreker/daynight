# Agent Note: CLI Invitation Receiver

Status: implemented

## Problem

A person receiving a Project or Team invitation needs to inspect and accept it
as the signed-in account without exposing the bearer secret in process
arguments or diagnostic chains. A preview must not consume the invitation, and
an uncertain submission cannot be presented as a confirmed membership.

## Decision

The CLI reads a same-service invitation link through a hidden terminal prompt
or bounded standard input and dispatches inspection and acceptance to the
matching Project or Team API. The secret is passed in the request body and is
not persisted. Error construction excludes input and raw secret-bearing parser
causes. The command identifies the actual signed-in account, checks the response
principal, and does not resolve a default Team. Acceptance requires explicit
confirmation and binds the expected user. Non-interactive acceptance without
confirmation does not write.

The [Project invitation decision](2026-11-04-project-invitation-results.md)
and [Team invitation decision](2026-11-04-team-invitations.md) own direct
relationship and transactional consumption semantics. The CLI uses their
validated receipts and does not replay an unknown acceptance.

## Alternatives

**Accept the link or token as an argument.** Process listings and shell history
can retain the bearer secret beyond the command's execution. Hidden input and
bounded standard input provide interactive and scriptable entry without argv.

## Consequences

Scripts must explicitly supply the link on standard input and confirm acceptance;
confirmation does not authorize accepting for another account. A later read can
show current membership but cannot restore a lost acceptance receipt. Input and
response errors must remain safe even when the CLI prints recursive causes.
