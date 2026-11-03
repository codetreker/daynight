# Agent Note: Task artifact and delivery boundaries

Status: implemented

## Problem

Design discussions produce several kinds of artifacts before implementation is
ready. Treating every artifact as a repository deliverable can publish mock UI
source and separate ordinary documentation from the code that makes it accurate.
Permission to publish one design document also needs a clear artifact boundary.

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

## Alternatives

**Publish the entire design packet in a documentation PR.** This makes artifacts
available through one repository branch, but imports temporary mock source and
publishes unrelated documents under permission granted for one architecture
text. Task attachments already provide durable access to the actual design inputs.

## Consequences

Task attachments preserve prototype ownership, and implementation PRs keep their
ordinary documentation synchronized with behavior. Reviewers assess the document
actually authorized for standalone publication. Local inspection still works
through ignored scratch copies. This policy does not itself authorize a
repository-wide removal of historical prototypes.
