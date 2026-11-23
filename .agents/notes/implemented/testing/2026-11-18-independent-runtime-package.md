# Agent Note: Independent Runtime Compatibility Package

Status: implemented

## Problem

Node.js runtime compatibility needs a built CLI package, but ordinary CLI
verification also runs a full native test matrix. Waiting for that entire matrix
before starting runtime checks extends the critical path beyond the actual
package dependency.

## Decision

An Ubuntu `prepare-runtime-package` job depends only on module selection and
builds and packs the CLI from the current workflow checkout. The runtime matrix
depends on that job and module selection, and downloads its current-run artifact.
The final gate requires the producer and runtime matrix to succeed when CLI is
selected, alongside all ordinary and installed native checks. The
[development guide](../../../../docs/development.md#ci-selection) owns the
current validation details.

This separates the package dependency from the ordinary matrix described in the
[independent macOS validation decision](2026-11-07-independent-macos-cli-validation.md),
without changing native phase ownership.

## Alternatives

**Keep the Ubuntu ordinary producer.** This avoids another installation and
build, but the runtime matrix waits for all ordinary matrix entries, including
Windows and macOS, despite consuming only the Ubuntu package.

## Consequences

Runtime checks can overlap ordinary tests when runners are available. The extra
Ubuntu allocation, dependency installation and build increase runner work;
queueing and the longest remaining critical path determine actual elapsed time,
so the topology does not guarantee a fixed speedup. Package production failure,
cancellation or an unexpected skip still fails the selected CLI gate.
