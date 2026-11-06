# Agent Note: Single-Target Web Acceptance

Status: implemented

## Problem

The earlier routine Web pipeline built two production runtimes and ran the same
complete functional inventory against both. The branches already overlapped but
each spent CPU, memory, database work and preparation on a second UI pass. A
permission handoff and shared cleanup coordination existed solely because both
targets were active.

Large journeys multiply independent layout dimensions. Claim reading checks the
Cartesian product of two claim states, two detail surfaces, three viewports and
two fullscreen states. Attachment rendering and assignment repeat complete
interactions across format, language and viewport combinations. Those checks
increase the cost of obtaining ordinary functional feedback even when the
underlying interaction and renderer are unchanged.

In [run 42159700522](https://github.com/codetreker/daynight/actions/runs/42159700522),
the heavy shard's native and container functional phases took about 289 and 279
seconds concurrently; its complete job took 432 seconds. Claim reading alone took
about 27 seconds. These are source-bound baseline observations, not a promise
that deleting a target halves elapsed time.

## Decision

Each acceptance invocation selects exactly one target. The default and required
CI target is the actual production container. Its Dockerfile builds the Web
assets and embedded Go service; dev-ci supplies the release image, nonroot
runtime, Nginx gateway, PostgreSQL, UniAuth and attachment volume. The installed
CLI is prepared once before that target starts. No host-native binary, database,
authentication fixture or duplicate browser journey is prepared for this run.

Explicit local `--native`, `--apfs` or `--stress` selects native instead.
Native functional acceptance remains available for host process and filesystem
investigation; stress retains the complete functional inventory plus the five
capacity/limit scenarios and their existing data, repetitions and budgets.
Neither mode starts a second target. Independent Go gates continue to exercise
native compilation, service HTTP behavior and embedded assets.

CI retains two case shards, one serial browser worker per database and zero
retries. `inventory.mts` remains the canonical functional/check-name owner. Each
shard executes its selection once on container, and the final gate requires their
complete disjoint union. Shard 2 owns one container combined-authentication
journey, the routine navigation selection, deployment lifecycle checks and paired
attachment backup/restore.
The backup check keeps its independent persistence and isolation proof; it can
reuse Docker layers already built by the browser deployment.

Top-level evidence uses schema 4 with a required `target`. Its target array must
contain that one target exactly once. Native resource ownership exists only for
an actual native run. Container receipts require actual image/deployment and
browser/CLI cleanup. CI aggregate validation accepts exactly the two container
shards at the current clean source/tree, with one complete combined receipt on
shard 2. Old or unknown evidence versions fail explicitly.

The dual-target pipeline and container-permission protocol are removed. A
container callback validates its existing run/source-bound parent and prepared
CLI before browser work. Navigation can still overlap container functional work
after networking is ready; both branches drain before combined authentication
restarts the service or dev-ci tears its networks down. Stage and cleanup errors
remain failures. Recovery uses the declared target and verified ownership.

### Representative browser layouts

The functional scenario IDs and their core real-service interactions remain.
Expensive layout products use an explicit representative set:

| Journey | Representative combinations |
| --- | --- |
| Claim reading | Six claim-state/detail-surface/viewport/fullscreen tuples, covering active and released, dialog and standalone, normal and fullscreen, desktop and narrow/short reading |
| Embedded and standalone attachment rendering | Every supported format on desktop, Markdown at 320px portrait and HTML in short landscape |
| Attachment menus and long-path deletion | Chinese desktop, Chinese narrow portrait and English short landscape |
| Current assignee layout | Chinese desktop, English narrow and Chinese narrow |
| Former assignee layout | Chinese desktop and English narrow |
| Assignee status keyboard interaction | One complete English narrow-screen sequence, with the other representatives retaining layout and labels |

Renderer-specific painting/scrolling, actual writes, authority refusals, unknown
results, avatar/network/cache observations and owned cleanup keep their distinct
checks. Product usability requirements at all supported sizes remain unchanged.
The test policy no longer claims every language, format, claim state, surface,
fullscreen mode and viewport combination has been exercised together.

### Routine navigation browser selection

The editor navigation-contract suite retains all 28 cases. The Team/Session and
Bot commands pass `--grep @routine`; the tag is explicit selection metadata on
unchanged case bodies. The unfiltered local configurations retain all 136 Team
and nine Bot cases. Both selected and full commands keep one worker and zero
retries.

The 20 Team/Session representatives have the following owners:

| Owner | Cases | Retained paths |
| --- | ---: | --- |
| Session record and Test Session layout | 2 | Compact record selection and accessible narrow-screen reading/navigation |
| Worker configuration | 3 | Unsaved identity retention, arrow interaction and visible save actions |
| Team preference | 7 | Drawer/layer dismissal, keyboard and native links, directory pagination, keyboard activation, account-isolated reload preference, ordinary navigation retention and Team switching |
| Team management | 3 | Create/rename/typed delete, cancel/Escape and focus, refusal versus unknown outcome without replay |
| Team membership | 5 | Team→Task→Steps, role changes, member leave, last-admin refusal and unknown outcome without replay |

The two Bot representatives retain responsive A→B→A selection with draft, search
and reading state, and details/fullscreen transitions across wide and narrow
viewports. Other viewport/state combinations remain in the full local configs.
Detailed Team member-state, invitation unknown-outcome and eight-route
restoration matrices continue in the complete Vitest/V8 suite. Those component
results do not prove the real geometry or input behavior of an omitted browser
combination.

The [shared preview decision](2026-11-05-shared-team-navigation-preview.md) still
owns the common static server, private contexts, deadlines and artifact paths.
Its original preparation savings and this later coverage reduction are separate
changes. Navigation and functional branches overlap: a shorter navigation command
does not imply the same reduction in the complete job. Branch completion, resource
competition and the final join must be measured independently.

The archived [case-shard decision](../../archived/testing/2026-11-04-web-ci-case-shards.md)
records the original partition and aggregate-gate rationale. This note owns the
current single-target shard contract and replaces the dual-target scheduling
recorded by the archived [functional overlap decision](../../archived/testing/2026-11-04-web-functional-target-overlap.md),
retaining phase-private browser ownership and CLI cleanup constraints.
The [navigation overlap decision](2026-11-06-web-browser-job-overlap.md) retains
its stable-network boundary; the permission handoff it previously joined no
longer exists. The archived [local stress decision](../../archived/testing/2026-11-03-local-stress-suites.md)
records the original separation of routine and scale workloads; the selected
native stress contract is defined above.

## Alternatives

**Keep both complete targets and tune scheduling.** Overlap already removes their
serial sum, but both browser copies and both preparation stacks still compete
for runner resources. It retains broader native UI/runtime coverage at the cost
of repeated work and coordination.

**Keep native as the ordinary target.** Host preparation can be cheaper, and the
separate attachment deployment check covers persistence. It would leave the full
UI journey outside the actual release image, nonroot runtime and gateway.
Container is the stronger single representative of deployed behavior.

**Increase workers inside a target.** Database-failure cases rename shared tables,
and profile-layout cases mutate shared personas. More workers require new
isolation and browser-evidence ownership rather than merely changing a number.
The selected reduction avoids that new mechanism.

**Preserve every layout and navigation product in routine CI.** This retains
interaction coverage at all combinations but repeats renderers, controls and
state/route proofs. Representative tuples and tagged navigation cases retain the
primary browser paths while accepting gaps for omitted combinations; complete
local navigation configs and full Vitest remain available.

**Move backup restoration to another job.** A separate runner repeats setup and
loses warm Docker layers. Keeping the existing check retains its independent
restore/epoch/isolation proof without another required job or artifact handoff.

## Consequences

Routine Web CI no longer establishes a second full UI/authentication pass on the
host-native runtime or filesystem. A defect exclusive to that combination may
pass container CI and require an explicit native run to reproduce. Restoring
that coverage is an execution-policy decision using the existing local entry,
not an implicit skipped target or a missing receipt treated as success.

An interaction defect confined to an omitted layout combination may also pass
ordinary CI. Restoring a concrete regression requires adding its representative
tuple; the fixtures remain parameterized by actual state, surface and viewport.
The complete Cartesian product is not retained as a hidden routine workload.
An omitted navigation case may expose a browser-only defect that component tests
do not catch. It can be run locally without changing its body, or included in the
routine selection by an explicit tag when a regression justifies that coverage.

Removing a concurrent target reduces total work but does not establish a fixed
job speedup. Runtime comparisons must separate the changed coverage policy from
equivalent-work efficiency, and distinguish constrained local measurements from
hosted job and complete-workflow latency. The stricter single-target evidence,
source binding and actual cleanup remain requirements for every passing run.
