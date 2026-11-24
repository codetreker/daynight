# Agent Note: Web Subtask Tab

Status: implemented

## Problem

A direct child list and creation form at the bottom of Task Overview are difficult
to find and cannot be opened directly, while parent information remains useful
alongside the overview. Moving the list must preserve its authorization and
asynchronous creation ownership across navigation.

## Decision

Ordinary Task reading presents Subtasks immediately after Overview, with a durable
URL and history selection. A shared relation host supplies the Overview parent and
Subtasks children independently under the same Task observation and read fence.
The creation controller remains with that host; its dialog is visible only on the
selected tab and confirmed receipts refresh their original scope once. The
[ordinary relations decision](2026-11-23-web-ordinary-task-relations.md) owns
projection semantics and links.

## Alternatives

**Keep children in Overview.** This avoids another tab but leaves the list and
creation entry below potentially long description content and offers no direct
navigation to them.

**Mount separate relation controllers per tab.** Independent polling and Task
observations would duplicate requests and could disagree about read eligibility.

## Consequences

Parent and child failures can recover separately while sharing admission and
observation. Tab changes retain attachment and draft owners; navigation and
creation races require the host to distinguish a dialog presentation from its
already dispatched operation.
