# Agent Note: Task artifact and delivery boundaries

Status: implemented

## Problem

Design discussions produce several kinds of artifacts before implementation is
ready. Treating every artifact as a repository deliverable can publish mock UI
source and separate ordinary documentation from the code that makes it accurate.
A general autonomous workflow can also expand a confirmed breakdown by inventing
new prerequisite tasks.

## Decision

[Repository instructions](../../../../AGENTS.md) keep mock UI and interactive
prototype artifacts in the owning Daynight task attachments. Their HTML, scripts,
styles, assets and generated previews cannot be committed, pushed, included in a
repository PR or placed in product or source directories. Git-ignored scratch
copies may support local inspection and are removed after use.

Ordinary documentation ships in the same PR as its corresponding implementation.
A standalone documentation PR needs explicit user permission for its actual
scope. Permission to publish an architecture document does not extend to other
design inputs or prototypes.

Activated autopilot executes the already confirmed task breakdown. New tasks and
prerequisites need separate scope confirmation. Existing delivery obligations,
including validation, review and authorized merge, remain part of each task.

## Alternatives

**Publish the entire design packet in a documentation PR.** This makes artifacts
available through one repository branch, but imports temporary mock source and
publishes unrelated documents under permission granted for one architecture
text. Task attachments already provide durable access to the actual design inputs.

**Derive prerequisite tasks from general autonomous-delivery authority.** This
could organize additional work, but changes the agreed queue without confirming
its scope. The existing breakdown remains the execution boundary.

## Consequences

Task attachments preserve prototype ownership, and implementation PRs keep their
ordinary documentation synchronized with behavior. Reviewers assess the document
actually authorized for standalone publication. Local inspection still works
through ignored scratch copies. This policy does not itself authorize a
repository-wide removal of historical prototypes or a new delivery task.
