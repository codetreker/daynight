# Agent Note: Clean Retired Web Claims from Current Ownership

Status: implemented

## Problem

An original Worker can retain a local Web claim after current ownership has
ended. A successor claim may already own the Task's current Session. Requiring
that Session to report the original claim as unregistered prevents the Worker
from settling its old pending row and resources. Exit also preserves already
retired worktrees, leaving the same obstruction for the next run.

The Session-registration gate was introduced with Web execution in
[0.26.0](https://github.com/codetreker/daynight/blob/f630cc553e38d079e6d08a9a4ef01c68d7258d67/packages/daynight/src/commands/worker/coordinator.ts#L293-L303).
The earlier [claim inventory](https://github.com/codetreker/daynight/blob/84b9306c6a4cf2bde8ddde769cbde13e0dbac0eb/packages/daynight/src/commands/worker/coordinator.ts#L235-L241)
already selected cleanup from successful observation that the original claim
was absent. Current Session association and original local resource ownership
are separate facts.

## Decision

Successful complete own-claim inventory records that an original claim has lost
current ownership. Before the first poll and in management-only stopping,
bounded current Task reads supply the same classification. The same WorkerRemote
first verifies its principal against the original Worker account. Persisted
cleanup schedules discover responsibility but do not prove current ownership.

A retired Web claim enters immediate terminal
cleanup. Polling and shutdown share its Task-serialized executor and settlement:
stop the original Controller and Provider, close the backend, remove the original
Git worktree and settle the old local row, schedule and reservations. Original
ticket, journal and native-boundary checks remain authoritative for stopping.
Current or historical Session association is not a prerequisite, and another
claim's resources do not enter the cleanup target. The same serialized terminal
job retains existing failure recording and retry backoff. A settled job Promise
is not cleanup proof: completion also requires its original ending target to
have been cleared.

The active coordinator terminal executor installs a separate exact-claim
cleanup-command sink, so closing business admission cannot prevent its original
Git cleanup commands from starting. Each new command durably reserves a
cleanup_command ledger resource before dispatch, validates the original Worker,
instance and scope, and uses current localEpoch and intentVersion without opening
business admission or consuming the local veto. Prepared, bound and stopped
receipts retain the original command journal generation and native proof. A stale
owner or fully stopped scope cannot admit cleanup commands.

Shutdown first cancels and joins original producers. A native stop that outlives
the shutdown waiter retains its original owner; another waiter joins that work
instead of issuing concurrent stopping. The repository owner waits for the shared
Task stop before disposing its Git manager, since terminal cleanup still needs
that manager to verify and remove its original worktree. Unconfirmed Task
closure keeps the repository owner unknown and the manager open. Later
reconciliation joins the original stop and disposes Git only after complete Task
closure. Native inventory first reconciles known command boundaries, joins the
shared Task stopping result, then reconciles late terminal commands and
synchronizes matching generation and proof stop receipts into the lifecycle
ledger. This captures commands created during terminal cleanup without making
producer progress depend on a closed command gate. Current or unknown ownership
retains preserve-site stopping. Missing or incomplete Web state uses the original
Worker's Controller lifecycle resources and a batch of its existing Task launch
tickets to locate every matching execution generation. Exact ticket, journal,
Worker identity and process-boundary validation remains required; current
ownership alone cannot prove a process stopped.

Management-only reconciliation gives each Task its own original claim-request
result Promise. Cleanup candidates include pending reservations as well as saved
Task rows. Each Task awaits its own reconciliation before classifying ownership
or stopping, including pending rows saved by a late claim result. Successful
current Task reads are reused; failed reconciliation retains that Task without
making independent Tasks await its request. After original native stopping,
management-only terminal file cleanup checks that the original retained repository
directory exists, validates its repository and worktree format, and prepares its
fresh Git manager before inspecting or removing the original worktree. A pending
claim with complete empty native inventory, no known worktree or cleanup owner,
and an absent original repository can settle without Git preparation. A known
owner still requires its original Git binding to be checked. A missing directory
cannot trigger a clone, and format preparation does not query Session registration
or authorize business execution. An already formatted repository does
not populate that manager's preparation state. Failed preparation retains that
Task's cleanup responsibility for retry while independent stopping continues. Controller lifecycle reconciliation follows the Task
stop attempt, skips unresolved Task records and consumes actual
stopped journals and native-boundary results for the remaining resources.
Independent Controller checks continue after a Task stop failure. Management
Task cleanup and stopJournal retries synchronize actual command stop receipts
through the existing standalone command path; the active cleanup sink is not
installed for management-only commands.

Local resource discovery remains separate from coordinator orchestration. The
adapter owns original native boundaries, endpoints and durable stop receipts;
the coordinator owns exact Git bindings and local settlement. A complete local
inventory with no remaining original resources yields actual resource clearance,
not a fabricated Web record, Session receipt or never-started observation.
Clearance is fenced to the current cleanup attempt before releasing capacity.
Windows stopping retains its original Job lease until its durable generation
receipt is saved; a newer journal generation cannot receive an older receipt.
Generations share one current journal snapshot. Separate launch attempts within
a generation remain distinct, and the snapshot ticket_hash selects its exact
validated immutable ticket. Legitimate replacement changes only launch-local
fields while preserving the original execution intent. A reserved or unknown
launch without process proof remains unresolved unless its original producer
confirms non-dispatch or closes its launch gate. Missing process proof alone
cannot exclude a child created before its birth identity was saved. Launcher and
Controller self-captured proofs use the existing identity-preservation contract:
POSIX reparenting cannot invalidate the same PID, birth, command and nonnull
process group; Windows retains its parent and Job checks.

Controller journal schema 17 stores immutable full stopped snapshots keyed by
ticket hash. The stop CAS saves its receipt in the same transaction, and a new
writer preserves the validated preceding stopped snapshot before replacing the
singleton. Original-ticket validation and all known process proofs remain
required when consuming a historical Windows receipt. Existing current-format
16 snapshots can be observed through a narrowly validated read-only inventory
path; actual stopped maintenance performs the numbered migration under the
original permit. Read-compatible format checks also preserve the immutable v16
Bot migration copies described by the [migration decision](../architecture/2026-11-19-bot-storage-migration.md); raising the active writer format cannot invalidate a
checksum-protected original copy. Already overwritten history without a full stop receipt remains
unrecoverable from the retained data. Retained lifecycle proof still requires
its own boundary check.

This replaces the retired-Web portion of the archived
[direct shutdown decision](../../archived/bug-fix/2026-10-28-worker-direct-shutdown.md).
The [execution scope decision](../architecture/2026-11-20-worker-execution-scopes.md)
continues to own producer joins and original stop responsibility, and the
[local lifecycle decision](../architecture/2026-11-21-worker-local-lifecycle.md)
owns admission and durable resource records. The
[Worker design](../../../../docs/design/daynight-worker.md#结束清理与退出)
owns the complete cleanup and exit mechanism.

## Alternatives

**Require current Session to identify the original claim.** This gate can remain
false permanently after a successor registers. It does not strengthen the
original ticket, journal or process-boundary checks, and prevents settlement of
the retired claim.

**Preserve every worktree on exit.** This protects current execution, but also
retains resources whose current ownership has definitively ended. Applying the
same terminal executor to retired claims closes that responsibility during exit
without changing current or unknown execution's preservation rules.

**Treat a missing Windows Job name as complete stopping.** Windows temporary
objects can lose their names when the last handle closes while process references
keep the object alive. A replacement object may also reuse the old name. Neither
an absent name nor an empty object opened under that name proves that the original
boundary is empty. The [temporary object lifecycle](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/nf-wdm-zwmaketemporaryobject)
and [Job Object lifecycle](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
require retaining original-object stopping evidence.

## Consequences

Retired Web execution stops without a model-dependent cleanup turn, including
claims whose Web state no longer supplies execution identity.
Attributable external temporary resources may remain. Archive failures retain
their independent sources and retry policy; they do not gate safe worktree
removal. Native stop, backend closure and Git failures remain distinct,
observable and retryable. Successor resources and archived Session history
retain their own lifecycle.

Ownership reads add bounded shutdown work where no complete inventory is known.
Unavailable ownership and actual local lookup, stopping or deletion failures
still retain responsibility. Raw ticket discovery does not claim archive upload
or synthesize original execution history.
Original native stop and deletion deadlines remain unchanged. The numbered
journal migration adds an empty historical receipt table without synthesizing
missing evidence. Persisted complete stops survive future generation replacement;
previously overwritten unreceipted boundaries retain an explicit failure. No
reconstructed execution or fabricated stop state is introduced.
