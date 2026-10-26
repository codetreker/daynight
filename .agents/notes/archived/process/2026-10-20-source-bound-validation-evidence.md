# Agent Note: Source-bound Validation Evidence

Status: implemented

## Problem

An acceptance run describes one source revision, built artifact and environment.
Combining those observations with reusable validation instructions in shared
Markdown reports makes unrelated deliveries rewrite the same files. Concurrent
PRs then conflict over results that do not establish each other's behavior, and
a report's latest heading can be mistaken for evidence about a newer revision.

## Decision

Acceptance scripts and CI gates retain their existing workloads, limits and
cleanup requirements. Generated JSON receipts, raw coverage profiles, browser
reports, traces and screenshots remain source-bound run artifacts. The
corresponding PR and CI run own execution results and their tested revision;
tracked Markdown does not accumulate rolling acceptance snapshots.

The [repository README](../../../../README.md#validation) and package READMEs own
repeatable commands, receipt interpretation and supported-environment limits.
Specifications retain required behavior; designs explain mechanisms. The owning
README keeps useful requirement-to-test mappings alongside validation commands.
Existing decision notes retain rationale, alternatives and gaps. Durable research
assets remain committed when needed to assess a decision, with their original
source identity, method and scope limitations. These owners receive useful
knowledge from the removed client, service and dashboard reports without copying
their version, timing, coverage or delivery-status tables into another report.

This clarifies the document ownership in the
[shared workflow decision](2026-10-16-agent-workflow.md) and partially replaces
the report ownership recorded by the
[installed CLI](../testing/2026-10-17-installed-cli-acceptance.md),
[built-process service](../testing/2026-10-19-server-process-acceptance.md) and
[production dashboard](../testing/2026-10-20-dashboard-production-acceptance.md)
acceptance decisions. Their original reasons for installed packages, real process
behavior, complete browser workloads and independent live-service evidence
continue to apply.

CI acceptance artifacts have a 30-day retention period. A PR or workflow link
locates the run but does not preserve an expired artifact. Before an observation
is needed as long-term evidence for a decision, retain its sanitized evidence in
the existing research owner or record the durable conclusion, provenance and
limits in the owning design or note. A local dirty-worktree result, controlled
fixture, historical image or successful probe retains that scope; none becomes
clean current-source or live-service evidence through migration.

## Alternatives

**Keep the three acceptance reports.** They provide one narrative location for
commands and historical outcomes, but their shared run snapshots have already
caused PR conflicts. The reports are manually maintained; validation consumes
the scripts and generated artifacts, so keeping them adds synchronization work
without enforcing another acceptance gate.

## Consequences

Independent deliveries can report their own runs without updating a common
acceptance history. Reviewers inspect the actual tested source, artifact and
cleanup result through the PR and CI evidence. Existing acceptance scenarios,
strict coverage thresholds and required checks keep their force.

There is no permanent archive of every run's raw outputs. Retention requires a
deliberate choice when evidence supports a lasting decision; expired CI artifacts
cannot substantiate details that were never preserved. Committed research
evidence remains selectively maintained rather than becoming a new rolling
acceptance log.
