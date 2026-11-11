# Agent Note: Independent macOS CLI Validation

Status: implemented

## Problem

Ordinary CLI verification and installed CLI acceptance validate independent
outputs. Combining them in one macOS runner serializes both workloads and gives
them one job result, while Linux and Windows expose each phase as an independent
job. Reusing fixed receipt paths also requires explicit clearing and special
continuation conditions after ordinary failures. Dedicated macOS job definitions
would duplicate the setup and validation already owned by the native matrices.

The [single-allocation decision](2026-11-05-single-macos-native-allocation.md)
reduced acquisition dependencies after hosted capacity prevented one of the two
macOS phases from starting. That remains a real scheduling cost of independent
jobs, separate from their execution time and failure isolation.

## Decision

The ordinary `verify` and installed `verify-installed` jobs both use an OS matrix
containing `ubuntu-latest`, `windows-latest` and `macos-15`. The
[Windows shard decision](2026-11-11-windows-cli-verified-shards.md) assigns two
ordinary Windows entries to the complete phase; all other native phases retain
one entry. Each matrix entry prepares its own runner, and both matrices depend only on module detection with
the same CLI selection condition and `fail-fast: false`. All entries use common
checkout, Node.js 24, pnpm, locked dependency installation, environment recording
and build steps. Every job has the same 10-minute limit, including setup,
validation and uploads. Test, hook and command deadlines retain their settings.

Conditional macOS steps assert Darwin ARM64 in both matrices. Ordinary macOS
verification runs the complete ordinary Vitest command under the
[termination observer](2026-11-05-native-test-termination-diagnostics.md) and
uploads its diagnostics. Linux runs that command directly. Windows runs its two
built-in file shards and the final gate verifies their actual execution union.
Source
type checking and development-installer tests remain ordinary responsibilities;
installed acceptance executes the complete `vitest.acceptance.config.ts` suite.
The [image availability decision](2026-11-05-macos-ci-image-availability.md) owns
the selected macOS image and supported architecture boundary.

Separate workspaces give each phase its own fixed receipt paths. Matrix-expanded
environment, probe and acceptance artifact names retain the existing platform
and phase identities; Windows ordinary artifacts also identify the shard.
Ordinary macOS termination evidence remains exclusive to
its ordinary entry. No clearing or cross-phase continuation guard is needed.
Final `checks` waits for both matrix jobs, so a failure or cancellation in either
phase on any native platform fails the gate.

Runtime compatibility depends on module detection and the ordinary `verify`
matrix. Its package is produced only by the Ubuntu ordinary entry, but the
matrix dependency also waits for ordinary verification on Windows and macOS.
Installed acceptance remains independent of runtime compatibility.

The [development guide](../../../../docs/development.md#ci-selection) owns current
commands and gate selection. This replaces the single-allocation topology while
preserving all six native platform phases and their evidence responsibilities.

## Alternatives

**Keep the single macOS allocation.** This needs one acquisition and one
dependency preparation, but keeps the two independent workloads serial and
requires receipt handoff and special failure continuation within one job.

**Define dedicated ordinary and installed macOS jobs.** Separate jobs restore
phase independence, but duplicate common setup and validation and permit
platform-specific job limits to diverge. Adding macOS to the existing matrices
keeps those responsibilities and limits uniform, with conditional steps only
for architecture enforcement and ordinary termination diagnostics.

## Consequences

macOS phases can execute independently and expose separate job results. An
ordinary failure cannot prevent installed acceptance from preparing and running;
artifacts need no ordering across phases. Native setup and phase ownership have
one matrix definition per phase.

Two macOS allocations and two dependency preparations are required. Actual
elapsed time depends on hosted capacity and scheduling, so independence does
not guarantee a shorter run or repair acquisition failures. Runtime checks now
wait for ordinary macOS verification through their existing matrix dependency.
Both complete source-bound ARM64 results remain necessary whenever CLI validation
is selected.
