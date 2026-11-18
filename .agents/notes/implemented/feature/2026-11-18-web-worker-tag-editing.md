# Agent Note: Edit Worker task tag filters in Web

Status: implemented

## Problem

Worker tag filters are independent of project tag IDs, so a user needs to enter complete names while retaining the distinction between a saved target and actual application. Older Workers may not report support, and concurrent configuration edits must not discard unknown source fields or drafts.

## Decision

The configuration editor uses free-text chips and a native match selector. It validates complete names, includes valid pending input when saving, and preserves invalid input for correction. Empty filters use `any`. Missing Worker support permits retaining or clearing the saved filter, while changes to a nonempty filter require a current support observation. The save path rechecks that condition, merges known filter fields into the original source, and verifies the receipt using filter semantics alongside unknown fields. Observation changes do not replace the draft.

The [observation decision](2026-11-18-web-worker-tag-observation.md) owns the independent target and application feedback.

## Alternatives

**Choose project tags by ID.** Workers select tasks across projects, where equivalent names can have different IDs or be absent; a project catalog cannot describe the complete filter.

**Treat missing support as permission to edit.** A Worker that does not understand the filter could claim tasks without applying it. Allowing clear and unchanged values retains recovery and unrelated configuration editing.

## Consequences

Users can configure names that do not yet exist in a project. A successful save remains distinct from application, and preserving unknown source members requires semantic receipt comparison rather than rebuilding the source from typed fields.
