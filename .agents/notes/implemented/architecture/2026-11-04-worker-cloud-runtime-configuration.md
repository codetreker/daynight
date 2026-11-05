# Agent Note: Worker Cloud Configuration Application

Status: implemented

## Problem

A remote target can change while a Worker is applying an older value or waiting
for a report acknowledgment. A successful cloud save does not establish a local
successful value. Independent file replacements can also lose a newer target
or an unreported failure even when each replacement is atomic. The configuration
channel must remain available while execution setup or task inventory fails.

Project bindings can also arrive independently of the original YAML collection.
Checking a candidate alone cannot detect overlap with another retained repository,
and concurrent checks can both pass against the same old mapping set. Nested or
physically aliased roots let one Project's legitimate cleanup affect another
Project's data.

## Decision

The [cloud resource decision](2026-11-04-worker-cloud-configuration.md) owns the
server target and independent observation revision. The Worker authenticates and
queries that resource before parsing local managed values, opening a Project
picker, preparing repositories or initializing execution backends. Only an absent
target permits a candidate projected from the captured raw YAML. Existing cloud
values remain authoritative, including an empty Project selection. Local paths,
identity, connection credentials and execution control mode retain their local
owners.

A Worker-owned configuration manager stores the target, successful item values,
current errors, unacknowledged failures and observation revision in
`configuration.json`. Its identity includes service origin, authenticated user
and Worker ID. One serialized commit owner computes receive, application-result
and report-acknowledgment transitions against the latest state. It rechecks the
target and failure identities at the head of the queue, atomically persists the
result, then publishes that immutable view. Invalid scope, corrupt data and
storage failures remain errors. Native success history remains observable. For
both global and Project native items, a new runtime validates the current cloud
target first and publishes it on success, including explicit null model and empty
arguments. Only failure of that target permits revalidating the historical
successful tuple under the current local control mode. Until either validation
succeeds, native settings remain unavailable; a tuple already validated by the
current runtime remains usable during later target application. Every result
retains the target-revision and cancellation checks at publication.

Native validation and Project adapters execute outside the commit queue and
report attempt. Independent successful scalar or native items remain applied
when another fails; no successful value means unavailable. Failed items use
bounded exponential retry, and a new target replaces old application retries.
Project readiness requires a runtime-confirmed prepared binding. A parsed native
value or received Project ID cannot establish readiness, and an unfinished
Project side effect remains pending. Already-started removal retains its own
revision until the adapter confirms completion. Persistent Project mappings
retain their separate ownership-inventory and resource-discovery purpose.

One `createWorkerRepositoryAdmission` instance serializes candidate validation
and registration. Its queue head rereads every other Project's retained mapping,
combines them with the current candidate, reuses the existing physical-overlap
validation against repository roots and the Worker state directory, then
registers the binding before admitting the next candidate. Existing and locally
supplied bindings share this entry point regardless of where a path originated.
Project network queries and repository preparation run outside that queue. The
configuration manager remains the single owner of `configuration.json` commits;
binding admission owns only validation and registration of local mappings.
Each inventory round captures the mappings it queries. Ownership loss,
retirement, archive and cleanup decisions require that the affected Project was
in that successful query. A mapping registered during the request is inspected
on a later round, and the incomplete inventory is not published. This prevents
asynchronous binding admission from turning an unqueried claim into evidence of
absence without holding the configuration channel behind repository preparation.

The existing reporter captures an immutable configuration snapshot for each
request and binds acknowledgment to it. Only an accepted observation clears
matching failures present in that snapshot. Recovery before a report preserves
the recent failure, and failures raised while that report is in flight remain
unacknowledged. Rejected observation CAS updates the comparison token without
confirming failures. Runtime owns cancellation and joining of configuration
application and reporting.

The same coordinator consumes current successful parameters. Running native
processes retain their launch arguments. Herdr restarts and Web frozen-record
recovery preserve their existing task-system semantics; configuration neither
adds task fields nor creates a claim-specific parameter or pause ledger. New
acquisition uses selected ready Projects. Retained mappings outside that target
continue advancing existing and explicitly resumed claims with applicable
validated settings or their original Web record; a selected but unprepared
Project remains unavailable. The
[Worker design](../../../../docs/design/daynight-worker.md#配置与目录)
owns runtime composition and the
[reporting design](../../../../docs/design/daynight-worker-reporting.md)
owns transport scheduling.

This decision replaces startup-only local authority for managed values after
enrollment. The [local registration decision](2026-10-27-worker-repository-selection.md)
retains initial candidate editing, local binding preservation and YAML write
ownership. The [foreground runtime decision](2026-10-27-foreground-worker-runtime.md)
retains its historical execution-controller rationale.

## Alternatives

**Apply work inside the heartbeat.** Native validation, repository preparation
or stopping can outlast the report budget and block the next observation. An
independent application loop keeps configuration and machine reporting live.

**Let each state transition replace the cache independently.** Atomic rename
prevents partial file contents but cannot prevent an old application snapshot
from replacing a newer receive or failure acknowledgment. One commit owner
serializes merge decisions as well as storage writes.

**Validate each Project binding independently.** A valid path can contain or
alias a retained Project's repository. Moving collection validation before the
queue still lets concurrent candidates pass before either is registered. Checking
the complete retained collection and registering under one admission owner
preserves the original repository-isolation requirement.

**Treat a successful send as failure acknowledgment.** The server can reject an
observation CAS while accepting the machine report, and a newer failure can
arise during the request. Binding accepted results to the sent snapshot preserves
both facts.

**Use task ownership to admit configuration changes.** Empty Workers still need
configuration and existing execution has its own recovery rules. A claim gate
would introduce cross-system ordering and storage without proving application.

**Isolate failed Project resource discovery during scheduling.** Per-Project
isolation would let healthy Projects acquire work while another repository cannot
be inspected, but a failed Git scan cannot establish that its original resources
are absent. The existing global discovery gate remains until Project preparation
and removal can preserve unknown ownership and capacity independently. The single
configuration owner and retained bindings leave that adaptation possible without
changing task or claim records.

**Publish revalidated history before checking the startup target.** A recovered
claim can launch between the two publications with an old model even when the
current cloud target is valid. Checking the target first prevents scheduling
from choosing history merely because its validation completed earlier, while
retaining historical recovery when the target fails.

## Consequences

Cloud updates can change subsequent scheduling and native choices without
reconstructing the coordinator or restarting healthy processes. Startup recovery
waits for the applicable current native target; it does not race a transient
publication of cached history. Failed targets still retain independently
revalidated historical settings. Partial failures
and unavailable values remain observable, and startup cannot silently promote
a stale local managed value to authority. Local managed writers must query cloud
ownership when the cache is absent rather than assuming a new Worker.

The cache and application loop add explicit lifecycle and persistence work.
External side effects are not made transactional by the JSON commit: adapters
must observe actual resources before confirming success, and late results must
still be applicable when committed. Binding admission serializes filesystem
validation and mapping registration while remote queries and clone operations
remain independent; a path collision fails that Project without admitting an
unsafe mapping. Configuration persistence does not become
a second task or native-process recovery system.

A failed repository preparation can leave a retained mapping that fails global
Git discovery. The current coordinator queues other eligible active work before
discovery, but defers pending starts and new claims until discovery succeeds; configuration
reporting and independent values continue. A failed clone may leave an empty
directory that the existing preparation logic will not automatically clone
again. Recovery of Project preparation and independent scheduling must retain
unknown Git, Herdr and Web ownership rather than treating an inspection failure
as an empty resource set.
