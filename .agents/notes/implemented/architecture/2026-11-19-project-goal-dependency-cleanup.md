# Agent Note: Atomic Goal Dependency Cleanup on Project Changes

Status: implemented

## Problem

Moving a Project to another Team can leave Goal acceptance dependencies across Team boundaries. Deleting a Project can leave other Goals waiting on inaccessible prerequisites. Cleanup must cover both directions and remain atomic with ownership, App disconnection and Session retirement, while preserving ordinary Task history. Clients must explicitly acknowledge permanent relationship loss.

## Decision

Both Projects and AppProjects coordinate Goal dependency cleanup in their existing lifecycle transactions. They lock the Project, then the current owner Team graph, before existing ownership, Team, Task and App row locks. Actual transfers and deletions require explicit cleanup confirmation when Goal edges exist. Same-owner transfers preserve every edge and revision. The original Delete entry point supplies no confirmation. REST transfer and deletion accept exactly one Daynight-Confirm-Goal-Dependency-Removal header with the literal value true and forward that signal through the explicit service inputs. Omission remains unconfirmed; invalid or repeated values are rejected before business work. CORS permits the header, while request bodies, previews, success receipts and outcome classification retain their existing formats.

The DAO enumerates the Project's Goals and joins outgoing edges through the existing primary key and incoming edges through the Goal partial reverse index. It unions edge primary keys, deletes only Goal rows, and advances each distinct actual downstream revision once. Remote Project and Task rows are not locked or updated. Revision exhaustion rolls back the complete operation. The fifteen-second service budget includes pool acquisition, lock waits and commit, and inherits earlier caller cancellation.

The [server design](../../../../docs/design/daynight-server.md#项目生命周期中的-goal-边清理) owns the transaction mechanism and its consistency with App, Webhook and Session effects. The [Goal lifecycle decision](2026-11-19-goal-dependency-lifecycle.md) owns the shared Team lock and completion invariant.

## Alternatives

**Clean only outgoing edges.** External downstream Goals would retain references to deleted or transferred prerequisites, leaving invalid relationships and stale revisions.

**Perform cleanup after the Project mutation commits.** A failure would expose the Project's new ownership or deletion while old dependencies remain. A concurrent relationship write could also escape cleanup.

**Lock remote Projects and Tasks.** Graph serialization already protects these edges. Remote row locks would add cross-Project lock ordering and conflict with lifecycle transactions holding their own Project locks.

## Consequences

Successful Project changes permanently remove all incident Goal edges. Every affected downstream can detect stale relationship observations even if its final set becomes empty. Unconfirmed legacy operations remain usable for empty graphs and same-owner transfers. Ordinary Task dependencies and unrelated Goal relationships retain their historical behavior. All graph mutations must continue to honor the same Team lock order. Unknown transaction outcomes remain unknown and must not trigger automatic replay.
