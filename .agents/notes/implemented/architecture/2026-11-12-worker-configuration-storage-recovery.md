# Agent Note: Worker configuration storage recovery and execution admission

Status: implemented

## Problem

A temporary file failure can block configuration reads or a checkpoint after
native application, Project stopping or a trusted remote receipt has already
completed. Ending the Worker requires manual recovery, while admitting new work
from uncommitted configuration or retrying the whole operation can misstate actual
results and lose original ownership. Shutdown can also wait indefinitely on a
reporter whose receipt needs the same checkpoint that has not begun draining.
A failed diagnostic append may leave a partial record and cannot safely be
treated as an absent write.

## Decision

The configuration persistence owner keeps one FIFO of prepared checkpoints.
Each head is computed and frozen once from the last committed state; transient
file I/O failures retry identical state and encoding through a fresh iterator and
temporary file at 5, 10, 20, 40 and capped 60-second intervals. The manager
publishes only successful commits. Completed external effects and trusted receipts
remain owned while their callers cancel or time out; no retry re-executes effects.
Malformed format, identity and independent non-I/O errors remain failures.

Readiness closes new configuration work and execution admission while preserving the last
committed target, actual values, Project view and original work. Normal receive
and read callers share a cancellable readiness wait; finite result producers
retain their owned commits. Task configurationComplete and the separate Bot
canAdmitNewExecution callback check storage and current qualification after
awaited preparation and before first intent, registration and dispatch. Original
submitted/unknown execution and frozen native recovery/input/stop continue under
their own identity and authorization.

A recognized no-effect `agent_pane_busy` response is synchronously confirmed
before another admission wait. The specialized Herdr transition requires the
same latest generation/binding and CAS plus absence of agent, segment, input
and stop facts in that generation. Earlier assignment/input history remains
unchanged; the same prepared/not-submitted run stays resumable.
Ordinary cancellation, waiting or catch handling cannot downgrade requested,
unknown or observed execution. First Herdr Session registration carries the
dynamic guard through awaited support/current reads to the actual initial
register intent and dispatch; reconciling existing or unknown registration
and reconnect remain available. The
[lifecycle design](../../../../docs/design/herdr-worker-lifecycle.md#启动与首次输入)
owns the rejection proof and
[registration boundary](../../../../docs/design/herdr-worker-lifecycle.md#session-连接与采集段).

Shutdown begins manager drain before joining reporters or other checkpoint
producers. Five seconds bounds further retry scheduling, not the lifetime of an
active read/write/rename. The original instance lock remains held until actual
I/O and execution work end. Unsaved checkpoints return original errors and record
IDs; restart uses the durable started state and original resources. An unsaved
side effect is not assumed absent.

The diagnostic sink owns fresh dated run/segment files, a bounded queue and one
writer. Failed record appends are not replayed, because they may have left bytes;
undispatched omissions and unknown append attempts have separate counters.
Recovery creates a new segment with a path/count summary and leaves old partial
tails untouched. stderr and available monitoring report file outages. Formatting,
stdout/stderr and independent notification failures preserve their error chains.
Final close joins file/notification work after emitters and stores end; logs never
supply recovery state. The
[configuration diagnostics decision](2026-11-12-worker-configuration-diagnostics.md)
owns the explicit source, phase, certainty and actual-occurrence projection plus
five-minute summaries layered on these unchanged file and result owners.

The [Worker design](../../../../docs/design/daynight-worker.md#临时存储恢复与准入)
owns the full mechanism. The
[fact separation decision](2026-11-12-worker-configuration-fact-separation.md) and
[chunked checkpoint decision](2026-11-12-worker-configuration-chunked-checkpoint.md)
retain the same schema, provenance and atomic-file guarantees. The
[Bot execution decision](2026-11-05-worker-bot-runtime.md) retains its original
Session, stop and deletion ownership. Earlier
[log transition](../../archived/bug-fix/2026-10-27-worker-log-transitions.md) and
[GUID display](../../archived/bug-fix/2026-10-28-worker-log-guids.md) decisions still
own their historical presentation rationale.

## Alternatives

**Keep the fatal persistence path.** It preserves the last checkpoint but
requires a restart after temporary storage recovery and cannot keep owned
receipt/application completion progressing automatically.

**Retry the state update or external operation.** Fresh identities or repeated
apply/stop effects can change the result and make repeated bytes or original
resource ownership impossible to establish.

**Detach I/O at a hard five-second shutdown deadline.** A late write or rename
could outlive its instance lock and interfere with a successor. Waiting for actual
I/O preserves ownership at the cost of having no strict exit bound for a stalled
system call.

**Append recovery or replay into the failed log file.** A partial tail can merge
with a new record, and an error does not prove the original line was absent.
Fresh segments preserve queryable new records without making logs a second
recovery ledger.

## Consequences

Temporary storage outages stop new admission while original execution and
completed results remain retained. Storage recovery uses bounded retry spacing,
but its immutable head and finite completed-result queue occupy memory until
commit or shutdown. Permanent unavailability cannot guarantee new facts become
durable. Active I/O may delay exit beyond the retry window, and uncommitted
effects require conservative resource inspection on restart.

Diagnostic queues can omit undispatched records, and failed appends remain
unknown even if a complete line happens to exist. Segment families and recovery
summaries make that limitation visible; old tails are not promised valid JSONL.
Neither logging nor readiness adds a server epoch, configuration/journal schema,
execution identity or input replay rule. This storage decision originally left
non-null authority counters under their existing monotonic policy. The
[canonical authority decision](2026-11-12-worker-configuration-canonical-authority.md)
now owns exact authenticated state installation and null reimport while retaining
this checkpoint, waiter and shutdown ownership.
