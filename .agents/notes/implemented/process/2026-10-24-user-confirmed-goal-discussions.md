# Agent Note: User-confirmed Goal discussions

Status: implemented

## Problem

Requirements and implementation choices evolve while they are discussed. Early
registration of architecture placeholders or delivery tasks exposes work whose
inputs have not been accepted. A stage can also appear complete because its
documents or automated checks are ready while the user has not agreed to its
content. Conversely, accepted discussion material can remain blocked by source
delivery that is separate from the discussion's outcome.

## Decision

The public skill and repository instructions use two sequential user discussions
before delivery-task registration. The [Goal requirements](../../../../docs/spec/daynight-goal-workflow.md)
and [design](../../../../docs/design/daynight-goal-workflow.md) own the complete
workflow. This replaces the initial-pair registration, pre-confirmation delivery
breakdown, and discussion completion rules of the
[original staged Goal decision](2026-10-22-goal-workflow-design.md), while retaining
its self-contained briefs, stage-produced outputs and shared-artifact ownership.
The general authorization boundaries chosen in the
[mode decision](../../archived/architecture/2026-10-21-using-daynight-modes.md) remain; the [task-content and handoff decision](2026-10-25-task-content-handoff.md)
adds the handoff mode and replaces mandatory primary-attachment storage without
changing this decision's stage-confirmation gates. The
[managed execution decision](../architecture/2026-10-26-managed-task-skill.md)
removes continuous scheduling from the ordinary skill and keeps these
user-directed discussion transitions with ordinary single-task execution.

Starting a Goal requirements discussion creates or reuses only `[Goal]<outcome>`.
An explicit request to begin that discussion authorizes set-status in_progress,
using its observed version and confirming the result. A registration-only request
leaves the sole requirements task todo and
returns. No architecture placeholder or delivery tasks are created upfront.

The requirements task owns current requirements and the applicable interactive
prototype; the [task/session content decision](2026-10-28-task-session-content.md)
keeps review process and operational authorization in the session. Only the user's confirmation of the current requirements
and instruction to move to solution or architecture discussion permits the
transition. Save the accepted material, verify its confirmation in the session, complete the
requirements task, and confirm the service result before creating or starting the
next task. The solution-discussion task uses an ordinary dependency on the
completed requirements task. That explicit transition instruction authorizes
starting this next discussion task; completion alone does not.

The solution task owns system architecture and a draft outcome breakdown; the
session owns how the discussion is conducted.
No actual delivery tasks are registered before the user confirms the current
solution. After confirmation, register the complete outcome-based delivery
breakdown with real dependencies, task definitions and verified shared inputs.
Read back the complete registration before completing the solution-discussion
task. Delivery tasks are registered as todo without execution. Existing explicit
execution scope remains effective for ready successors; solution acceptance alone
does not enable automatic execution, select later delivery work or authorize
merges. Managed execution returns to its controller after its assigned task and
does not advance Goal discussion stages.
Material revisions after confirmation require renewed confirmation before
advancement.

Discussion completion follows user-confirmed Daynight materials and stage
acceptance. A repository's general PR-delivery rule does not add a merge gate to
these discussions. Explicit stage acceptance that requires a repository artifact
still applies; actual code or document delivery retains its own PR and merge
requirements. Requirements completion means requirements discussion is finished,
not that the whole Goal is delivered. Whole-Goal completion still requires every
delivery outcome and the original overall acceptance.

## Alternatives

**Register requirements and architecture tasks together.** The initial protocol
made the dependency visible before requirements were resolved. Sequential
registration keeps the next discussion absent until its prerequisite is accepted
and the user requests that discussion.

**Register delivery tasks while reviewing the solution.** This makes a draft
breakdown visible as persistent work but exposes unaccepted scope and dependencies
that must be revised. Drafts remain with the solution task until confirmation;
only its accepted breakdown becomes actual delivery tasks.

**Use the general PR-merge gate for every discussion.** This preserves one
completion rule but can prevent an explicitly requested architecture discussion
after requirements are accepted in Daynight. Separating discussion acceptance
from actual repository delivery preserves both user-controlled progression and
protected source delivery.

## Consequences

The two confirmation points are explicit waits. Agent judgment, an independent
review, CI success and a completed predecessor cannot substitute for the user's
decision. Discussion requests supply narrowly scoped lifecycle authorization;
ordinary task execution and delivery authorization remain separate.

Registration and completion are independent mutations. Partial success preserves
confirmed task IDs; uncertain completion is reconciled before the next stage is
created or claimed. Existing exact-version, attachment-content and dependency
rules apply. No new service type, status, command, ownership lock or automatic
execution permission is introduced. Instruction review covers these transitions;
bundle checks alone cannot establish model compliance.
