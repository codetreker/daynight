# Agent Note: PR Primary Synchronization Notice

Status: implemented

## Problem

Synchronization intent, service availability, and connection health are
independent facts. When several prevent updates, the PR list could show multiple
configuration notices with repeated settings links, obscuring the member's
explicit choice to keep synchronization off.

## Decision

The PR workspace selects one primary notice in the order documented by the
[PR read design](../../../../docs/design/github-pr-reading.md). Disabled
synchronization takes precedence; service availability, connection health and
initialization follow. Polling and Webhook diagnostics remain independent and
retain the distinction between current failures and historical errors. Settings
continues to expose the individual facts.

The [PR read decision](../architecture/2026-11-13-github-pr-reads.md) owns the
read path; the [sync setting decision](../architecture/2026-11-14-project-github-sync-setting.md)
owns synchronization intent and its persistence.

## Alternatives

**Show every applicable primary state.** This exposes all blockers in the list
but repeats the settings action and competes with the explicit disabled state.

**Suppress all other notices when a primary state is shown.** This would hide
independent failures and historical diagnostics that remain useful to readers.

## Consequences

The list has one prominent configuration or synchronization message and one
settings link for that message. Other blockers require opening settings, while
independent diagnostics, read errors and update notices remain visible. No
service state or synchronization behavior changes.
