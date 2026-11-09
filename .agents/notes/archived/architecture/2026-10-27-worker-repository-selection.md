# Agent Note: Worker Setup and Project Registration

Status: implemented

## Problem

A worker's acquisition scope needs an explicit operator choice. Repeating Git
addresses and clone locations duplicates Project identity already held by the
service, while automatically selecting every accessible Project makes service
membership determine which repositories can receive new task executions.
Operators also need to identify missing local prerequisites and understand which
native settings apply to the selected scope. Configuration interaction preserves
explicit selection, credentials and existing repository bindings without
creating partial task resources.

## Decision

The local setup and repository commands edit the initial candidate before a
cloud target is established. The later [cloud application decision](2026-11-04-worker-cloud-runtime-configuration.md)
replaces startup-only local authority for managed values after enrollment;
local writers then require cloud editing and cannot infer enrollment from a
missing cache. Local paths, independent clone roots and YAML preservation retain
the ownership described here.

Before enrollment, interactive setup reports local prerequisites, selects one
native agent and offers existing accessible Projects with current selections
checked. Candidate configuration preserves existing transports and paths, retains
compatible native settings and clears incompatible global or per-Project values
when switching agent. The summary shows the complete selection, removals and
native resets before a final confirmation. Agent defaults and the complete
Project scope are saved in one atomic update; the selected agent applies to all
selected Projects. Running processes retain their startup settings; native
processes restarted by a later runner use current applicable configuration under
the [six-column record decision](../simplification/2026-10-27-worker-claim-records.md).

The repo list/add/remove commands inspect or change the saved acquisition
scope; add and remove offer
multiselection, or an explicit --project UUID for noninteractive use. Choices show
the name, complete UUID and repository URL. New registrations save the server's
original repoUrl, explicit projectId and an absolute local path. Matching existing
registrations retain their exact transport URL, path and native-agent overrides;
remote-only association adds only projectId. An equivalent HTTPS Project address
does not replace an existing SSH transport: unfinished local records retain
their literal repository binding. Remove changes configuration only, retaining
clones, claims, worktrees and native history. These local candidate changes do
not replace an existing cloud target.

Worker owns worker.repositoryRoot, a validated raw string defaulting to
~/daynights. It is independent of review's clone-root setting. Registration
expands it using the actual injected home only for new entries; the raw setting
and existing paths are retained. The repository/location module shares pure root
and portable component calculations. Ordinary repository identities retain the
host/path layout; transport, user, port and nonordinary paths use separate
@remote coordinates. Encoded percent, empty and dot components cannot escape or
collapse those identities. Review retains its own configuration parser, YAML
writes and lifecycle.

The [foreground runtime](2026-10-27-foreground-worker-runtime.md) retains
resource execution. Current startup captures local connection/path/mode values,
authenticates and reads the cloud target before preparation. An empty target
selection remains a valid reporting Worker. Prepared selected bindings supply
execution; retained Project mappings continue serving ownership and resource
inspection independently of selection. Managed values come from the cloud
application manager rather than a second YAML read. The [Bot inventory decision](2026-11-04-worker-bot-inventory.md)
replaced the original run-time selection callback: run accepts an empty selection,
while setup and repo commands retain explicit selection. Original task inventory
and terminal cleanup schedules remain managed without selected repositories.

The earlier local-startup preparation boundary was chosen after the
[simplification decision](../simplification/2026-10-27-worker-claim-records.md)
removed the original promise that cleanup jobs continue while a restarted
process waits for Project selection. The [cleanup retry decision](../bug-fix/2026-11-04-worker-cleanup-retry.md)
then preserved original terminal deadlines and retry policy; the
[resource-state decision](2026-11-04-worker-resource-state.md) removed notification
progress storage. These decisions retain their execution and cleanup owners;
configuration exchange does not authorize unknown resources or replace task
recovery. Service identity remains captured consistently, while effective
managed settings are published by their own serialized owner.

A selection snapshot covers raw worker.repositoryRoot presence and value,
worker.repositories and service credentials. Setup adds raw global native-field
presence and values to that decoded baseline. Deep comparison handles cyclic
unknown aliases while retaining presence checks. Network and prompts hold no
configuration lock. The final cloud ownership check runs immediately before
taking the local lock; the writer then rereads current YAML, refuses related
identity/service and selection changes and preserves unrelated edits and comments. Worker and review clone-root
edits remain independent. Candidate repositories receive the same type, identity
and physical path validation as runtime configuration.

Before writing, effective unowned root and worker values and unknown fields of
retained repository entries must remain equal.
Repo commands own worker.repositories; setup owns agent/model/args/repositories.
The worker root remains unowned by both updates. Mutating a shared YAML anchor
can alter review's list or other unowned values even when worker validation
passes, so such changes are rejected without writing.
Aliases whose unrelated values remain unchanged are preserved. Registration
never clones, opens SQLite, launches native resources or acquires a claim.

Setup shares native prerequisite checks with the runtime's [Herdr
adapter](2026-10-26-worker-herdr-adapter.md). Local version, directory, runtime,
hook, effective-settings and fixed launch-argument capability checks use bounded
read-only commands; official integration state is inspected through offline
herdr integration status. Runtime [integration
preflight](../bug-fix/2026-10-28-worker-integration-preflight.md) separately installs
or updates explicitly missing or outdated integration through the private daemon,
verifies current state and checks effective hooks in task cwd. These writes do
not belong in the shared read-only prerequisite checks. Runtime reports native
resume errors directly. Independent reports are collected together, and missing
selected prerequisites allow saving with a repair instruction. The
[full-access policy](2026-10-27-worker-full-access.md) fixes tool permissions and
task-folder trust for every fresh/resumed process without changing global native
settings. Codex requires at least 0.135 for the functioning hook-trust bypass.
Provider authentication, hook execution and live daemon capabilities remain
unverified by setup.

Every launched probe settles before inspection returns. Cleanup failures,
including wrapped AggregateError causes, remain failures even during cancellation.
They cannot be reduced to ordinary missing tools or normal interruption. Setup
does not launch the worker, daemon or native agents, install tools, log in or
create execution resources.

## Alternatives

**Save agent choice and Project selection separately.** Failure or cancellation
between writes can leave a partly applied setup. One final lock-time merge keeps
both choices together while preserving unrelated configuration edits.

**Start a private daemon for prerequisite inspection.** That would require
runtime ownership and persistent resources, including possible interaction with
a running worker. Official offline status and local hooks suffice for setup;
live protocol and real execution remain runtime checks.

**Choose every accessible Project automatically.** This removes interaction but
lets membership changes silently expand acquisition scope. Persisting an explicit
selection gives add and remove an operator-owned meaning.

**Require raw Git remotes and local paths.** The service already supplies Project
identity and repoUrl. Repeating them makes duplicate or ambiguous Project
matching an operator responsibility without adding information.

**Replace retained transports with the current Project URL.** A canonical
repository identity can have distinct HTTPS and SSH transport settings. Rewriting
the stored URL changes authentication behavior and conflicts with literal local
bindings retained by unfinished tasks. Matching identity
validates the association while retaining its original transport.

**Borrow review's clone root.** Review configuration can change independently or
be absent on a task worker. Reading it couples two capabilities' destinations.
An independent worker root shares path calculations while preserving ownership.

**Prepare before entering any retained runtime.** The original detailed model
started durable cleanup discovery before waiting for Project selection, so old
deadlines could advance. The six-column model then removed cross-process cleanup
intent and deadlines; current-resource reconciliation established each new
process's decisions. Durable terminal schedules now preserve retry eligibility
without moving cleanup before runtime preparation or authorizing unknown owners.

**Read service and worker settings separately after preparation.** An atomic
configuration replacement between reads can pass the original service check
while supplying another service's paths and native settings. A single captured
source provides a consistent decision without holding a lock across startup or
pretending to detect every future file edit.

**Refresh Project metadata on every worker tick.** Acquisition bindings and
original execution records already have durable owners. Configuration-time
selection avoids changing runtime reconciliation or request volume.

**Validate only the changed worker configuration.** A shared YAML alias can make
that validation pass while corrupting unrelated settings. Comparing effective
unowned values detects the cross-capability mutation without banning aliases or
creating a general alias-rewriting mechanism.

**Remove unavailable remote Projects offline.** This could remove stale
registrations, but would introduce a separate exception to operations based on
existing remote Project identities. Current commands report unavailable remote
validation and preserve the original configuration.

## Consequences

Setup makes local missing prerequisites and effective native choices visible
before one confirmed save. Project selection remains explicit, available to
scripts and constrained by current service access. Missing terminal input, cancellation, incomplete remote
inventory and failed writes cannot produce a partial selection or new task
execution. A selected Project must remain accessible for registration management.

The runtime does not rebind an initialized coordinator to changed credentials.
Restarted reconciliation checks the cloud target before normal scheduling.
Independent roots and preserved existing paths keep configuration edits from
relocating original work. Local-owned fields and a new first-import candidate
retain strict omission semantics; stale managed YAML does not override an
existing target. The later [unknown-field policy](../bug-fix/2026-10-27-ignore-unknown-configuration-fields.md)
ignores unknown fields during projection and preserves them during edits.

Shared aliases may require separating local candidate data before changing its
scope. The refusal preserves original bytes and unaffected aliases. Local path,
connection and mode changes retain their startup boundary. Managed runtime
values are hot-applied through the cloud configuration manager without replacing
running native arguments or erasing resources retained for recovery.
