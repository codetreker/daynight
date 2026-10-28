# Agent Note: Worker Claim Foundation

Status: implemented

## Problem

Task status alone does not identify an execution owner. Concurrent machines can
observe the same ready task, and ordinary property writes could overwrite an
execution record. Interrupted work needs explicit resource and history ownership
while distinguishing the authorized actor from a receiving user. A lost response
cannot establish whether ownership changed.

## Decision

The [claim foundation](../../../../docs/design/daynight-worker-claims.md) stores
the latest typed worker record in task properties and applies every ownership
mutation within the existing project write transaction. Read/stored properties
and public property patches have separate codecs: public create/PATCH rejects
worker even when its value is unchanged, while PR and worker updates preserve
each other. The text migration inserts explicit null without JSON/JSONB
conversion, preserving opaque PR strings, task versions and timestamps.

The [session mode contract](2026-10-27-task-session-mode-contract.md) extends the
protected claim with its frozen execution mode. Legacy records retain Herdr
semantics, and Web claims reject Herdr resource bindings. Mode metadata does not
establish controller startup or native session availability.

Automatic acquisition rechecks member access, the exact task version, readiness,
permission, platform and existing ownership before installing one active claim.
Claim-bound done uses the existing status resource; ordinary status changes
cannot release active execution or start/finish released unfinished work.
The foundation originally required release/resume/transfer to continue the source
worktree and agent, protecting unpublished results when ownership moved. The
[manual-control decision](2026-10-27-worker-manual-control.md) supersedes that
continuity requirement: ended claims complete source cleanup, while resume and
transfer create fresh claim/worktree identities and may select a different agent.
The manual execution exception to automatic eligibility remains on resume.
Transfer still requires a source owner/admin actor and a separately validated
current target member.

Callers generate a fresh claim UUID for each acquisition or transfer and never
reuse it. The service rejects the latest ID's reuse and requires the current
claim plus an exact task version for subsequent writes. The foundation
originally required persisting that ID before either operation; the
[local-records decision](2026-10-26-worker-local-records.md) separated actual
task registration from acquisition intent and initially kept request identity in
memory. The [foreground runtime](2026-10-27-foreground-worker-runtime.md) now
persists one concrete unresolved claimAttempt in the project before HTTP while
still creating no preclaim task or extra table. Complete own-claim inventory
recovers actual ownership without replay. Transfer retains its target identity
in source control intent before the remote write. Claim IDs are public
correlation and fencing identifiers, not secret machine credentials. There is no
historical claim registry or additional generation counter. Released/completed
records retain the last execution information.

The typed in-process API client owns HTTP operations and response parsing. The
foundation originally used known task IDs persisted locally or explicitly
imported for transfer. The [current-claim inventory
decision](2026-10-26-worker-claim-inventory.md) partially supersedes that
discovery choice: the project task list now selects the authenticated
user/worker active claims. Known-task reads still reconcile explicit writes,
while complete workerId-only project traversals supply the current ownership
set. Candidate pagination remains separate from inventory; no projection or
claim table is introduced.

The [worker responsibility decision](2026-10-22-worker-design.md) remains the
owner of scheduling, resource management and agent delivery boundaries. This
foundation provides service/client operations; it does not implement the
foreground runtime, local execution storage, Herdr resources or management CLI;
their linked decisions own those delivered components.

## Alternatives

**Use ordinary status as ownership.** A status records progress without machine,
agent or claim identity. It cannot fence an old execution after transfer or
express stopped-resource and continuity checks. A protected worker record keeps
ownership explicit while reusing task state and timing.

**Expose stored properties through the public writable codec.** Read responses
must contain worker, but accepting that same structure as a patch would allow
ordinary metadata writes to forge ownership. Separate concrete read and patch
types preserve the existing PR replacement contract.

**Add a claim generation or historical claim table.** These would enforce a
larger historical identity protocol and require another persisted counter or
unbounded identity retention. The worker protocol instead requires fresh UUIDs,
checks the latest claim and uses the existing exact task version for
concurrency. Reconsider historical receipts only if a concrete consumer must
prove the order of superseded operations rather than determine current
ownership.

**Discover owned tasks through server-side reverse indexes.** Losing SQLite also
loses frozen configuration and original resource associations. Rediscovering an
owner does not recover those resources. Known-task reads cover normal restart
and uncertain-result checks without an additional inventory contract.

**Invoke the CLI from the worker.** It would introduce argument/output parsing,
presentation ordering and command-level deadlines inside an already running CLI.
Typed in-process calls reuse authentication, int64, cancellation, pagination and
unconfirmed-write classification directly.

## Consequences

State, ownership, timing and version commit together. Release clears task
timing; transfer preserves the ongoing interval and records a new acquisition
time. Source authorization cannot be inferred from the target's credentials.
Explicit manual resume validates the released source claim and creates a new
execution; historical resource fields no longer require source resources to
remain available.

The service validates identities and confirmations, not remote process death or
Git/native-history contents. Fencing does not revoke external credentials.
Callers must preserve original resources while the same claim remains valid.
Latest-record GET can establish current ownership but is not a historical
operation receipt after later writers replace that record. Uncertain writes
remain visible and are not automatically replayed.

Runtime stopping, SQLite recovery, native sessions and management commands have
their own implementation and source-bound validation. Service/client tests do
not establish those runtime capabilities or complete cross-platform acceptance.
