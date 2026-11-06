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

The workflow keeps independent ordinary and installed matrices for Linux and
Windows. A dedicated required `verify-macos` job selects one standard `macos-15`
ARM64 allocation and runs the complete ordinary phase followed by the complete
installed phase. All six logical OS phases retain their workloads and final-gate
requirements. The [image availability decision](2026-11-05-macos-ci-image-availability.md)
continues owning the supported image and its capacity limits.

macOS shares checkout, Node.js, pnpm and dependency installation. Each validation
phase retains its own environment recorder, outcome, build, artifact names,
private fixtures and cleanup. Ordinary environment and probe uploads run before
`.tmp/validation-environment.json` and `.tmp/validation-probes.json` are cleared
for the installed recorder. An explicit non-cancellation/shared-preparation and
architecture guard lets installed validation run after an ordinary failure;
its own environment discovery must also succeed. Ordinary failure remains a job
and final-gate failure, and shared preparation failure cannot produce successful
phase evidence.

The macOS job's outer limit is 20 minutes, the sum of the former two 10-minute
job limits. Each validation command retains a 10-minute bound, with shared setup
and uploads inside the outer limit. Existing 180-second hook/callback limits and
other command deadlines retain their settings.

Runtime compatibility depends only on module detection and the Linux/Windows
ordinary producer matrix, whose Ubuntu entry supplies the packed artifact. It
has no installed or macOS dependency. Final `checks` explicitly requires
`verify-macos`, so runtime completion does not replace macOS validation.

The [development guide](../../../../docs/development.md#ci-selection) and
[repository CI guide](../../../../README.md#ci-selection) own commands and gate
selection. This partially supersedes the earlier uniform parallel topology while
preserving phase ownership and source-bound artifacts. No general phase framework,
runner fallback or cross-runner artifact protocol is introduced.

## Alternatives

**Keep two macOS allocations.** This preserves maximum compute overlap and was
the original choice. It also retains two acquisition dependencies and duplicated
bootstrap on the capacity-constrained native platform.

**Omit a phase or substitute another architecture.** Both complete macOS phases
remain required, and Intel remains outside the supported platform boundary.

**Run both suites concurrently on one machine.** This reduces allocations but
introduces CPU, filesystem and process contention between native Git and
installed acceptance workloads. Serial execution preserves their worker and
resource assumptions.

**Introduce a generic scheduler or fallback protocol.** The explicit macOS job
expresses its ordering and evidence ownership directly. A broader mechanism adds
selection and handoff rules without proving additional hosted capacity.

## Consequences

macOS requires one allocation and one shared dependency preparation. Serial
execution may lengthen its compute critical path when runner capacity is
abundant; queueing and execution time must be measured separately. The choice
does not establish independent hosted pools or guarantee allocation.

Real ARM64 allocation and both complete source-bound suites remain necessary.
Artifacts retain phase ownership despite fixed-path reuse within one job, and
ordinary, installed, cancellation and preparation failures remain visible to the
required final gate. Linux/Windows overlap, Go race selection and the other
selected CI workloads retain their existing behavior.
