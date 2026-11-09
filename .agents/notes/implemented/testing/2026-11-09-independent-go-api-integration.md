# Agent Note: Independent Go API Integration

Status: implemented

## Problem

The Go module CI job prepared production Web resources and ran normal assembled
API flows after its unit and coverage gate. A Web build or API failure therefore
shared a job result with module validation, and an earlier module failure
prevented API execution. The API runtime's process and cleanup unit tests also
had no ordinary CI entry. Production Web inputs need API build validation even
when they do not belong to the Go module's test directory.

## Decision

`verify-api-integration` is an independent Linux job that waits only for change
detection. It prepares its own Go, Node.js, pnpm and PostgreSQL service, runs the
six existing `integration-runtime.test.mts` process and cleanup tests as a
required, bounded step, then prepares production Web assets and invokes
`scripts/integration.sh`. These runtime tests depend on Linux `/proc` process
identities; their standalone command needs no database or production Web build.
The existing runner retains source and binary receipts, its local/main race
policy, bounded execution, process ownership and failure semantics. An always-run step
reconciles API resources. Artifacts include only the safe build/result JSON and
log files described by the [server guide](../../../../packages/daynight-server/README.md#go-api-integration).

The `api` selection follows server inputs plus the production Web source,
resources and build configuration embedded by the Server. Root Node
configuration and dependency patches select API integration as build inputs;
CLI-only changes do not. Documentation exclusions remain in effect. Main
pushes, CI routing and unknown paths select API integration with the existing
validation jobs. The final gate requires actual success for selected API
integration, so an unexpected skip cannot replace execution.

The Go module job retains its directory selection, isolated PostgreSQL,
build/vet, race policy and numerical coverage gates. Its portable
`scripts/check.sh` entry retains ordinary module coverage and check-tool unit
tests. Command lifecycle tests and their production coverage use the independent
[startup/shutdown job](2026-11-09-independent-go-startup-shutdown.md), with the
same server directory selection and numerical thresholds. Linux API runtime
cases run through the platform that supplies their process-observation mechanism and remain mandatory when API validation is
selected.

This scheduling complements the
[module routing decision](2026-11-06-module-validation-routing.md) and preserves
the proof owners in the
[Go dependency decision](2026-11-08-go-test-dependency-boundaries.md).

## Alternatives

**Keep API execution after the module gate.** This retains shared preparation,
but an earlier failure prevents API execution and keeps production Web building
in the module coverage job.

**Give both jobs only the Go module selection.** This separates execution while
missing API build validation for changed Web resources, build configuration or
Node dependencies used by the production binary.

**Run the Linux runtime cases through the ordinary Go check.** That entry also
supports native macOS validation. The runtime cases read Linux `/proc` process
identity and lifecycle information, so including them there makes a valid native
macOS check fail before Go validation. The independent Linux job supplies their
required mechanism without weakening or skipping the cases.

## Consequences

Module coverage, command lifecycle validation and assembled API validation
produce separate results and can run concurrently. The API job owns its complete
preparation and cleanup, adding a separate production build and PostgreSQL service while keeping failures
attributable to the suite that executes them. Build dependencies may be cached;
the tested production Server still comes from the current checkout.

Runtime-tool failure proofs enter the independent Linux API job before its
production preparation, without expanding API business scenarios or changing
the existing cases. Native Go validation retains its portable tool-test entry.
Product E2E, CLI and frontend browser tests retain their own commands and jobs. Independent scheduling does not alter
coverage thresholds or establish a measured reduction in complete CI duration.
