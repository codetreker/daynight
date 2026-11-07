# Agent Note: Independent macOS CLI Validation

Status: implemented

## Problem

Ordinary CLI verification and installed CLI acceptance validate independent
outputs. Combining them in one macOS runner serializes both workloads and gives
them one job result, while Linux and Windows expose each phase as an independent
job. Reusing fixed receipt paths also requires explicit clearing and special
continuation conditions after ordinary failures.

The [single-allocation decision](2026-11-05-single-macos-native-allocation.md)
reduced acquisition dependencies after hosted capacity prevented one of the two
macOS phases from starting. That remains a real scheduling cost of independent
jobs, separate from their execution time and failure isolation.

## Decision

macOS ordinary verification runs in `verify-macos`; installed acceptance runs in
`verify-macos-installed`. Both depend only on module detection and use the same
CLI selection condition. Each job independently checks out the source, prepares
Node.js 24 and pnpm, installs locked dependencies, asserts Darwin ARM64 and
records its own native environment on a standard `macos-15` runner. The
[image availability decision](2026-11-05-macos-ci-image-availability.md) owns that
image and the supported architecture boundary.

Ordinary verification retains type checking, its build, development-installer
tests and the complete ordinary Vitest suite under the
[termination observer](2026-11-05-native-test-termination-diagnostics.md).
Installed acceptance retains its build and the complete
`vitest.acceptance.config.ts` suite. Each validation step has a 10-minute limit
inside its own 20-minute job limit, including setup and uploads. Test, hook and
command deadlines retain their settings.

Separate workspaces give each phase its own fixed receipt paths. Environment,
probe, acceptance and ordinary termination artifacts retain their phase names
and failure-upload behavior. No clearing or cross-phase continuation guard is
needed. Final `checks` waits for both macOS jobs, and either failure or
cancellation fails the gate. Runtime compatibility still consumes the ordinary
Ubuntu package and has no macOS or installed-acceptance dependency.

The [development guide](../../../../docs/development.md#ci-selection) owns current
commands and gate selection. This replaces the single-allocation topology while
preserving all six native platform phases and their evidence responsibilities.

## Alternatives

**Keep the single macOS allocation.** This needs one acquisition and one
dependency preparation, but keeps the two independent workloads serial and
requires receipt handoff and special failure continuation within one job.

## Consequences

macOS phases can execute independently and expose separate job results. An
ordinary failure cannot prevent installed acceptance from preparing and running;
artifacts need no ordering across phases.

Two macOS allocations and two dependency preparations are required. Actual
elapsed time depends on hosted capacity and scheduling, so independence does
not guarantee a shorter run or repair acquisition failures. Both complete
source-bound ARM64 results remain necessary whenever CLI validation is selected.
