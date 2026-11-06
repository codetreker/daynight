# Agent Note: Web CI Case Shards

Status: implemented

## Problem

Complete Web browser validation repeats a substantial functional workload in
native and container deployments. Their execution already overlaps within a
runner, but both complete inventories remain on that runner's critical path.
Sharing selected fixture preparation reduced setup operations without proving a
causal hosted-CI latency improvement.

Reducing that critical path must preserve the complete functional inventory,
normal authentication, deployment and persistence checks, source attribution and
owned-resource cleanup. Independent partial jobs cannot each claim complete Web
acceptance, and selected validation cannot be accepted as skipped.

## Decision

The existing `verify-web` job is a two-entry matrix with `fail-fast: false`.
Playwright selects cases with `--fully-parallel --workers=1 --retries=0
--shard=i/2`. At adoption, the 32-case inventory partitioned into two disjoint
sets of 16. The current inventory has 42 cases, partitioned into two sets of 21;
each shard executes its selection against separate native and container
deployments. Fully-parallel controls case selection while each database retains
one serial browser worker. The existing within-run native/container overlap,
private profile roots, permission binding and shared CLI recovery barrier apply
to both shards.

Before service preparation, complete and selected collection use the same
functional arguments as execution and the canonical scenario names from pure
`inventory.mts`. The selected IDs and shard identity are recorded in the existing
schema 3 functional evidence. Container callbacks read that selection through the
existing source/run-bound parent receipt. Failed, malformed or incomplete
collection cannot establish a valid selection.

Shard 2 owns all existing once-only checks: 28 navigation-contract cases, dev-ci
lifecycle fixtures, both ten-check combined-authentication journeys, and real
attachment persistence with paired-backup restoration. Ownership derives from
the shard identity. Every shard still verifies its functional targets, built and
running image identity, private resources, browser recovery and CLI cleanup.
Local ordinary validation remains complete and unsharded; local stress adds the
same capacity cases after cleanup barriers and rejects a shard combination
before preparing resources.

Each entry uploads its complete artifact and a small summary containing only the
existing `runID/evidence.json`. The existing final `checks` job retains its
preceding-job gate and requires selected Web quality and matrix results to
succeed. It checks out current source, sets up Node 24, downloads both exact
summary names and runs the install-free report validator. Passing requires
shards 1/2 and 2/2 with distinct run IDs, clean successful evidence at the current
`GITHUB_SHA` and checkout tree, exact target/phase cleanup and inventories,
disjoint canonical coverage and both complete combined receipts only on shard 2.
Missing, duplicated, wrongly sourced or incomplete evidence fails that gate.
Executable files, images and runtime ownership do not cross runner boundaries.

This supersedes the single complete browser job retained by the
[quality isolation decision](2026-10-26-web-quality-job-isolation.md) and the
per-invocation complete CI inventory in the
[functional target decision](2026-11-04-web-functional-target-overlap.md).
Their independent quality budgets and within-run resource guarantees remain.
The [Web validation guide](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns commands, artifact names and receipt details.

## Alternatives

**Keep one complete browser runner.** This avoids duplicated builds, service
preparation and cleanup, but retains all functional cases on one critical path.
Selected fixture sharing alone did not establish the desired hosted latency.

**Use default file-level sharding.** At adoption, the suite divided 24/8 by file.
Case-level selection yielded 16/16 without concurrent access to a shared database.
The complete canonical union remains independently checked.

**Repeat every extra check in both shards.** Navigation, lifecycle,
combined-authentication and persistence work added about 98 seconds in the input
samples. Giving it to the lighter shard 2 balances the modeled critical paths
while preserving each check once. Duplicating it would add work to both runners.

**Create a separate deployment job.** A third runner would add another setup and
result dependency. Two browser runners plus the existing final gate provide the
selected partition and complete evidence validation without a new runtime
handoff or deployment job.

## Consequences

Both browser runners install and build their own targets and retain complete
cleanup, so total runner minutes can increase. Quality remains independent.
The summaries are small JSON files and use the existing final required job;
selected Web jobs must succeed before aggregate validation can pass.

A model using [main run 41791208872](https://github.com/codetreker/daynight/actions/runs/41791208872)
and [PR run 41792519944](https://github.com/codetreker/daynight/actions/runs/41792519944)
estimated a critical path of about seven minutes before queueing, assuming
comparable setup and throughput. It is
not a five-minute promise or a measured speedup. Actual results remain tied to
the tested source, workload, cache conditions and runner; timing comparisons
must distinguish observations from causal attribution.

Additional shards require a new decision about balancing, check ownership and
aggregate validation. The implementation deliberately admits exactly two
partitions and preserves the complete local acceptance and stress commands.
