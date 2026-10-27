# Agent Note: Worker Project Registration

Status: implemented

## Problem

A worker's acquisition scope needs an explicit operator choice. Repeating Git
addresses and clone locations duplicates Project identity already held by the
service, while automatically selecting every accessible Project makes service
membership determine which repositories can receive new task executions.
Configuration interaction must preserve explicit selection, credentials and
existing repository bindings without creating partial task resources.

## Decision

The worker selects existing accessible Daynight Projects. The repo list/add/remove
commands inspect or change the saved acquisition scope; add and remove offer
multiselection, or an explicit --project UUID for noninteractive use. Choices show
the name, complete UUID and repository URL. New registrations save the server's
original repoUrl, explicit projectId and an absolute local path. Matching existing
registrations retain their exact transport URL, path and native-agent overrides;
remote-only association adds only projectId. An equivalent HTTPS Project address
does not replace an existing SSH transport: unfinished local records retain their literal repository binding. Remove changes
configuration only, retaining clones, claims, worktrees and native history. The running process continues to use startup settings.

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
defaults and resource execution. Its public command passes an explicit
preparation callback into the runtime. An empty selection is resolved before
new task resources are created; configured Projects are registered locally
before the first complete claim inventory, including with an empty database.
The [simplification decision](../simplification/2026-10-27-worker-claim-records.md)
removes the original promise that persisted cleanup deadlines continue while a
restarted process waits for Project selection. Current-process cleanup jobs
remain separate from normal reconciliation.

After preparation, service credentials and worker settings are validated from
one captured configuration source. The service context must still match, and
maxConcurrent uses that snapshot's prepared settings. An atomic file replacement
after capture cannot supply different worker parameters under the original
service context. Restarted native processes use current applicable agent settings.


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
deadlines could advance. The six-column model has no cross-process cleanup
intent or deadline to continue; fresh project mappings and complete inventory
establish the next process's resource decisions.

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

The runtime does not rebind an initialized coordinator to changed credentials.
Restarted reconciliation first resolves its selected and saved Project scope. Independent roots and
preserved existing paths keep configuration edits from relocating original work.
Unknown or invalid configuration remains visible under the runtime's strict
omission semantics.

Shared aliases may require separating worker data before changing acquisition
scope. The refusal preserves original bytes and unaffected aliases. Configuration
changes still take effect only at the next startup; they do not stop active
assignments or erase resources retained for recovery.
