# Agent Note: Foreground Worker Runtime

Status: implemented

## Problem

Claim ownership, local persistence, Git worktrees and native terminals have
separate failure boundaries. A foreground process must compose them without
turning a lost response into another claim, native conversation or prompt. It
also needs to retain original responsibility during pauses and cleanup while
sharing a global execution limit across repositories.

## Decision

The installed `worker run` command lazily loads its own runtime, strict worker
configuration and fixed user state. The [worker
design](../../../../docs/design/daynight-worker.md) owns the mechanisms; the
[user
guide](../../../../packages/daynight/README.md#worker-configuration-and-startup)
owns configuration and operation. Review keeps its own database, coordinator and
lifecycle. Worker composes existing typed HTTP, identity/lock, Git, Herdr and
managed-skill modules instead of introducing another delivery engine.

Configuration presence does not determine whether runtime defaults apply. A
missing file, an omitted worker mapping and omitted optional fields use the
existing defaults, with an empty acquisition list when repositories are omitted.
Only MissingConfigurationFileError means a missing file; malformed explicit
values, filesystem faults and cancellation remain errors. The configuration
reader does not create state or infer worker repositories from review settings.
Explicit repository entries still determine where new tasks may be acquired.

[Project registration](2026-10-27-worker-repository-selection.md) owns explicit
acquisition selection and its independent worker clone root. The public command
passes preparation into the runtime: cold startup resolves an empty selection
before persistent resources; retained state establishes committed cleanup first.
The original service/credential context is checked before prepared settings are
loaded for subsequent startup, without changing frozen executions.

A single coordinator owns repository rotation, capacity and per-task serial
advancement. Every inventory/acquisition round reads complete current own-claim
inventory before reconciling records and Herdr resources, then acquires new
work. Failed or partial inventory cannot authorize a new terminal decision. Only
original-claim absence triggers new automatic terminal cleanup; task status does
not classify exits. Explicit source control and irreversible terminal intent
precede ordinary recovery. A new claim never protects an old claim with the same
task ID.

The runtime reuses the existing GET /api/v1/me for the frozen startup credential
before project or inventory requests. Its user ID pins subsequent successful
responses through the existing Daynight-User-ID header, including empty list
pages. The typed client adds a current-user projection and optional expected
user-ID admission, not a new server endpoint, account registry or credential
fingerprint. LocalTask.userId retains the immutable actual claim principal;
claimAttempt carries the same principal. A stable workerId identifies the OS
worker environment, not the Daynight account.

Schema 1 migrates original user scope to null rather than assigning the current
login. Unknown ordinary/shutdown scope may be learned only from a fully matching
actual own claim. Unknown terminal/control intent cannot acquire retrospective
authority from current login or later matching. A new automatic absence decision
or recovery requires original userId to equal inventory principal: account B's
empty inventory cannot end account A's local work in the same OS environment.
Those records remain preserved/paused. Previously committed cleanup with known
original scope retains its authority and can progress before /me or project
network requests; unknown-scope intents remain preserved.

Local responsibility spans all original services for the same workerId:
committed cleanup/control and normal shutdown retain those records. Remote
inventory, new absence decisions, ordinary recovery and acquisition stay on the
current origin. Switching serverUrl does not postpone an old local deadline,
contact the old API with new credentials or query that record against the new
service. Full origin/project/task/claim scope remains intact, without a
credential registry or multi-service acquisition mechanism.

Verified remote metadata is acknowledged before Herdr ensure/list and any
filesystem wait. A full own-inventory claim matching immutable claimAttempt uses
its saved configuration, verified userId and atomic pending/attempt-clear
registration. Allowed full-identity ordinary/shutdown UID learning also belongs
to this metadata layer. Herdr unavailability must not discard successful grant
knowledge or leave its request fenced.

For matching attempts, initial new provenance follows the producer invariant
that pending commits before any resources, with preparing/no reported runtime
metadata. It is not inferred from treating a failed snapshot as empty. Reported
runtime or later phase keeps recovered/unknown native provenance with known
configuration. Existing evidence and real pauses remain; acknowledgment does not
authorize activation past predecessor or resource-ownership gates.

Only an unmatched, unmaterialized prospective-fresh preparing claim without own
Herdr/native traces enters filesystem classification across a stable predecessor
handoff boundary. Relevant persisted origin/project/task/claim/worktree
identities, original repository URL/path and optional worktree bindings are
captured before filesystem awaits. A stored binding is not required for
candidate eligibility: Git may have created the marked leaf before SQLite saved
its result. Candidates must match the same physical canonical path. That
identifies a handoff to defer, not ownership to adopt. Stable read-only
attribution still requires full claim, root/common/leaf, exact Git pointer and
branch proof; neither path presence nor a shared task UUID grants attribution.

If a captured or current predecessor owes terminal/control worktree removal, or
that removal boundary changes during asynchronous checks, classification of the
unmaterialized prospective-fresh claim is deferred without blocking or inserting
a row/configuration. A removal that starts and completes to done during the
checks still changes the boundary. The next complete inventory reconsiders the
claim after stability. A final synchronous check immediately precedes pending
insertion, with no intervening await, so old path and newer local observations
cannot be combined into false evidence that the successor already executed.
Existing pending records keep their frozen configuration and are not classified
again. Matching attempt ownership uses the earlier atomic acknowledgment and
never enters this deferral path. Other tasks and independent cleanup deadlines
continue; no state, queue or lock is added.

A stable ordinary active predecessor can still be attributed strictly, allowing
the new claim to freeze its own configuration and become pending behind the
worker's activation barrier for active predecessors with the same task UUID
across origins. New resources wait until old local responsibility is done.
Stable unattributed occupancy remains an error; ownership checks are not
weakened and old conversation/configuration is never adopted. Full claim
identities remain separate.

Actual claims become pending before activation and resources. Active
preparation, waiting, paused recovery and cleanup retain capacity; lowering the
limit does not preempt existing work. Rediscovered original resources with
missing frozen configuration retain a paused reservation rather than becoming
free capacity. Same-claim recovery retains its worktree, native identity and
configuration. One private Herdr instance serves all task workspaces.

The local store keeps only projects and tasks. Schema 2 introduced a concrete
nullable claimAttempt to each project and nativeExecution facts to each task,
with an explicit migration that leaves absent original evidence and user scope
unknown. ClaimAttempt records one unresolved task/claim/worktree/worker/user
request, exact version and decision configuration before HTTP. An actual
matching claim materializes pending with the saved configuration and verified
principal while clearing the attempt in that same transaction. registerPending
accepts the verified UID explicitly; omitted/null means unknown, not current
login. This prevents a crash between clearing the request and writing scope from
stranding a claim that subsequently ends. Definite rejection or proven
non-submission can clear it; an unknown request cannot be replayed, replaced or
cleared because an inventory temporarily lacks it. No task row exists before
grant, and no new table or acquisition queue is introduced.

NativeExecution records the actual terminal, workspace submission, verified
workspace/launch receipts, launch/prompt submission facts, immutable original
stop observation and a versioned execution-summary write. Unknown workspace
creation is not repeated because a snapshot temporarily lacks it; an observed
owned result is reconciled before any fresh environment-receipt rebind.
Submission responsibility is durable before external calls. A proven locally
undispatched current attempt can restore its never-submitted state; real
uncertainty remains fenced. Neither an empty pane nor a current rejection erases
an earlier unknown action. These are concrete consumer fields, not a generic
action log.

Every successful typed Herdr resource snapshot passes one local observation
wrapper before lifecycle facts are consumed, including ordinary execution,
manual cleanup, committed cleanup and shutdown. A full-identity owned workspace
that contradicts an unfinished row's no-Herdr-binding/workspace-not-submitted/
launch-never provenance is durably recorded through
recordObservedUnattemptedWorkspace as an UNKNOWN nativeExecution object, not
null. Original summary, including its unknown-write fence, UID, configuration,
history, resources, pauses, control and cleanup are preserved. Unknown
responsibility is accounted for before fresh capacity or strong-unstarted
selection. Failed/incomplete resource reads do not prove absence.

Git preparation is permitted only for proven launch-never provenance. Unknown
execution uses read-only discovery of its original owned worktree; a missing
original cannot be replaced with a fresh empty checkout. The observation guard
neither grants user scope nor manufactures launch or conversation evidence.

Schema 3 adds nullable nativeProcessIds to the existing stop-observation object
for exact original-native continuation. Legacy roles migrate to null without
PID-order or intersection inference, while full processIds remain the stop
proof. The original UID/origin/configuration, budget/deadline and submitted or
unknown journals are unchanged. A missing role cannot be used to replace a lost
conversation; it limits the in-place known-unsent lane instead.

This partially supersedes the memory-only acquisition choice in the
[local-records decision](2026-10-26-worker-local-records.md). That choice
avoided preclaim tasks and speculative target records while inventory could
rediscover ownership. The running consumer also needs to remember an uncertain
outbound request across restart, so the specific project field closes that
window while preserving actual-claim-only tasks and the two-table ownership
model.

The runtime validates the installed using-daynight bundle and builds an explicit
worker-managed / execute-task-in-managed prompt with absolute installed entry
and reference paths, original assignment, actual platform and frozen settings.
The agent owns business delivery, acceptance, evidence and final claim-bound
done. Live reconnection does not repeat startup input. The [Herdr
adapter](2026-10-26-worker-herdr-adapter.md) owns transport and resource
observations, and its receipt/stop gates remain authoritative.

An acknowledged original launch with a durably known-unsent first prompt is
recognized after ordinary control/config/status guards and before missing-ID
recovery/rebind. Immediate typed refusal and prior waiting outcomes retain the
original launch/process evidence and pause for explicit public retry. The
operator resolves native consent through the original attachment; the controller
checks original worktree, full binding, receipts, frozen argv, same shell and
all original nativeProcessIds against the current native key set read-only.
Ordinary children may change without replacing the original proof.

After identity verification and before the one first input, beginRecovery
consumes the existing retry permit and increments cumulative count instead of
resetting it. Original process/PTY, conversation and frozen settings remain;
there is no second native start. Submitted/unknown input or unproven missing-ID
history remains fenced, and committed control/cleanup/shutdown takes priority
over business startup input. This adds neither a reporting protocol nor a new
controller; the adapter's current-surface guard never grants native consent.

Cleanup retains its first deadline and input provenance. A lightweight discovery
loop inside the foreground process discovers this worker's persisted intents
across all origins and starts one transient job per complete
origin/project/task/claim identity with persisted cleanup or source-control
intent. Each job calls advanceCommittedCleanups(identity) and independently
waits at most one second, shortened to its nearest original deadline. A held
resource request for one task does not make other tasks wait for the whole batch
before their next advance. Same-task resource operations still share the serial
boundary. These jobs operate independently of server acquisition polling and
startup repository requests, without a persisted queue, table, ledger, public
configuration or OS daemon. A failed read creates no new absence decision and
cannot withdraw an already committed cleanup responsibility.

The driver requests attributable outside-worktree cleanup, observes a fresh
completion boundary or fixed deadline, confirms original stop, closes the
workspace and deletes the original Git worktree before local done. Unknown
cleanup input is not replayed. Ctrl+C cancels and joins the normal committed
cleanup discovery loop and all per-claim jobs before the independent bounded
shutdown scope and shared exit deadline. The private Herdr instance stops last,
after original agents are confirmed stopped.

Consuming completed interrupted shutdown invalidates its old Herdr snapshot;
ordinary execution first enumerates current resources again. Proven
never-started work or an execution with its exact original native ID can take
the normal resume path while preserving worktree/configuration, recovery budget
and pause state. If native execution may have started but its exact ID is
unavailable, confirmed stopping/closure does not authorize first launch:
original bindings, launch/prompt provenance and PID evidence are retained and
execution pauses. That uncertainty is not reset to never-submitted or an empty
conversation.

Shutdown starts active responsibilities independently and lets each pending
record observe/refresh through the same contradiction guard before deciding
strong-unstarted eligibility. There is no global pending-observation barrier
that postpones other tasks' stop/deadline. Strictly proven never-started pending
successors remain pending on normal exit: no cleanup/control,
worktree/Herdr/native resources, possible workspace/launch submission or
original native evidence may exist. They are not promoted to active merely to
shut down. After a successful complete inventory from the matching original
principal confirms absence, this resource-free claim can move directly pending
to done without a Git scan or touching an old claim's path. Other tasks'
shutdown initialization is isolated so one record's failure does not prevent
known agents stopping. Untracked resources or unconfirmed scope keep the private
instance when its safe stop cannot be established.

Only cancellation causally linked to the current worker signal, including a
preserved error cause chain, is propagated as normal interruption. It does not
add a fault pause, clear an existing real pause or reset budget/unknown-action
records. An unrelated failure remains a failure even after that signal aborts. A
read-only cancellation followed by confirmed shutdown can therefore resume the
original native session without a synthetic fault barrier.

The public `daynight worker attach` hint is advertised only after complete
inventory and managed private-instance/snapshot readiness. The [attach
command](../feature/2026-10-27-worker-attach-command.md) consumes the existing
attachment descriptor, applies routing variables and identity removals only to
the client, and leaves each existing task pane's native XDG and private HISTFILE
unchanged. It does not load worker business state or server credentials.
Diagnostics correlate original IDs, local state, recovery and cleanup errors;
neither diagnostics nor terminal idle/done authorize task completion.

## Alternatives

**Require an explicit worker mapping and repositories field.** The original
runtime required those declarations to make acquisition scope explicit. Omitted
runtime parameters already have defined defaults, and an empty acquisition list
has no implicit repository selection. Requiring an otherwise empty mapping adds
no scope guarantee; strict validation continues to distinguish omission from
invalid input.

**Treat every configuration read failure as omission.** That would let malformed
settings, access failures or cancellation select defaults. Only the dedicated
missing-file error has omission semantics, so other failures remain visible.

**Keep request identity only in memory.** Complete inventory recovers a
successful claim, but a restart cannot remember a still-uncertain outbound
request and may acquire again before that request settles. A project-scoped
descriptor retains that single uncertainty without creating a task or
generalized action ledger.

**Create pending before remote grant.** That conflates intended acquisition with
actual ownership and would require another lifecycle for rejected/ungranted
work. Projects can retain request uncertainty while task rows continue to mean
actual claims only.

**Use one reusable review/worker workflow engine.** Review owns captured PR
revisions and publication rounds; worker owns service claims, capacity and
long-lived original resources. Their concrete state and completion boundaries
differ. Narrow shared HTTP, filesystem and process primitives preserve reuse
without merging the two lifecycles.

**Infer restart safety from missing resources.** A native launch or prompt can
succeed before its reply or local result commits. Persisted submission facts and
actual resource/provenance checks distinguish never-started work from an unknown
execution. Fresh replacement resources cannot conceal lost history or config.

**Use acquisition polling to schedule committed cleanup.** A long poll interval,
failed server inventory or blocked startup project request can delay a deadline
that was already accepted and persisted. A narrow foreground cleanup loop keeps
that commitment progressing without obtaining new termination authority or
creating another resource controller.

**Wait for all tasks in each cleanup batch.** Even when calls within a batch run
concurrently, joining the entire batch before the next round makes one held task
request delay another task's deadline. Independent per-claim jobs retain each
original timing commitment; they are joined together only when the foreground
process stops.

**Reset any stopped execution to first launch after shutdown.** Process stop and
workspace closure do not identify the original conversation. When a launch may
have happened without its native ID being retained, clearing old provenance can
start a new conversation under the old claim. Pausing with the original evidence
preserves that boundary until the exact identity is recovered.

**Use worker identity or credential bytes as account scope.** The same OS worker
survives a Daynight login change, so workerId alone cannot prove whose absence
list was read. Credential rotation can also preserve the same principal.
Existing /me and response-principal headers provide authenticated identity
without persisting tokens, fingerprints or another account registry.

**Promote every pending record for normal-exit cleanup.** A never-started
successor has no resources to remove and can share a task's fixed path with an
older active claim. Promotion can collide with the active uniqueness rule and
stop unrelated shutdown initialization, while scanning the path risks the older
claim's files. Keeping strict unstarted pending state and isolating other
initialization failures preserves both responsibilities.

## Consequences

The command, discovery loop and transient cleanup jobs remain one foreground
process rather than another server or OS background service. Configuration
defaults and repository overrides have one strict owner. Omission reaches normal
authentication and runtime checks without creating an empty configuration file;
new acquisition remains limited to explicit repositories. Startup reload affects
new assignments while existing ones keep their snapshots. Fixed paths and a
stable worker identity give restarts the same record/resource scope.

An unresolved project acquisition or missing original native proof can require
inspection while other eligible work continues within available capacity.
Conservative uncertainty stays visible instead of being represented as success,
rejection or a new empty conversation. Component tests, installed-command
checks, real service behavior and native-agent lifecycle evidence remain
distinct.

The [manual-control decision](2026-10-27-worker-manual-control.md) adds explicit
release/transfer/resume/retry consumers and fresh terminal-execution identities
to these same persistence, serialization and cleanup boundaries. Complete Linux,
Windows and macOS Goal acceptance is separate from this runtime composition;
shipping the command does not assert those final results.
