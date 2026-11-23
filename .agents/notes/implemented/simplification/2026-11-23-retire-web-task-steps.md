# Agent Note: Retire Web Task Steps

Status: implemented

## Problem

Task Steps are being retired across product interfaces. A Web client that keeps
its Steps workspace would continue issuing requests to an endpoint scheduled for
removal. Existing task links and saved reading selections still need to reach
their task and attachments, and ordinary Task writes retain their identity and
access checks.

## Decision

Web removes the Steps tab, client, state, drafts and controls. A legacy `steps`
selection uses the default tab, while an attachment path keeps its normal
attachment destination. Ordinary Task mutation and parent retirement checks,
Discussion drafts and attachment navigation remain with their existing owners.
The [inspection design](../../../../docs/design/daynight-task-inspection.md)
records the current detail and navigation behavior.

This supersedes the Web-specific [delete](../architecture/2026-11-05-task-steps-web-delete.md),
[row memoization](../architecture/2026-11-07-task-steps-row-memo.md), and
[success continuation](../bug-fix/2026-11-04-step-success-terminal-continuation.md)
decisions. It partially supersedes the [detail ordering](../architecture/2026-11-05-task-detail-order-and-records.md)
and [mutation settlement](../architecture/2026-11-11-task-mutation-local-settlement.md)
decisions, whose remaining Task and Session contracts continue to apply.

## Alternatives

**Keep the Steps workspace until the API is removed.** This would leave a Web
consumer requiring that retiring endpoint and couple the UI switch to the server
cutover. Removing the Web consumer first allows it to operate with the existing
service while the other interfaces are retired separately.

## Consequences

Web users cannot read or change Steps, including through old tab links. REST
Steps functionality remains available. The
[CLI retirement](2026-11-23-retire-cli-task-steps.md) removes its Steps commands,
and [MCP retirement](2026-11-23-retire-mcp-task-steps.md) removes its tools and
dedicated manual. Legacy navigation continues to open the Task or attachment
through the normal access checks, and other Task behavior remains independently
usable.
