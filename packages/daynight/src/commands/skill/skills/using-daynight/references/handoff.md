# Handoff a task

Use `handoff <task-id>` only when the user explicitly requests handoff of that
task or a fixed set of tasks. This is a skill mode, not a CLI subcommand. The
request authorizes content review and, after it passes, enabling `allowAgents`
for those tasks. Creating, breaking down, or automatically discovering tasks does
not authorize permission changes. Read [the handbook](handbook.md) for CLI
operations and [the task content standard](task-content.md) for sufficiency.

Handoff ends after review, any authorized permission update, and reconciliation.
It does not start this session's task execution, change status,
dependencies or platform, or grant independent implementation, merge, mainline
push, deployment, or external-communication authority. Existing execution and
delivery authorization remains applicable to later scheduling.

## Review the task and its sources

Read the intended project and complete task, retaining its exact version,
status, `allowAgents`, platform, dependencies, and worker record. Read the
required source contents, including referenced source-task descriptions or
actual attachments, and necessary further references under the content standard.
Check current-stage sufficiency, responsibility boundaries, relevant
producer/consumer contracts, and Goal delivery tasks' direct architecture index.
Check the task definition, actual required inputs, and produced results; do not
require a session execution plan or record the handoff review process in task
material.

For a `todo` task with permission false, organize its description or authorized
source documents only from existing confirmed information. Missing decisions
block review. Obtain user confirmation for material scope or behavior changes,
then reread the changed description and affected actual sources. Unfinished
prerequisites need not prevent handoff when the design and agreed interfaces
already define the future work; preserve their real blockers and do not claim
pending outputs are readable.

Already-enabled tasks receive a read-only re-audit: they may be selected while
review is underway. Do not assume they are paused or edit their content under
that assumption. Follow the state rules below before any permission change.

## State and ownership rules

| Observed state | Handoff behavior |
|---|---|
| `todo`, permission false, review passes | Enable using the reviewed exact version, then reconcile. Dependency blockers may remain. |
| `todo`, permission false, review fails | Keep permission false and report concrete gaps. Confirmed-information organization follows the review rules above. |
| `todo`, permission true | Read-only re-audit; do not rewrite the same flag as an audit marker. |
| `in_progress`, permission false | Report the permission lock; do not newly enable or reset status to evade it. |
| `in_progress`, permission true | Read-only re-audit and report actual execution state. Review does not pause, stop, release, or withdraw execution. |
| `done` | Report completion and no handoff needed; do not reopen or update permission. This is mode policy, not an API prohibition on completed-task updates. |
| Active or released worker record | Preserve ownership and execution history. An active execution keeps its original resources. A released task starts a fresh claim/worktree/native session only through an authorized management decision; enabling permission neither resumes it nor restores deleted source resources. |

If an already-enabled task fails re-audit, report the failed review, actual flag,
and continued scheduling exposure. Keep its permission unchanged. Revocation or
stopping needs separately explicit scope and the established workflow, including
running-task locks and worker controls. A failed review is not a successful
handoff or an implicit suspension.

## Enable permission and reconcile

Finish authorized document changes and read them back before enabling permission.
Recheck required mutable references against the contents reviewed; compare actual
contents, not merely inventory or timestamps. Resolve changes before proceeding.
Attachment writes and cross-task references are not atomically protected by the
task version, and handoff does not provide server-side certification or freezing.

For a reviewed false-permission `todo`, use the installed CLI's versioned
`task update --allow-agents true` with the exact version on which the final
review decision was based. A final description may be included in that same
update. Omit unrelated options and preserve dependencies, platform, PR references,
worker data, and other fields. Do not update status to make the task eligible.

Check the write result and read back the complete task and required sources.
On a version conflict, reread and reassess rather than merely replacing the
version and replaying. If a write response is lost or uncertain, reconcile by
reads only before considering any new mutation; do not automatically replay it.
An unreadable reconciliation leaves the outcome unconfirmed: preserve the actual
error and do not report successful handoff.

Scheduling can claim the task immediately after enabling permission, so the final
GET may show a higher version and `in_progress` with a worker. Report the actual
observation; do not require equality with the update response's version or retry
because execution was observed. Another writer may have set the same flag during
an uncertain outcome. Without a confirmed write result, report only the observed
state rather than attributing the change to this operation.

If final source verification fails or reveals material changes, report review
incomplete or failed and the actual permission/state, including continued
scheduling exposure when true. Do not claim success or automatically revoke the
flag. Further action follows the same explicit authorization and state rules.

## Report and return

Read back the complete task before reporting, including read-only re-audits.
Reassess changed review-relevant metadata or sources; a newly observed worker
claim is reported under the state rules rather than treated as proof of failure.
Report each task's content-review result, changes or concrete gaps, observed
version, permission and status, remaining dependency blockers, and applicable
worker ownership and management constraints. Distinguish a confirmed permission
update from an uncertain write and a read-only re-audit. Permission true alone proves neither
execution started nor completion; report either only from actual evidence.

For a fixed set, review and report each task separately; one pass does not cover
other tasks. Return without selecting work or starting execution. The flag is
not a durable review certificate, and this mode does not bulk-rewrite existing
permission values.
