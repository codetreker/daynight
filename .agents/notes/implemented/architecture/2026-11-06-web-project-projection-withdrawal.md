# Agent Note: Web Project Projection Withdrawal

Status: implemented

## Problem

Project access can end while the directory, Worker observations and configuration
metadata remain mounted in another tab. Their account-scoped reads are independent
of task-cache admission, and an earlier page or poll can arrive after withdrawal.
A Worker list count has no per-project provenance, while a later, newly authorized
observation of the same Project must remain usable.

## Decision

Independent projections capture the principal's durable Project generation map
before starting a read and compare it with access-negative events. Each published
page or observation retains its own captured generation. A missing entry is not
proof of denied access; a matching or unknown generation permits withdrawal, and
a different generation protects a later observation from an old event. An identity
pause that interrupts snapshot preparation retries the read after the same live
scope becomes ready; cancellation or scope invalidation ends it. Snapshot
replacement and cache invalidation persist predecessor generations atomically with
the manifest. A denial ticket carries the complete history, so a later denial
withdraws ancestor observations even if a replacement hint was lost or delayed.
A corrupt predecessor that cannot be identified remains explicitly unknown; an
incomparable cross-tab hint is checked against the durable generation before it
withdraws and rereads a projection. If storage cannot establish the history, the
projection is hidden with an error. During identity checking, including a check that starts while the durable read
is pending, incomparable content is provisionally hidden immediately and
restored after the durable check rejects a stale hint. A proven descendant survives an older hint. A scope also rejects an incomparable old ticket after
its own later online admission. The history is not truncated. Events also fence in-flight reads. A same-user negative hint reaches independent consumers
even if its durable cleanup has already changed the manifest; cache cleanup itself
still uses the captured generation. Cleanup failures retain a local denial, expose
an error and prevent that Project from being republished until cleanup succeeds.
Fresh authoritative reads can then restore it without a permanent ID blacklist.
If the generation store is unavailable, project-bearing content stays hidden while
Worker identity and telemetry remain readable; a corrupt Project generation is
isolated to that Project.

The directory removes the matching card and sidebar entry. Configuration retains
selected IDs as unavailable and removable. Worker details remove matching task
rows and recompute their visible count; Worker summaries discard counts whose
Project provenance is unavailable until an authoritative reread. Worker identity
and telemetry remain independent. The [cache decision](../../archived/architecture/2026-10-24-persistent-task-summary-cache.md)
owns persistent admission and cleanup, and the [Worker observation decision](../../archived/architecture/2026-10-29-web-worker-observations.md)
owns account-scoped reading and time semantics.

## Alternatives

**Infer access from missing task-cache admission.** An unvisited healthy Project
also lacks admission, so this would hide valid directory and Worker content.

**Compare only the current durable generation when a hint arrives.** Another tab
may already have purged it, leaving an older displayed projection undisclosed.
Capturing the generation at request start preserves the observation's provenance.

**Subtract a revoked Project's task count from the Worker summary.** The summary
contains no per-project breakdown. Marking the count unavailable avoids inventing
a number while retaining unrelated Worker information.

## Consequences

Independent reads use the existing cache lifecycle for generation snapshots and
withdrawal, without storing their content in IndexedDB. A local storage failure
can delay recovery of the affected Project, but it does not authorize stale
content or require hiding healthy projects. The design does not add Project
removal UI or change the server's access decision.
