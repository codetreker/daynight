# Agent Note: Local stress suites

Status: implemented

## Problem

Routine CI discovered full-scale rendering, graph routing, archive construction,
query sampling and repeated-write workloads alongside functional tests. Browser
acceptance also rebuilt four thousand-task graphs and measured each graph five
times. Hosted runners made those workloads part of the shared PR delivery path,
although their purpose was capacity or repeated-load evidence rather than a
bounded observation of ordinary behavior.

The repository needs useful local stress coverage and dependable CI correctness,
failure, concurrency and coverage checks with distinct execution ownership.
Changing production limits or accepting partial test reports would change the
contracts being verified.

## Decision

Stress workloads have explicit local-only entrypoints. Routine CI and ordinary
local suites exclude them. Stress configs, raw workload entrypoints and tagged
Go tests reject a nonempty `CI` environment before creating stress fixtures;
changing only a wrapper command would leave direct runner bypasses.

The [development guide](../../../../docs/development.md#local-stress-validation)
owns commands and prerequisites:

| Workload | Repository-root entry |
|---|---|
| CLI high-volume rendering and full Session-v2 archive limits | `pnpm test:stress` |
| Installed CLI production decoded-byte limits | `pnpm test:stress:budgets` |
| Go query sampling, full archives and repeated concurrent overwrites | `pnpm server:test:stress` |
| Web complete graph/model/geometry proofs | `pnpm web:test:stress` |
| Production browser capacity and timing matrix | `pnpm web:acceptance:stress` |

CLI and Web `.stress.ts` files use dedicated `vitest.stress.config.ts` files and
are outside ordinary discovery. Go uses `//go:build stress` files and
`TestStress*` entrypoints in the owning packages. Its local script explicitly
selects those packages with race detection. Ordinary Go tests retain compact
archive and failure checks and a deterministic two-writer rendezvous proving
complete same-address publication and cleanup. Repeated contention remains local.

Installed CLI service acceptance selects exactly two bounded deadline probes.
The local `--stress-budgets` option keeps the server setup and strict Go gate but
selects four real 128 MiB/256 MiB exact-limit and +1-byte probes. The separate
`.tmp/project-task-service-evidence.json` and
`.tmp/project-task-stress-evidence.json` receipts identify the selected suite,
source, installation, precise scenario inventory and cleanup. Production limits
and full-size boundary assertions are unchanged.

Default browser acceptance requires thirty-two native and thirty-two container
functional scenarios (64 total), both eleven-check combined-authentication
receipts, source/browser
identity and all existing resource cleanup. Explicit local `--stress` adds five
native capacity/limit scenarios (37 native / 32 container, 69 total) after
functional execution and container/browser cleanup. It preserves all complete API datasets, five repetitions, timing
budgets, strict performance receipts and browser diagnostics. Schema 3 evidence
records `mode: functional` or `mode: stress`; exact report validation follows
that mode. Raw Playwright discovery excludes the capacity spec by default.
The later [case-shard decision](2026-11-04-web-ci-case-shards.md) distributes only
CI functional cases, with complete union validation and combined authentication
on shard 2. Local default and stress remain complete and unsharded, and a
stress/shard combination fails before preparation.
The [Web README](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns execution order and evidence interpretation.

This partially supersedes the mandatory-CI capacity scheduling in the
[quality job isolation decision](2026-10-26-web-quality-job-isolation.md),
[worker budget decision](2026-10-28-web-quality-worker-capacity.md),
[macOS acceptance decision](2026-10-22-macos-web-acceptance.md) and
[native filesystem coverage decision](2026-10-23-native-development-filesystem-coverage.md).
Their process, platform, storage and coverage ownership remains in force.
The [capacity fixture construction decision](2026-10-28-web-capacity-fixture-construction.md)
continues to own the complete local datasets and API construction rationale.
The archived [CI efficiency decision](../../archived/testing/2026-10-21-ci-validation-efficiency.md)
retains the original all-in-CI trade-offs and source-bound measurements.

## Alternatives

**Delete the full-scale cases.** This removes their maintenance and execution
cost but loses exact production-budget and complete graph evidence. Explicit
local suites preserve those checks without placing them on routine PR paths.

**Keep stress in ordinary suites and tune hosted budgets.** Worker calibration,
setup ordering or larger timeouts can change elapsed time, but leave repeated
load and complete capacity fixtures in every affected PR. Those mechanisms
remain useful for ordinary suite execution; they do not define stress ownership.

**Skip stress only when a CI wrapper sets a flag.** Direct Vitest, Playwright or
`go test -tags stress` could still execute the workload in CI. Separate discovery
and raw-entry refusal make the local-only condition hold at each actual runner.

## Consequences

Routine CI retains meaningful functional, failure, deterministic concurrency and
strict product-source coverage checks. Compact counterparts preserve routing,
curve seams, graph visibility, archive order and concurrent publication without
repeating full-scale fixtures. Necessary bounded contract tests, including exact
graph refusal thresholds and the changed-file API-limit regression, stay in CI.

A green PR does not establish full-scale latency, large-archive processing or
repeated-write endurance. Those claims require the corresponding explicit local
suite and its source/host-bound results. Local measurements do not promise
hosted latency or arbitrary graph performance. Stress maintenance remains an
ongoing cost, and changing a workload or production limit requires updating its
local case and command ownership together.
