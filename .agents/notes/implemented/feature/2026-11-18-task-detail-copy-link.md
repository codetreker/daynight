# Agent Note: Task Detail Copy Link

Status: implemented

## Problem

Readers need to share a Task from its detail surface without carrying an
incidental tab or attachment selection into the recipient's reading context.

## Decision

The ordinary Task detail menu copies the absolute Overview URL of the Task being
read. It is available while detail is readable, including terminal Tasks and
Tasks opened from Goals. Clipboard feedback follows the reading identity and
is discarded when that identity or availability changes. New-tab navigation
continues to preserve the selected tab and attachment.

## Alternatives

**Copy the current new-tab URL.** This would carry a temporary tab or attachment
selection and produce different links for the same Task.

## Consequences

The copied link consistently opens the Task overview, subject to normal access
checks. Clipboard refusal is visible and retryable; it does not change the
reader's navigation or draft.
