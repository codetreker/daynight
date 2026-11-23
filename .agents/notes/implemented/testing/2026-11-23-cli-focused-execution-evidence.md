# Agent Note: CLI Focused Execution Evidence

Status: implemented

## Problem

A platform-focused CLI suite can omit native behavior even when its commands
succeed. File counts or a discovery list cannot prove which files and cases
actually ran, whether Windows shards overlap, or whether platform skips changed.
A classification can also become invalid when its dependencies change.

## Decision

An opt-in workflow records full Linux, full and focused Windows shards, and full
and focused macOS results for one PR head. Its independent verifier compares
actual Vitest discovery and JSON results, source and runtime identity, command
outcomes, structured case identities and statuses, and passing native sentinels.
The small portable sample is bound to Git objects for the test files and
conservatively guarded CLI source, tests, scripts, build and dependency inputs.
A guarded change invalidates the sample until it is reviewed again. The
[development guide](../../../../docs/development.md#cli-development) describes
operation and evidence limits. The existing required matrix remains full, and
[Windows shard verification](2026-11-11-windows-cli-verified-shards.md) retains
its independent full-suite gate.

## Alternatives

**Use discovery and exit codes alone.** Discovery is unsharded and cannot prove
actual execution, shard disjointness, skipped cases or passing native behavior.

**Switch ordinary PR jobs immediately.** The sample does not establish a safe
complete classification or a meaningful CI wall-clock improvement. A separate
candidate and native comparison are necessary before changing required jobs.

**Guard only the test file.** Its imported implementation or shared runner can
change the behavior being classified without modifying the test. Broad object
guards require more frequent review but fail conservatively.

## Consequences

Opt-in comparison consumes additional native runners and reports transient
artifacts. Broad guards can require reclassification after unrelated changes;
they do not prove that the classification itself is correct. The sample and
sentinels support the comparison but do not claim comprehensive native coverage
or a CI speedup. Ordinary jobs and installed CLI validation stay unchanged.
