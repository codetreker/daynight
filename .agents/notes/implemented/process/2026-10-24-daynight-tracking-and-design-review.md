# Agent Note: Require Daynight tracking and design review

Status: implemented

## Problem

Concrete work loses durable scope and dependency context when tracked only in a
conversation. Treating every agent-generated execution step as a separate task
obscures the actual work and its completion conditions. Solution, architecture,
and design discussions also need readable current material before a user can
review them. A repository or PR link alone
does not place that material with its owning task. Requiring separate creation
permission after an explicit instruction to use Daynight leaves required tracking
dependent on a redundant authorization request. Editing an installed
`using-daynight` copy also separates its instructions from their versioned source.

## Decision

When the skill and Daynight are available, the repository instructions and public
skill use Daynight to manage concrete work with a defined objective and completion
conditions: features, bug fixes, architecture/design assignments, and actual work
items produced by their breakdown. Agent-generated file reads, commands, and
routine checks stay in the owning task's execution plan. A distinct acceptance or
validation assignment may still be a task when it has its own outcome; routine
checks within another task remain execution steps.

Every solution, architecture, and design review uses its owning task. Before
requesting user review, the complete current material is saved in its description or attachments,
read back, and identified by task and resource reference. Revisions and review
decisions stay synchronized there. The later
[task-content and handoff decision](2026-10-25-task-content-handoff.md) permits
detailed content in the description or its explicitly referenced owning documents,
with one content owner and a task-local confirmation/evidence location. This replaces
the original requirement to keep detailed plans in a primary Markdown attachment.

An explicit user or applicable repository tracking/review instruction supplies
standing creation permission for necessary tasks within the user's confirmed
scope. Existing suitable tasks are reused. This partially supersedes the
[mode decision](../architecture/2026-10-21-using-daynight-modes.md)'s creation
permission and task eligibility rules while preserving their rationale and
separate execution, automatic-selection permission and delivery gates. The
[managed execution decision](../architecture/2026-10-26-managed-task-skill.md)
removes the ordinary skill's continuous scheduling mode while retaining these
authorization boundaries. Availability is
established through the actual CLI,
configured service and intended project; failed writes retain their actual cause
and do not establish readable review material.

Updates to `using-daynight` are made only in
`packages/daynight/src/commands/skill/skills/using-daynight/`. Existing User and
current-worktree Project copies are refreshed during `daynight update` under the
[automatic synchronization decision](../feature/2026-10-24-update-installed-agent-skills.md).
First installation and refresh in another project use `daynight skill install`
with the relevant Agents and scope, followed by its reload instructions.
The installer still owns the independent Agent copies and complete replacement,
as established by the
[distribution decision](../architecture/2026-10-21-public-agent-skill-design.md). The
[skill requirements](../../../../docs/spec/daynight-agent-skill.md) and
[design](../../../../docs/design/daynight-agent-skill.md) own the public workflow;
the [Goal protocol](../../../../docs/design/daynight-goal-workflow.md) retains
stage and shared-artifact ownership.

## Alternatives

**Require a separate creation request after mandated tracking or review.** This
preserves an explicit prompt per registration but stalls a workflow the user has
already required. Scoped standing permission preserves backlog control without
repeated confirmation.

**Leave review material in chat or behind repository and PR links.** This avoids
an upload but leaves the task without the actual current material the user must
review. Supplementary links remain useful after the content is saved and verified.

**Edit installed `using-daynight` copies alongside their source.** This immediately
changes one environment but bypasses source delivery and can mix instructions from
different package versions. Updating only the repository source keeps this skill
versioned. Refreshing Agent copies through the installer after a package upgrade
keeps their contents aligned with that package without manual installed-file edits.

## Consequences

Review handoff includes a confirmed task write even for small design discussions.
Task creation, attachment upload and metadata updates remain independent writes
with their existing version and reconciliation rules. Missing service access or
failed uploads remain visible blockers to that handoff. No service resource,
review command, lifecycle transition, or automatic execution permission is added.
Skill and document checks establish instruction integrity; they do not prove
that every model follows the workflow.
