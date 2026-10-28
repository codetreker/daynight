# Agent Note: Task Titles and Stable Worker Workspace Identity

Status: implemented

## Problem

A person attaching to the private worker Herdr session needs to identify the
business task behind each terminal. An ownership-only workspace label exposes
UUIDs without a task title. Treating a mutable title as execution identity would
make an ordinary task rename affect reconnection, agent-name verification or
cleanup. The worker's retained state root already belongs to one configured
service, so carrying the service URL in every local resource owner duplicates
that operating constraint.

## Decision

The [worker design](../../../../docs/design/daynight-worker.md#workspace-名称与格式升级)
separates the task's display text from its stable resource coordinates. A label
starts with the safe, full task title and ends with:

```text
 | daynight:{"projectId":"…","taskId":"…","claimId":"…","worktreeId":"…"}
```

The suffix contains the four complete canonical UUIDs in a fixed canonical JSON
encoding. Parsing uses the last delimiter, so the title may contain the same
text. Ownership, actual binding verification, cleanup and the managed agent
name depend only on those coordinates. The `dn_` agent name uses the first 24
hexadecimal characters of SHA-256 over that canonical identity; task renames do
not alter it. Control characters, line separators and bidirectional display
controls are escaped visibly, while ordinary Unicode and emoji remain intact.

This partially supersedes the five-coordinate label in the [private Herdr
adapter](2026-10-26-worker-herdr-adapter.md) and marker in the [Git workspace
manager](2026-10-26-worker-git-workspaces.md). Their original use of service
origin distinguished resources while the earlier recovery model retained
cross-service execution scope. The current [claim/session
index](../simplification/2026-10-27-worker-claim-records.md) instead assigns one
retained state root to one service, account and worker identity. API requests
and managed assignments still receive the configured service address; changing
services requires finishing the old execution scope and rebuilding local state.

Herdr v0.9.5 uses `custom_name` for both the label and its displayed workspace
name. Its [create/rename schema](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/schema/workspaces.rs#L7-L33)
has no separate persistent owner field. [Rename](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/api/workspaces.rs#L104-L131)
returns current workspace information and schedules a save; it does not promise
durable persistence before responding. The worker therefore compares current
label and desired title after successful inventory reads and reconciles again
after restart.

The existing complete claim inventory supplies titles without another service
request or SQLite field. Naming uses the task's existing serialization, outside
the execution recovery budget. A rename RPC failure reports its task and cause
and leaves a healthy native execution running. Unknown results require a fresh
observation before another decision. Identity/binding conflicts and cancellation
retain their lifecycle meaning. Cleanup needs only stable coordinates, even
when the task title is unavailable.

The [workspace upgrade command](../../../../packages/daynight/README.md#worker-workspace-upgrade)
performs the explicit one-time conversion. It validates and backs up the old
resource set under the worker instance lock. It preserves logical project-path
spelling while accepting ancestor-directory aliases only when Git registration
pointers and saved and restored pane working directories resolve to the original
physical task path; the leaf remains an ordinary directory with matching physical
fingerprints. It blocks normal startup durably,
closes verified old Herdr workspaces in maintenance mode, stops that daemon and
reads its persisted layout before atomically updating Git administrative owner
markers. It preserves claim, worktree, branch, physical fingerprints and SQLite
native-session ID; normal execution accepts only the new format. Unfinished
claims with legacy resources require a known native-session ID, while fresh
resource-free pending claims do not block conversion. A current-format or
resource-free state requires no daemon startup. Verified rollback restores an
incomplete conversion's old set; it cannot undo a completed upgrade or later
execution state. Interrupted conversion cannot become normal startup with mixed
formats.

## Alternatives

**Include the task title in the owner or whole-label agent hash.** A title edit
would change the expected identity while the original agent still runs. Every
reconnect and stop path would need stale-title exceptions. A presentation prefix
with an independently encoded owner avoids those exceptions.

**Display only the title and persist ownership in workspace metadata.** Herdr's
metadata tokens do not provide the required independent persistent owner field.
An external mapping registry would add another state representation to recover
and reconcile. A future Herdr field could replace label serialization while the
four-coordinate identity remains stable.

**Edit saved Herdr names and hashes directly.** Herdr's [terminal-history
fingerprint](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/persist/snapshot.rs#L404-L424)
hashes the entire typed session snapshot, including names. Direct edits would
need to reproduce its serialization and update paired history/recovery files.
Closing the cold-restored workspace through Herdr reuses the worker's existing
recreation behavior and leaves Herdr responsible for those file associations.

## Consequences

Attached terminals identify their tasks immediately, while normal task renames
do not replace native conversations or affect resource cleanup. Full titles and
UUIDs remain in the label; a narrow terminal may crop the identity suffix, so
same-title tasks can require more width to distinguish. No title is sent as an
agent instruction and no title cache or additional acquisition query is added.

A workspace format upgrade requires stopping the worker and native processes.
The original native conversation resumes from its saved ID; the old Herdr
workspace/pane IDs and terminal scrollback are replaced. Missing original IDs,
unknown formats, conflicting coordinates and physical binding errors remain
visible and preserve resources. Migration backups and the startup block are
maintenance recovery artifacts, not a second execution ledger. Changing the
single-service state-root rule or introducing independent persistent Herdr owner
metadata requires reconsidering this decision.
