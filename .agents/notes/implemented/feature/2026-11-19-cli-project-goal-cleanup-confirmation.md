# Agent Note: CLI Confirmation of Project Goal Cleanup

Status: implemented

## Problem

Project deletion and transfer can permanently remove Goal dependencies within
and across Projects. A caller must understand that effect before submitting the
operation, including when using JSON output or a noninteractive shell.

## Decision

Both CLI commands require `--confirm` before any request and display the cleanup
effect on stderr before submission. Interactive deletion also checks the exact
Project name. The two mutation requests send the server's explicit cleanup
confirmation header; previews do not. Existing receipt and unknown-outcome rules
remain in force. The [server decision](../architecture/2026-11-19-project-goal-dependency-cleanup.md)
owns the cleanup transaction. The [earlier transfer decision](../../archived/architecture/2026-11-04-cli-project-transfer.md)
records the original confirmation behavior.

## Alternatives

**Allow interactive confirmation without the flag.** This would leave an existing
command invocation capable of removing newly introduced Goal relationships
without an explicit indication in its arguments.

## Consequences

Existing scripts must add `--confirm`. The warning describes the full potential
scope without relying on a stale relationship count. JSON stdout remains a receipt;
the preview and warning go to stderr.
