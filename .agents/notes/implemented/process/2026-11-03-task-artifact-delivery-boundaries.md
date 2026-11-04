# Agent Note: Task artifact and documentation delivery boundaries

Status: implemented

## Problem

Design discussions produce several kinds of artifacts before implementation is
ready. Publishing ordinary documentation separately can detach its claims from
the code that makes them accurate. Permission to publish one design document also
needs a clear boundary so that other design inputs are not implicitly published.

## Decision

[Repository instructions](../../../../AGENTS.md) require ordinary documentation to
ship in the same PR as its corresponding implementation. A standalone
documentation PR needs explicit user permission for its actual scope. Permission
to publish an architecture document does not extend to other design inputs or
prototypes.

The [UI mockup ownership decision](2026-11-03-ui-mockup-ownership.md) owns prototype
storage and the ban on repository mockups, including interactive previews composed
from production components and tests that target them. Reviewable prototypes stay
in their owning Daynight task attachments; local inspection uses only the task
worktree's Git-ignored `.tmp/` and removes those copies after use.

## Alternatives

**Publish the entire design packet in a documentation PR.** This makes artifacts
available through one repository branch, but imports temporary mock source and
publishes unrelated documents under permission granted for one architecture
text. Task attachments already provide durable access to the actual design inputs.

## Consequences

Implementation PRs keep their ordinary documentation synchronized with behavior.
Reviewers assess the document actually authorized for standalone publication.
Prototype storage and product-validation boundaries remain with the dedicated
mockup ownership decision; a document publication exception does not relax them.
