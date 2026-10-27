# Agent Note: Worker Project Registration

Status: implemented

## Problem

A worker's acquisition scope needs an explicit operator choice. Repeating Git
addresses and clone locations duplicates Project identity already held by the
service, while automatically selecting every accessible Project makes service
membership determine which repositories can receive new task executions.
Configuration interaction must also preserve cleanup deadlines already accepted
by an earlier execution.

## Decision

The worker selects existing accessible Daynight Projects. The repo list/add/remove
commands inspect or change the saved acquisition scope; add and remove offer
multiselection, or an explicit --project UUID for noninteractive use. Choices show
the name, complete UUID and repository URL. Registration saves the server's
original repoUrl, explicit projectId and an absolute local path. Repeated add
keeps the existing path and native-agent overrides. Remove changes configuration
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
worker.repositories and service credentials. Network and prompts hold no
configuration lock. The atomic writer rereads current YAML, refuses related
changes and preserves unrelated edits and comments. Worker and review clone-root
edits remain independent. Candidate repositories receive the same type, identity
and physical path validation as runtime configuration.

Before writing, effective unowned root and worker values must remain equal.
Only worker.repositories belongs to these commands. Mutating a shared YAML
anchor can alter review's list or worker native arguments even when worker
repository validation passes, so such changes are rejected without writing.
Aliases whose unrelated values remain unchanged are preserved. Registration
never clones, opens SQLite, launches native resources or acquires a claim.

## Alternatives

**Choose every accessible Project automatically.** This removes interaction but
lets membership changes silently expand acquisition scope. Persisting an explicit
selection gives add and remove an operator-owned meaning.

**Require raw Git remotes and local paths.** The service already supplies Project
identity and repoUrl. Repeating them makes duplicate or ambiguous Project
matching an operator responsibility without adding information.

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

Project selection remains explicit, available to scripts and constrained by
current service access. Missing terminal input, cancellation, incomplete remote
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
