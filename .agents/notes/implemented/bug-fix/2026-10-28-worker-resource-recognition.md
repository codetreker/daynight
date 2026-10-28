# Agent Note: Recognize Worker Resources Before Validation

Status: implemented

## Problem

A person can attach to the worker's private Herdr session and create independent
workspaces. Repositories can also contain unrelated linked worktrees, historical
ownership metadata and directories with task-like names. A shared location or
reserved-looking prefix does not establish that the current worker owns a
resource. Treating every such entry as a broken managed resource can stop the
entire reconciliation round and prevent healthy tasks from acquiring capacity.
Stopping the private daemon on runner exit can also terminate independent human
workspaces that the worker never managed.

## Decision

Discovery positively recognizes resources before validating their integrity.
The [worker design](../../../../docs/design/daynight-worker.md#git-工作区与资源身份)
owns the mechanism and the [requirements](../../../../docs/spec/daynight-worker.md)
own observable behavior. Unrecognized resources are silently excluded from
ownership, capacity and cleanup; they are not adopted, rewritten or deleted.
Recognition adds no migration, compatibility conversion or persistence ledger.

Git discovery enumerates native administrative registrations. A candidate must
carry a current canonical owner and match the current Project, repository
fingerprints and expected physical backpointer before deeper inspection. Missing,
nonordinary or symlink candidate metadata, historical or malformed markers,
foreign registrations and unregistered directories do not establish ownership.
A static Git marker identifies a claim rather than a worker, so a recognized
Git-only resource still needs a matching local claim row, private Herdr resource
or current own claim before this worker manages it.

Run and manual control resolve all configured Projects and check every changed
saved repository binding before registering any replacement. Each check reads
the original Project's complete current own-claim inventory and private managed
Herdr resources. The union of local claim rows, current own claims and managed
Herdr identities supplies the Git ownership predicate. A current own claim,
managed workspace or proven Git worktree blocks rebinding even without a local
task row. Unknown Git metadata and independent manual workspaces supply no
worker ownership proof.

Herdr discovery recognizes the current title-prefixed four-ID owner and applies
the saved Project scope before decoding pane or native-agent metadata. An
unrecognized label or unmapped Project leaves the whole workspace untouched.
Recognized managed workspaces remain complete containers with one expected task
pane. Duplicate owners, extra panes and conflicting concrete bindings are visible
integrity failures; filtering panes cannot authorize closing their container.

Positive recognition does not relax known-target checks. Preparation, recovery
and deletion continue to validate the actual repository, directory, branch,
fingerprints, pointers and concrete Herdr binding. Genuine repository,
filesystem, RPC and protocol failures retain their original errors. Only the
absence of recognition is an ordinary skip.

After managed shutdown and pending stop confirmation, the runtime checks actual
workspace labels for any unmanaged workspace. If one remains, the private daemon
stays running as a normal result. Its independent process and file-backed logs
allow attachment after runner exit and reconnection by the next run. When no
unmanaged workspace remains, normal daemon shutdown still applies. Uncertain
managed stopping continues to retain the daemon with a visible error.

A repository-change check may start or reconnect the private daemon for resource
observation before mappings are saved. It does not launch a native agent or run
native-launch preflight. If startup or manual-control initialization fails, only
a daemon newly started by that initialization and freshly observed with no
managed or unmanaged workspace is stopped. A reconnected daemon, restored
managed or manual workspace, or failed observation is retained.

This partially supersedes the global discovery failure and unproven-resource
diagnostics in the [Git workspace decision](../architecture/2026-10-26-worker-git-workspaces.md)
and [claim record decision](../simplification/2026-10-27-worker-claim-records.md),
the resource-warning part of the [logging decision](2026-10-27-worker-log-transitions.md),
and unconditional post-stop daemon shutdown in the [direct shutdown decision](2026-10-28-worker-direct-shutdown.md).
The [Herdr adapter](../architecture/2026-10-26-worker-herdr-adapter.md) retains
strict native and container validation. The [migration removal decision](../simplification/2026-10-28-remove-worker-workspace-migration.md)
continues to exclude workspace conversion; historical formats are unrecognized
resources, not an instruction to convert or clean them.

## Alternatives

**Fail on any reserved-looking marker or label.** This made unexpected metadata
visible, but a human workspace or unrelated repository registration could block
all new scheduling despite having no current-worker ownership proof. Strict
validation belongs after recognition or at an explicitly selected target.

**Catch all discovery failures and return no resources.** Repository, permission,
RPC or protocol failures could then look like free capacity and authorize new
execution or absence cleanup. Recognition distinguishes an ordinary foreign
entry without suppressing failures while reading actual infrastructure.

**Ignore extra panes inside a managed workspace.** Cleanup closes the entire
workspace, so retaining an unrecognized pane in a filtered view would still kill
it. A recognized managed workspace retains its single-pane integrity requirement;
independent human work belongs in an independent workspace.

**Always stop the private daemon after managed agents stop.** A daemon-wide stop
also ends independent workspaces in the same private session. Keeping it alive
when unmanaged workspaces remain preserves their process lifetime without adding
a supervisor or transferring their ownership to the worker.

## Consequences

Unrelated resources cannot create worker rows, consume worker slots, produce
repeated diagnostics or block healthy acquisition. They remain byte-for-byte
unchanged by discovery and outside terminal cleanup. Independent manual
workspaces survive both managed task cleanup and worker exit, and may keep the
private daemon alive after the runner has stopped.

Unrecognized state is deliberately outside automatic recovery and cleanup. An
operator remains responsible for it. A known target with a conflicting path or
changed binding can still block that task, and a real global observation failure
can still block new capacity decisions. Retaining those errors preserves the
proof required before destructive actions or new execution.
