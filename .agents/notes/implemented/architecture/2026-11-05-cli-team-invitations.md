# Agent Note: CLI Team Invitation Management

Status: implemented

## Problem

Team administrators need to create and revoke invitation links from the CLI
without storing bearer secrets or mistaking a lost response for a failed write.
Untrusted response bodies can contain secrets even when malformed, so ordinary
parser and diagnostic errors must not expose their contents.

## Decision

The CLI resolves the current Team and account before listing, creating or
revoking invitations. Create and revoke require explicit confirmation. Create
discloses a validated same-service link once on stdout; lists contain metadata
only and revoke uses the validated receipt, including an unchanged result for an
already revoked invitation. Secret-bearing responses are isolated from
diagnostic causes. Unknown writes are not replayed or replaced automatically.
The [Team invitation decision](../../archived/architecture/2026-11-04-team-invitations.md) records the rationale for the service
and receiver lifecycle, and the [CLI Team context decision](../../archived/architecture/2026-11-04-cli-team-context.md) records the rationale for target resolution.

## Alternatives

**Recover a lost link from a later list.** The service stores only a hash and
returns metadata, so a later read cannot recover the secret or prove which write
committed. Creating another invitation would also introduce an extra live link.

## Consequences

The administrator must save the disclosed link securely. Invalid or uncertain
responses do not produce a link or trigger a replacement write; diagnosing them
retains safe classifications without copying response content into errors.
Accepting invitations remains a separate capability.
