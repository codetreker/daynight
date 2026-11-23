# Agent Note: Retire CLI Task Steps

Status: implemented

## Problem

Task Steps exposes a second ordered work resource through CLI commands, clients,
completion and installed instructions. Retiring that product capability requires
the published command tree and guidance to agree, while ordinary Task operations
and already received Inbox events continue to work.

## Decision

The CLI has no Task Steps command group or dedicated API client. Command help,
completion, the manual topic list and the canonical installed skill omit Steps.
Old commands fail through the ordinary unknown Task operation path before
configuration, Git or HTTP access. New Worker Inbox prompts use the surviving
Task and Thread operations. Historical events retain the common decoder.

The existing update path refreshes installed User and current-worktree Project
skills; first installations and other Project copies use skill installation.
Ordinary changes preserve the package version and use the existing release
workflow for publication. HTTP and MCP Steps remain available. The [Web retirement](2026-11-23-retire-web-task-steps.md) removes its Steps workspace.

The CLI-specific [text process proof](../testing/2026-11-10-step-cli-text-process-proof.md),
[layered test migration](../testing/2026-11-10-step-cli-test-layered-removal.md)
and [request-deadline witness](../testing/2026-11-19-step-add-request-deadline.md)
record the historical guarantees of the removed client. Shared transport,
validation and ordinary Task tests retain their surviving callers.

## Alternatives

**Keep hidden commands or client exports.** Hidden entry points would still
provide callable Steps operations and leave a client dependency after public
discovery no longer advertises them.

**Delete historical Inbox decoding.** Already received events remain subject to
the existing Inbox lifecycle; removing their decoder would break unrelated
processing of stored records.

## Consequences

CLI users receive an explicit failure for retired commands. Updating a CLI also
refreshes its existing installed guidance through the established mechanism.
Steps-specific tests disappear with the behavior they own; shared validations
must remain covered through ordinary callers. This delivery does not retire
server routes, MCP tools, Web behavior or persisted Steps data.
