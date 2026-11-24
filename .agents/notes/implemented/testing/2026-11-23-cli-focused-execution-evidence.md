# Agent Note: CLI Focused Execution Evidence

Status: implemented

## Problem

A platform-focused CLI suite can omit native behavior even when its commands
succeed. File counts or discovery cannot prove which files and cases actually
ran, whether Windows shards overlap, or whether platform skips changed. A
classification can become invalid when dependencies change. Independent hosted
jobs also introduce noise that one full/focused pair cannot distinguish from a
repeatable wall-clock improvement.

## Decision

An opt-in workflow records full Linux, full and focused Windows shards, and full
and focused macOS results for a fixed PR head. Explicit dispatch binds the
authorized work branch and candidate SHA, identifies the comparison group and
selects full-first or focused-first execution. The two modes run in successive
phases; repeated groups can alternate order. Required PR and main jobs retain
their full suites while candidate coverage and benefit are measured.

The independent verifier compares actual Vitest discovery and JSON results,
source and runtime identity, command outcomes, structured case identities and
states, and passing native sentinels. PR head/ref and actual checkout revision/tree
are separate identities; all reports match the verifier's checkout. Format-2
reports require pinned pnpm and retain hosted run, attempt, job and group
provenance. Reports from separate runs or mixed hosted/local origins cannot form
a hosted comparison; explicit job reruns may have a different attempt.

The original three DTO samples are supplemented by reviewed compiled Task
protocol matrices and synthetic filesystem records. Native Task regressions and
the Darwin filesystem ABI test remain included. Exact file blobs and conservative
Git object guards bind classification to CLI source, tests, scripts, build and
dependency inputs. Preflight rejects stale or empty selections before execution,
and final verification proves the actual executed sets. A guarded change requires
classification review. Parameterized tests with runtime-generated inputs retain
stable distinct labels without changing their inputs or assertions.

The [development guide](../../../../docs/development.md#cli-development) owns
operation and evidence limits.
[Windows shard verification](2026-11-11-windows-cli-verified-shards.md) retains
its independent full-suite gate.

## Alternatives

**Use discovery and exit codes alone.** Discovery is unsharded and cannot prove
actual execution, shard disjointness, skipped cases or passing native behavior.

**Switch ordinary PR jobs immediately.** The original sample did not establish
a complete classification or meaningful CI wall-clock benefit. Candidate native
comparisons must establish both before required selection changes.

**Guard only the test file.** Its imported implementation or shared runner can
change the behavior being classified without modifying the test. Broad object
guards require more frequent review but fail conservatively.

**Run only one concurrent pair.** Runner variation and queueing can dominate a
small exclusion's cost. Alternating repeated groups exposes order and variation;
job and end-to-end observations still need their actual scheduling context.

## Consequences

Opt-in comparison consumes additional native runners and transient artifacts.
Broad guards can require reclassification after unrelated changes; they do not
prove classification correctness. Preflight prevents wasting native execution
on a known-invalid plan. Source and provenance checks reject reports whose
environments or candidate differ. Earlier format-1 evidence remains readable
with its original verifier and cannot substitute for format-2 acceptance.

The reviewed exclusions and sentinels establish a bounded candidate comparison;
they do not claim comprehensive native coverage or a CI speedup. Ordinary jobs,
installed CLI validation, runtime compatibility and required checks remain full.
Changing selection requires equivalent coverage and repeatable meaningful
wall-clock benefit, with timing, queueing and limitations preserved as evidence.
