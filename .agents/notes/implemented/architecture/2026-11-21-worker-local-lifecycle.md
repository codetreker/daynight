# Agent Note: Persistent Local Worker Lifecycle

Status: implemented

## Problem

A stop decision can arrive after an execution has passed a scheduling check but
before a Controller dispatches native work. Restart can lose in-memory admission,
producer ownership and the distinction between an unknown request and a stopped
process. A cloud response alone cannot prove local stopping, durable preservation
or eligibility to recover the original execution.

## Decision

A private Worker SQLite database owns local admission, the durable veto, epochs,
resource reservations, original lifecycle operations and observation outbox.
Reservations and local closure serialize in that database. The
[management root and execution scopes](2026-11-20-worker-execution-scopes.md)
retain their original ownership: management survives closure, while every new
scope receives fresh objects and cancellation. Controller tickets and journals
freeze the same lifecycle binding; final Provider boundaries read the original
persistent authority, including after asynchronous preparation. Controller resources
also retain their original ticket and journal storage root. Bot-local storage
cannot be replaced by the default root during Windows stop verification; legacy
resources derive a root only from their frozen canonical journal path and still
verify the original execution and lifecycle binding.

Active coordinator terminal jobs reserve exact-claim cleanup commands through
`reserveCleanupCommand` before native dispatch. The reservation records a
`cleanup_command` resource, retains the original service, account, Worker,
management instance and scope generation, and validates their current binding.
It uses current localEpoch and intentVersion while allowing business admission to
remain closed, including a local veto. Stale instance or scope identity is refused;
cleanup cannot substitute a new owner. The original command journal generation
continues to own prepared, bound and stopped evidence. Ordinary business commands
remain subject to the closed admission gate.

Task Web and Bot tickets can exist before launch submission. A later Worker
lifecycle or a durable never-dispatched reservation may require a fresh local
launch identity. Current admission authorizes it only when the durable execution
proves that generation never submitted and has no current Controller process or
uncertain startup evidence. Claim, Session, native identity, recovery generation
and budget, initial operation, prompt and frozen configuration remain unchanged.
An initial Task launch requires no journal execution; a recovery launch accepts
only the matching stopped preceding generation. A reservation used as
never-dispatched proof must match the original ticket hash, identities and storage
paths, with durable terminal state and no process proof. Immutable ticket and tool
selection evidence are published before atomically changing the saved launch
reference. Prior tickets and lifecycle responsibilities remain available for
reconciliation. Terminal reservations are preserved rather than reopened when
configuration admission recovers. Submitted or uncertain launches cannot use this
replacement path.
For an allocated never-submitted recovery generation, an explicit retry verifies
the original preceding journal and process-tree stop before atomically consuming
its allowance and clearing pause and orderly-shutdown markers. The same commit
updates an existing startup report's recovery summary without replacing startup
evidence. Ticket preparation follows this transition, so pending pause markers
cannot prevent authorized ticket renewal. Continuing after a storage wait retains
the consumed allowance and does not increment the budget or generation again.

Tool selection remains alive through configuration jobs and their final state
publication. A configuration failure stays with that owner while tool cleanup
still runs. Native inventory reconciliation independently joins each original
owned command or Bot CLI probe, including original initialization, its in-flight
close and terminal save;
it does not wait for a whole producer whose Git jobs may require that same
reconciliation to finish. Inventory then joins shared Task stopping, reconciles
late terminal commands and synchronizes stopped receipts with matching original
generation and process proof into the lifecycle ledger. Management Task cleanup
and stopJournal retries synchronize those receipts through their existing command
path as well; they do not gain the active-runtime cleanup sink. Errors aggregate
without skipping independent resource checks. A lifecycle admission refusal before
a reservation write retires the attempted
owned command as never started and removes its in-memory admission marker.
Persistence failures with an uncertain outcome retain the original responsibility
and marker for reconciliation; they cannot use the never-started path. Individual
failures retain unknown responsibility without preventing other resources from
reconciling. Windows probes that assigned
the original guardian to a Job, terminated that Job and confirmed it empty still
join the guardian, streams and handles, but do not issue a second direct
termination against the exited process. Initialization without a successful Job
assignment retains its original guardian cleanup.

During startup and ordinary polling, management authority reads and observations
progress independently of failed stop/save reconciliation and unavailable
original resume-intent lookups. Unknown instance-registration outcomes still
fence registration of a replacement management instance. Once registered,
startup retains that instance and reports while execution reconciliation remains
pending; activation still requires confirmed stopping and resolved operations. Reports
retain the known inventory, blocked state and original unresolved responsibility;
a failed reconciliation cannot become proof of stopping or authorize admission.
A newer disable can therefore receive observations while older work is unresolved.
Successful local activation commits also complete retained initialization before
notifying an execution owner to rebuild. An explicit resume may resolve an older
request after startup returned with reconciliation pending; its committed
activation must prevent the next poll from repeating startup stopping against the
new scope. Failed, unknown or superseded activation cannot use that completion
path.

Local disable saves its veto before IPC or network access. IPC wakes the original
manager and does not stand in for resource evidence. An unavailable manager permits
management under the original free instance lock, without taking over a live lock
or launching a business scope. The original identity must already exist.
Explicit management owners can stop original local resources without a saved
service token. Their network methods refuse before dispatch; missing credentials
cannot settle a cloud request or authorize recovery. Task candidates include
original pending claim reservations. Each Task joins its own claim-request
reconciliation before classifying ownership or stopping and reuses its successful
current Task read. Independent Tasks do not await one another's requests. Failed
reconciliation retains that Task; matching Controller lifecycle checks follow the
Task stop attempt and skip unresolved Task records.
The [retired Web claim decision](../bug-fix/2026-11-23-worker-retired-web-cleanup.md)
owns terminal removal after confirmed ownership loss; normal lifecycle stopping
continues to preserve current or unknown execution.

Explicit resume freezes the local epoch when accepted, before entering the
management queue. It validates that epoch after initialization, original-operation
reconciliation, stopping, authority reads and reporting, before submitting intent.
Activation also validates its frozen epoch after result reconciliation and before
dispatch following a report. A later local disable invalidates the original
resume; reading a newer binding cannot authorize it to consume the newer veto.
Resume consumes complete original stop/save evidence and online service
activation before opening local admission. Original requests are queried or
resolved under their original identity; activation has its own child phase.
The current management instance retains the resume continuation independently of
its observed intent version. A lost intent response or a failed stop/report does
not erase the next activation step. A newer disabled intent for the same
management instance retires an obsolete
activation continuation both before its observation is accepted and after its
activation result is known. The original operation ledger retains confirmed and
unknown outcomes independently of that continuation. The ordinary management loop
reports the current stop before querying superseded unknown activations under
their original identities. Failed queries preserve stop reporting and block new
activation; resolved outcomes allow a later explicit resume to proceed. An
unavailable authority read is not evidence of supersession. Local intents retain
their frozen request;
only an operation first observed remotely gets a requestless ledger entry.
Continuations bind the original local epoch and management instance, so a later
veto invalidates them. They are not reconstructed after process restart: an
interrupted resume still requires a new explicit request.
Management instance registration follows a confirmed lightweight Worker report,
which establishes the server-side Worker prerequisite without native probes. A
registration refused because the Worker record was absent remains in the ledger;
a new registration decision requires confirming that prerequisite again. Other
refusals do not permit this retry. Unknown registrations retain their original
request identity and must be resolved before another decision.
Normal reconnect and initial bootstrap cannot clear a local veto. Their activation
eligibility checks current persisted veto, desired state and intent version after
registration and reconciliation awaits; an earlier initialization snapshot cannot
erase an intervening stop decision. Independent Task pauses, claims, worktrees, native context and recovery budgets remain owned
by their existing mechanisms. A management-only command's activation receipt does
not mean a foreground Worker execution scope started.
Per-execution recovery observations come from the original Task and Bot owners
and are saved in the observation outbox. They retain independent blockers and
unknown results; opening the Worker gate alone cannot establish eligibility.

The [Worker design](../../../../docs/design/daynight-worker.md#持久停用与恢复)
owns the local state and command contracts. The
[service authority decision](2026-11-20-worker-lifecycle-authority.md) owns cloud
ordering and resolution. The retirement of
[released-Task resume](../simplification/2026-11-12-retire-worker-resume.md)
continues to prohibit a separate claim-eligibility exception.

## Alternatives

**Use cloud intent as the only stop authority.** An offline local stop could not
prevent new dispatch until the next successful request. An independent veto adds
storage and reconciliation but preserves the decision before network access.

**Check only the Worker loop or Controller input queue.** Already admitted work
can cross asynchronous setup and dispatch later. Persistent checks at the final
native boundary bind that dispatch to the same closed gate and generation.

**Treat a completed producer or matching external object as success.** A producer
can finish after losing a write response, and an existing object need not have
been created by that operation. Keeping the child request independently unknown
prevents false stopping and unsafe recovery.

**Use intent-version changes as the only activation trigger.** Observing a new
version can succeed before its operation query or local stopping fails. Later
polls then see no version change and cannot finish the accepted resume. Keeping
the continuation within the current manager permits result reconciliation without
turning an old enabled cloud intent into restart authorization.

**Read the local epoch only when sending resume intent.** Initialization, stop
verification and reporting can span a newer local disable. Using that later epoch
would let an older resume erase a veto it never accepted. Freezing before queueing
also prevents time spent behind another management operation from granting that
authority. Requests already sent retain their original result reconciliation and
unknown outcomes; invalidation does not prove they were never committed.

**Wait for every producer before reconciling native inventory.** A configuration
Git job can be waiting for the inventory to confirm its original command closure.
Waiting for that whole producer creates a cycle. Resource-specific reconciliation
retains the original close operation while allowing independent boundaries to
make progress.

**Require execution reconciliation before establishing management observation.**
An unavailable original outcome or retained owner would hide all startup inventory
and newer stop intentions. Only unresolved management registrations block a new
instance; execution readiness separately gates activation while the registered
instance reports the unresolved facts.

## Consequences

The database, original journals and process proofs must be retained together.
Missing authority, incompatible schemas, unknown native stopping and unjoined
writers block recovery instead of permitting replacement identities. Local stop,
durable save and cloud synchronization remain independently observable.
Network failures preserve previously confirmed local stop/save evidence. Closed
old-generation resources and completed observation deliveries move to compressed
history with their complete canonical JSON and SHA-256. Unresolved resources
remain live. A report covered by a newer authority keeps that coverage proof
without claiming its original upload succeeded.

Ordinary assistant event, record, item, answer and attention writes currently
lack an original-operation result protocol. An unknown outcome remains a retained
responsibility and can block complete stop/resume; read-only discovery cannot
repair that protocol gap. Session acceptance confirms dispatch only, while native
stopping still needs its original owner. Platform and Provider acceptance require
runtime evidence beyond protocol and storage checks.
