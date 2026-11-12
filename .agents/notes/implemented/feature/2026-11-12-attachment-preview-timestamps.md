# Agent Note: Attachment Preview Timestamps

Status: implemented

## Problem

Readers need to distinguish the age and recent modification of an attachment while viewing it. Task timestamps describe a different resource, and a file's content alone does not provide reliable upload metadata.

## Decision

The shared Task and Goal attachment preview displays both attachment timestamps from the selected list metadata. It uses the existing locale and browser time-zone formatter with seconds and semantic `time` elements. The file information, timestamps and actions form responsive groups; known metadata stays with the selection through incomplete refreshes and preview failures.

## Alternatives

**Fetch timestamps separately.** The attachment inventory already supplies both values, so another request would introduce an independent failure and synchronization path without adding information.

**Show only the last modification.** Creation and modification answer different questions, including when both values happen to be equal.

## Consequences

The header consumes more space, especially in narrow layouts, where its groups wrap. No new storage or API contract is needed; the existing attachment lifecycle and selection determine which values are visible. The [requirements](../../../../docs/spec/daynight-task-attachments.md) and [design](../../../../docs/design/daynight-task-attachments.md) describe the behavior and ownership.
