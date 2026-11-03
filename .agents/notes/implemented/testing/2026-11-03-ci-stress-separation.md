# Agent Note: Routine CI and local stress validation

Status: implemented

## Problem

Functional correctness, cancellation, ownership and coverage need routine CI
feedback. Constructing maximum-size recordings, archives, response bodies and
production graph datasets consumes a different execution budget. Running those
loads in CI conflates functional evidence with scale evidence and can exhaust
otherwise unchanged command limits.

## Decision

CI runs routine functional, protocol, authentication, deadline, race, coverage
and cleanup checks. Stress workloads run only through explicit local commands.
The [development guide](../../../../docs/development.md#validation) owns commands;
the [Web design](../../../../docs/design/daynight-web.md#生产浏览器验收工具) and
[CLI design](../../../../docs/design/daynight-project-task.md#验证与交付证据)
own selection and receipts.

Classification follows the actual data constructed and consumed. One 256 KiB
frame, raw Unicode/hash boundaries and the 129-file shared corpus remain ordinary
protocol tests. Go maximum-count and multi-MiB cases use the native stress build
tag; six CLI scale cases use a separate .stress.ts configuration. Existing small
injected budgets continue to verify byte-limit behavior in ordinary tests.

The server check runs two real installed-command deadline probes by default.
Its explicit --stress mode also selects tagged Go tests and the four unchanged
128/256 MiB physical byte probes. Routine Go race, coverage and 10-minute package
and 12-minute outer bounds stay unchanged; local stress uses 20 and 22 minutes.
Every service receipt records routine/stress mode and the exact selected probe
IDs. A routine receipt makes no physical maximum-byte claim.

Web acceptance always retains both complete functional targets and both combined
authentication journeys. Native capacity is an optional callback registered only
by local --stress. Native aggregation follows the selected pipeline and requires
exactly its selected scenario set; unselected capacity produces no empty, skipped
or successful placeholder. Schema-3 evidence records the actual stress option,
while performance schema 1 and recovery ownership checks retain their formats.
Source/browser/installed identities, resource cleanup and all selected-case
failure rules apply to both modes.

The [quality isolation](2026-10-26-web-quality-job-isolation.md) and
[worker calibration](2026-10-28-web-quality-worker-capacity.md) decisions retain
their original resource comparisons. This policy changes which browser workloads
CI selects; it does not reinterpret historical full-capacity receipts as routine
CI evidence. No product limit, public API, package alias, CI-environment guard,
coverage exclusion, check name or protected-merge requirement changes.

## Alternatives

**Optimize large fixture construction only.** It may reduce preparation, but CI
would still execute the production-scale workload and retain its stress cost.

**Use short-mode or environment-driven skipping.** The pinned Go runner already
supports build tags, Vitest has explicit discovery and Web owns its callbacks.
Selecting those mechanisms avoids collecting then skipping stress cases or
creating a second ambient selection rule.

**Add a stress CI job.** It would still run stress workloads in CI, contrary to
the required responsibility split.

**Change production limits or add a test configuration API.** Existing small
budget injection and local physical-boundary tests already cover both purposes;
a production interface would expand the product contract unnecessarily.

**Add a shared cross-runner framework.** Native build tags, a nested Vitest
configuration and existing runner options already provide selection without new
resource handoffs or result transport.

## Consequences

Routine CI retains meaningful functional failure paths and unchanged strict
coverage denominators. Physical maximum-size and performance evidence requires
an explicit local stress run on the tested revision. Limits and original stress
assertions remain intact, and no stress result is inferred from absence.

Local stress commands cost more time and memory and can leave owned resources
after interruption. Existing cancellation, recovery and cleanup obligations
remain mandatory. Measurements stay bound to the workload, source and runtime;
this separation does not promise a particular hosted-CI speedup.
