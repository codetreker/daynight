# Agent Note: Task Lifecycle Cross-layer Acceptance

Status: implemented

## Problem

Service transitions and isolated client checks do not establish that an installed
CLI, a migrated database, the built service and production browser agree on the
same tasks. HTTP races do not exercise competing CLI processes, and a migrated
current-schema fixture does not prove startup preserves historical rows. Shipped
workflow text also needs artifact validation without mistaking it for observed
Agent decisions.

## Decision

The existing acceptance owners provide complementary evidence for the
[three-state setter](../architecture/2026-10-24-task-status-assignment.md). The Go
command fixture retains its built race binary, isolated PostgreSQL schema,
project-row barriers, structured request logs and restart/cleanup ownership. The
production Web runner reuses its existing packed CLI, native and container
services, browser phases and request allowlists. Native CLI acceptance validates
the actual installed package. The
[authentication activation](../architecture/2026-10-22-authentication-activation.md)
provides normal real-UniAuth sessions/PATs and explicit membership. Browser and
packed CLI share the fixture's actual Alice identity; private origin-matched
configuration remains with the existing credential/cleanup owner. Controlled
upstream-provider responses remain distinct from the real gateway/SDK flow.
No second runner, test-only service API, database configuration channel,
authorization bypass or production transition is added.

### Historical migration and real CLI processes

`installed_cli_v12_status_migration_restart` prepares a genuine isolated v12
schema using checked-in migrations 001–012 and records raw rows and checksum
ledgers before starting the built service. Production startup applies 013 platform followed by 014 status. A separate prefix13→14
status-only fixture preserves non-null platform values; v12 rows acquire the
expected nullable platform column before state conversion.
Only proposed rows become todo with version/update-time advancement; all other
fields, timing, permission, properties, ordinary/external edges and attachment
bytes survive. Non-proposed rows remain unchanged. Default/CHECK conversion,
overflow rollback and restart idempotence are independent assertions. Explicit
fixture membership establishes authorized access without startup adoption or
rewritten migration history. The installed CLI reads the new state/defaults and
refusals through normal authenticated HTTP.

Installed same-version races separately cover start, done, distinct targets,
dependency-edit/start and same-state requests. Two genuine CLI processes wait
behind project-row locks with observed database waiters. Changed races require
one commit and one visible version_conflict; current same-state requests both
succeed with no stored change. Correlated logs, process exits, full snapshots and
attachment bytes prove exact revision/timing effects and no hidden retry.
Native service/HTTP cases separately order ordinary/external reopening against
successor start/done. One observed process scheduling outcome does not prove
every interleaving.

The installed platform/status matrix runs independently as
`TestInstalledCLIPlatformAcceptance` / `installed_cli_platform_status_workflow`.
It retains all four platform values across nine status pairs and the original
project/task workflow retains its assertions. Separate owned database, installed
CLI workspace and server fixtures give each scenario the existing 45-second
server lifetime; the matrix does not consume the main workflow's process budget.
The platform scenario requires graceful SIGTERM exit 0 and normal cleanup evidence.
Its source-bound runtime receipt remains distinct from source inspection or this
scenario description.

### One task graph across CLI and browser

Production annotations task-status, task-status-conflicts, task-status-recovery
and task-status-transitions use the packed CLI, real authenticated service,
PostgreSQL and browser on the same tasks. They cover arbitrary transitions,
direct completion, reopening, current same-state +0, stale same-state conflicts,
shared status/permission gating, exact +1 changes and material preservation.
Prerequisite and active/done dependent refusals include ordinary/external edges.
Derived readiness can change without changing the dependent's own version.
Graph/detail/list readback, complete descriptions versus list omission, PRs,
timing, classifications and raw attachment bytes remain separate observations.

Only registered project/task status PUTs with exact request counts and declared
fixture-file mutations are admitted. CLI metadata changes invalidate reviewed
Web versions; new writes require another decision. Pending operations retain
ownership across SPA navigation, detail closure and identity boundaries. Unknown
outcomes first confirm an actual service commit and then drop its browser response;
failed reconciliation GET is controlled separately. GET-only recovery never
resubmits or attributes observed state to the uncertain request. Large-int64
cases use actual GET/PUT digits and database results independently of multi-hop
version growth. Graph failures use owned real failure paths. Redacting request
forwarding preserves original method, headers, body and Origin validation.

Production inventory remains 28 functional scenarios per target plus five native
capacity/limit cases (33 native, 28 container). Source-bound runtime receipts,
strict coverage, performance, one-worker/no-retry and cleanup gates are unchanged.
Transport barriers and offline fixtures establish their declared boundaries;
they do not replace actual status-changing database requests.

### Installed instructions and source attribution

The installed skill fixture validates all six resources, YAML frontmatter,
contained prose references and content digests on the packed installation and
published target copies. Fenced task examples remain examples. Bounded
cross-reference instruction contracts check todo registration without execution, explicit
execution scope, ready successors, manual fixed queues versus permission-filtered discovery,
versioned status setting, resume, conflict, unknown outcome, open-PR retention, accepted completion
and shared Markdown/Goal ownership. Their receipt identifies the input,
obligation and resource/section evidence, with agentExecution false. Existing
native terminal installation and byte-copy checks remain distinct. Artifact
contracts establish shipped instructions and discovery, not actual model
compliance or live provider behavior.

Existing source receipts add required gitTreeSha from actual
`git rev-parse HEAD^{tree}`:
`source.gitTreeSha` in shared packed-CLI and Web source records, and root
`gitTreeSha` in Go acceptance. Handoff, callback and recovery validation require
matching commit, tree, dirty state, package and artifact identities. Missing or
mismatched tree identity fails; no schema-version bump or legacy fallback
reinterprets an incomplete receipt. A tree identifies committed content; dirty
state is not a digest of modifications, and tree equality alone proves neither
an executed gate nor reviewer approval. Original artifact and platform identities
remain intact under the [evidence ownership decision](../process/2026-10-20-source-bound-validation-evidence.md).

The [server README](../../../../packages/daynight-server/README.md#built-process-acceptance-and-ci-evidence)
and [Web README](../../../../packages/daynight-web/README.md#production-browser-acceptance)
own repeatable commands, scenario mappings and receipt interpretation. This
extends the [installed project/task](2026-10-20-installed-project-task-acceptance.md),
[built-process](../../archived/testing/2026-10-19-server-process-acceptance.md) and
[dashboard acceptance](2026-10-20-dashboard-production-acceptance.md) decisions.
The [attachment cross-layer decision](2026-10-21-task-attachment-cross-layer-acceptance.md)
retains original-byte, rendering, reader-input and K1 storage boundaries; shared
artifacts do not collapse those separate proofs into this lifecycle journey.

## Alternatives

**Create another combined acceptance runner.** It would duplicate service,
database, installation and cleanup ownership. The existing Go and Web fixtures
already expose the actual boundaries required by the journey and preserve their
own platform and fault-injection constraints.

**Relabel service or HTTP races as installed-client proof.** Those checks can
order transactional interleavings but do not execute command parsing, installed
process failure and retry behavior. Real CLI competitors supplement rather than
replace those deterministic checks.

**Seed the current schema and rewrite its migration history.** That avoids
preparing the historical SQL prefix but cannot prove production startup applies
the genuine migrations while preserving rows and the original checksum ledger.
Executing the checked-in prefix before launching the built service preserves the
actual upgrade boundary.

## Consequences

The receipts connect the same resources across installed commands, service
transactions, database upgrades and production views while preserving each
oracle's provenance. A failed assertion, interrupted operation or cleanup remains
a failed acceptance result. Task-owned processes stop and are reaped before
schemas, installations, storage roots and browser profiles are removed; retained
original failures are not replaced by cleanup success.

Real PostgreSQL/process/browser evidence, controlled client transport/provider
fixtures and installed instruction artifacts establish different facts. Local
Linux results do not establish hosted macOS/Windows or container success, and
native installation launchers do not exercise live Agents. Required runtime,
platform, protected-delivery and independent-review results remain tied to the
actual PR/CI source and are not accumulated as rolling Markdown counts or hashes.
