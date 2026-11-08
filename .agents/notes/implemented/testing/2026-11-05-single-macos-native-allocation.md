# Agent Note: Single macOS Allocation for Native Validation

Status: implemented

## Problem

A complete installed CLI phase ran successfully on macOS 15 ARM64 while the
ordinary phase failed hosted acquisition before executing any step. Separate
allocations therefore left required native validation incomplete even though the
selected image could execute one full workload. Increasing test deadlines cannot
repair acquisition that precedes checkout.

The [parallel phase decision](../../archived/testing/2026-11-04-parallel-native-cli-validation.md) chose
independent runners because installed acceptance does not consume ordinary-test
outputs. That permits useful overlap when capacity is available, at the cost of
two allocations and duplicated preparation for every platform.

## Decision

This decision introduced a single macOS allocation to reduce acquisition
requirements. The [independent macOS validation decision](2026-11-07-independent-macos-cli-validation.md)
supersedes that topology and owns the current jobs. The original allocation,
failure-handling and deadline choices are retained here as decision history.

The workflow kept independent ordinary and installed matrices for Linux and
Windows. A dedicated required `verify-macos` job selected one standard `macos-15`
ARM64 allocation and ran the complete ordinary phase followed by the complete
installed phase. All six logical OS phases retained their workloads and
final-gate requirements. The
[image availability decision](2026-11-05-macos-ci-image-availability.md) continues
owning the supported image and its capacity limits.

macOS shared checkout, Node.js, pnpm and dependency installation. Each validation
phase retained its own environment recorder, outcome, build, artifact names,
private fixtures and cleanup. Ordinary environment and probe uploads ran before
`.tmp/validation-environment.json` and `.tmp/validation-probes.json` were cleared
for the installed recorder. An explicit non-cancellation/shared-preparation and
architecture guard let installed validation run after an ordinary failure;
its own environment discovery also had to succeed. Ordinary failure remained a
job and final-gate failure, and shared preparation failure could not produce
successful phase evidence.

The macOS job's outer limit was 20 minutes, the sum of the former two 10-minute
job limits. Each validation command retained a 10-minute bound, with shared setup
and uploads inside the outer limit. Existing 180-second hook/callback limits and
other command deadlines retained their settings.

Runtime compatibility depended only on module detection and the Linux/Windows
ordinary producer matrix, whose Ubuntu entry supplied the packed artifact. It
had no installed or macOS dependency. Final `checks` explicitly required
`verify-macos`, so runtime completion did not replace macOS validation.

The [development guide](../../../../docs/development.md#ci-selection) and
[repository CI guide](../../../../README.md#ci-selection) own current commands and
gate selection. This partially superseded the earlier uniform parallel topology
while preserving phase ownership and source-bound artifacts. It introduced no
general phase framework, runner fallback or cross-runner artifact protocol.

## Alternatives

**Keep two macOS allocations.** This preserved maximum compute overlap and was
the original choice. It also retained two acquisition dependencies and duplicated
bootstrap on the capacity-constrained native platform.

**Omit a phase or substitute another architecture.** Both complete macOS phases
remained required, and Intel remained outside the supported platform boundary.

**Run both suites concurrently on one machine.** This reduced allocations but
introduced CPU, filesystem and process contention between native Git and
installed acceptance workloads. Serial execution preserved their worker and
resource assumptions.

**Introduce a generic scheduler or fallback protocol.** The explicit macOS job
expressed its ordering and evidence ownership directly. A broader mechanism
would have added selection and handoff rules without proving additional hosted
capacity.

## Consequences

The single-allocation topology required one acquisition and one shared dependency
preparation. Serial execution could lengthen its compute critical path when
runner capacity was abundant; queueing and execution time had to be measured
separately. The choice did not establish independent hosted pools or guarantee
allocation.

Real ARM64 allocation and both complete source-bound suites remained necessary.
Artifacts retained phase ownership despite fixed-path reuse within one job, and
ordinary, installed, cancellation and preparation failures remained visible to
the required final gate. Linux/Windows overlap, Go race selection and the other
selected CI workloads kept their existing behavior. The replacement restores
independent macOS execution while retaining those workloads and evidence owners.
