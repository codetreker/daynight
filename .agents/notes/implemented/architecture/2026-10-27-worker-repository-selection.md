# Agent Note: Worker Setup and Project Registration

Status: implemented

## Problem

A worker's acquisition scope needs an explicit operator choice. Repeating Git
addresses and clone locations duplicates Project identity already held by the
service, while automatically selecting every accessible Project makes service
membership determine which repositories can receive new task executions.
Operators also need to identify missing local prerequisites and understand which
native settings apply to the selected scope. Configuration interaction must
preserve cleanup deadlines already accepted by an earlier execution.

## Decision

The interactive worker setup command reports local prerequisites, selects one
native agent and offers existing accessible Projects with current selections
checked. Candidate configuration preserves existing transports and paths, retains
compatible native settings and clears incompatible global or per-Project values
when switching agent. The summary shows the complete selection, removals and
native resets before a final confirmation. Agent defaults and the complete
Project scope are saved in one atomic update; the selected agent applies to all
selected Projects. Running assignments keep their original frozen settings.

The repo list/add/remove commands inspect or change the saved acquisition scope; add and remove offer
multiselection, or an explicit --project UUID for noninteractive use. Choices show
the name, complete UUID and repository URL. New registrations save the server's
original repoUrl, explicit projectId and an absolute local path. Matching existing
registrations retain their exact transport URL, path and native-agent overrides;
remote-only association adds only projectId. An equivalent HTTPS Project address
does not replace an existing SSH transport: unfinished local records and unresolved
claim attempts retain their literal repository binding. Remove changes configuration
only, retaining clones, claims, worktrees, native history and frozen execution
settings. The running process continues to use startup settings.

Worker owns worker.repositoryRoot, a validated raw string defaulting to
~/daynights. It is independent of review's clone-root setting. Registration
expands it using the actual injected home only for new entries; the raw setting
and existing paths are retained. The repository/location module shares pure root
and portable component calculations. Ordinary repository identities retain the
host/path layout; transport, user, port and nonordinary paths use separate
@remote coordinates. Encoded percent, empty and dot components cannot escape or
collapse those identities. Review retains its own configuration parser, YAML
writes and lifecycle.

The [foreground runtime](2026-10-27-foreground-worker-runtime.md) owns omission
defaults and retained execution resources. Its public command passes an explicit
preparation callback into the runtime. Cold startup prepares an empty selection
before identity, locks, SQLite, Git or Herdr. A restart with retained state first
establishes committed-cleanup discovery so persisted deadlines continue while
Project lookup or prompting waits. New task resources wait for successful
selection. After preparation, service credentials and worker settings are
validated from one captured configuration source. The service context must still
match, and maxConcurrent observes that snapshot's prepared settings. An atomic
file replacement after capture cannot supply different worker parameters under
the original service context. Existing assignments keep their original snapshots.

A selection snapshot covers raw worker.repositoryRoot presence and value,
worker.repositories and service credentials. Setup adds raw global native-field
presence and values to that fingerprint. Network and prompts hold no
configuration lock. The atomic writer rereads current YAML, refuses related
changes and preserves unrelated edits and comments. Worker and review clone-root
edits remain independent. Candidate repositories receive the same type, identity
and physical path validation as runtime configuration.

Before writing, effective unowned root and worker values must remain equal.
Repo commands own worker.repositories; setup owns agent/model/args/repositories.
The worker root remains unowned by both updates. Mutating a shared YAML anchor
can alter review's list or other unowned values even when worker validation
passes, so such changes are rejected without writing.
Aliases whose unrelated values remain unchanged are preserved. Registration
never clones, opens SQLite, launches native resources or acquires a claim.

Setup shares native prerequisite checks with the runtime's [Herdr
adapter](2026-10-26-worker-herdr-adapter.md). Local version, directory, runtime,
hook and effective-settings checks use bounded read-only commands; official
integration state is inspected through offline herdr integration status. The
runtime retains its typed RPC and original-history gates. Independent reports
are collected together, and missing selected prerequisites allow saving with a
repair instruction. Provider authentication, future task-directory trust, hook
execution and live daemon capabilities remain unverified.

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
bindings retained by unfinished tasks or claim attempts. Matching identity
validates the association while retaining its original transport.

**Borrow review's clone root.** Review configuration can change independently or
be absent on a task worker. Reading it couples two capabilities' destinations.
An independent worker root shares path calculations while preserving ownership.

**Prepare before entering any retained runtime.** This makes cold-start side
effects easy to avoid, but held Project requests can postpone existing cleanup
deadlines. Runtime ownership of the callback gives fresh startup and retained
responsibility their respective ordering guarantees.

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

The runtime protects original deadlines while configuration waits and cannot
rebind an initialized coordinator to changed credentials. Independent roots and
preserved existing paths keep configuration edits from relocating original work.
Unknown or invalid configuration remains visible under the runtime's strict
omission semantics.

Shared aliases may require separating worker data before changing acquisition
scope. The refusal preserves original bytes and unaffected aliases. Configuration
changes still take effect only at the next startup; they do not stop active
assignments or erase resources retained for recovery.
