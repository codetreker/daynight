# Agent Note: CLI Team Lifecycle Confirmation

Status: implemented

## Problem

Team lifecycle writes need deliberate confirmation against the current account
and resource without confusing a later observation with a lost write receipt.
Names may contain whitespace, newlines and terminal controls, so typing an
unescaped display name cannot reliably confirm exactly the intended Team.
Automated callers also need a way to confirm once while preserving service
identity, version and authority checks.

## Decision

The CLI creates, renames and deletes ordinary Teams using a feature confirmation
flow. Interactive create and rename ask for confirmation; delete displays the
raw name as a JSON string literal and compares the decoded input exactly. A
boolean `--confirm` skips the interactive challenge, while deletion still sends
the observed raw name and version. Non-interactive calls without confirmation do
not write. An explicit `--if-version` must match the observed Team version.
Confirmation and network waits hold no configuration lock.

Each write binds the actual user to `expectedUserId`, validates the response
principal and receipt, and consumes the confirmed result without a second read.
Conflict requires a fresh decision; an unconfirmed response remains unknown and
is never replayed automatically. The [client requirements](../../../../docs/spec/daynight-project-task.md#team-生命周期)
own the command behavior. The [Team context decision](2026-11-04-cli-team-context.md)
owns target resolution, and the [Team lifecycle decision](2026-11-04-team-lifecycle.md)
owns service transactions and refusals.

## Alternatives

**Enter the raw name directly.** Newlines and control characters cannot be
reliably represented as a single terminal input, and trimming would collapse
distinct valid names. JSON string literals preserve the exact comparison.

**Treat a matching later read as the write receipt.** Another actor may have
changed the resource, and Team names can be duplicated. A later read establishes
current facts but cannot prove which submission committed.

## Consequences

Scripts can confirm explicitly without bypassing server preconditions. A stale
version or changed name requires a new observation and decision. Unknown writes
remain visible even if the current state resembles the requested result. The
confirmation flow covers the delivered Team lifecycle commands; Task commands
retain their existing behavior.
