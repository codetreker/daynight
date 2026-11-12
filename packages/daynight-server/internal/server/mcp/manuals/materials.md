# Organizing task materials

Read this topic to organize independently understandable requirements, designs and results. Collection protocols are owned by [Steps](daynight://manuals/steps.md), [Threads](daynight://manuals/threads.md) and [Attachment reads](daynight://manuals/attachment-reads.md). Before replacing descriptions, uploading files or recording discussion, also read [Write safety](daynight://manuals/write-safety.md) and the operation-specific topic.

A Goal has its own description, Thread and attachments. A child Task has separate material; Parent ownership does not move or copy it. Use the actual resource ID when reading or writing either.

## Goal outcomes and progress

A Goal owns the current effective shared specification, architecture, task breakdown, key decisions, stage outcomes, delivery results and whole-Goal acceptance conclusions. Its child Tasks track the work contributing to that objective and retain their own definitions, responsibility, status, results and evidence. Consumers reference the Goal's shared material by its actual resource ID and location.

This ownership applies whether a conclusion is produced directly in a Session or through a child Task for discussion, research, design or breakdown. When a Goal-wide conclusion becomes effective, update the Goal's description or owning attachment and verify the saved content. A completed child or a conclusion left only in its material or Thread does not update the Goal. Preserve task-specific results and evidence with the producing Task and reference them from the Goal when needed; shared material has one effective owner.

Keep the Goal's overall progress current when a stage result, scope or decision changes, a delivery is verified, or a significant blocker affects the objective. Record achieved outcomes, remaining scope and material blockers or limitations; keep command chronology and temporary execution context in Session. The service's `progress` counts direct child Tasks; it does not synchronize conclusions or establish delivery or acceptance. Goal status remains independently controlled.

The target project's workflow determines required files, discussion Tasks, confirmation and delivery gates. Material ownership does not require a fixed Goal pipeline or a separate child Task for every discussion.

## Give information an effective owner

| Information | Owner |
| --- | --- |
| Problem, required outcome, scope, constraints, inputs, deliverables and acceptance | Description plus its actual readable referenced material |
| Substantial specification/design/report, image or prototype | Task attachment when a separate file is appropriate or required |
| Durable participant questions, proposals and replies | Immutable Task Thread |
| Ordered durable work objective, completion conditions, result and material references | Step, according to project rules |
| Command schedules, tools, debugging chronology, temporary todos, worktrees, runtime logs, claim and waiting context | Session or actual runtime platform |
| Execution/publishing/communication/deployment/merge authority | Actual user and project authorization context, not reconstructed from Task content |

Classify by purpose: a migration plan can be a formal deliverable, while the Session's schedule for producing it is operating context. A Step can reference overall requirements/results rather than copy them. Thread preserves the discussion; the accepted decision also belongs in the effective requirement/design/result owner.

Descriptions and references must establish concrete work, responsible scope, necessary inputs and their read locations, actual outputs/exchanges, and observable acceptance including relevant boundary/failure behavior. These are information requirements, not mandatory headings or an empty template. Short work can be complete inline; larger work can cite owning files/Tasks. Unexplained links, previous-chat references and cycles of empty documents leave inputs missing.

A required implementation approach belongs in durable Task material for another executor. A Session's command-by-command schedule does not. Do not invent architecture, acceptance thresholds or future prerequisite outputs to disguise incomplete inputs. Follow selected project workflow requirements for specifications or reviews; the product imposes no universal separate spec file or Goal pipeline.

This compact hypothetical documentation definition demonstrates sufficient inputs; its retention policy is not Daynight behavior:

```markdown
# Explain report retention

Outcome: Publish the policy, scope and one date example in this Task description.
Confirmed input: Reports are retained for 14 calendar days, evaluated at 00:00 UTC.
A report remains available through its fourteenth day. Saved personal downloads
are outside this policy.
Acceptance: State the UTC calendar-day rule; a report created on 1 January is
retained through 14 January and leaves retention at the 15 January UTC boundary.
This work documents supplied policy and changes no application behavior.
```

## Read and replace coherent material

Task definitions, Steps, Thread and attachments are independent reads. Full Task list omits descriptions, and Task show supplies no attachment inventory/bytes or complete Step/Thread collections. Use [Tasks](daynight://manuals/tasks.md) for projections, then read actually required files rather than only their names/timestamps.

```json
{"name":"task_show","arguments":{"projectId":"11111111-1111-4111-8111-111111111111","taskId":"22222222-2222-4222-8222-222222222222","view":"full"}}
```

After deciding from the complete content and exact version, supplied `description` replaces the entire field. Construct a coherent result preserving every effective requirement/reference; omit unrelated metadata. For example, after observing version `"12"`:

```json
{"name":"task_update","arguments":{"projectId":"11111111-1111-4111-8111-111111111111","taskId":"22222222-2222-4222-8222-222222222222","ifVersion":"12","description":"# Report retention\n\nReports are retained for 14 calendar days, evaluated at 00:00 UTC. A report created on 1 January is retained through 14 January and leaves retention at the 15 January UTC boundary.\n\nPersonal downloads are outside this policy. This documentation work changes no application behavior.\n","returnView":"full"}}
```

The example uses fictional IDs and supplied hypothetical policy. Actual work follows its confirmed inputs. Preserve Markdown newlines, code and valid links; descriptions retain their raw string, while Web renders CommonMark/GFM and displays raw HTML as text. Verify the structured result and full content as needed. Conflicts require a new read/decision; lost responses can follow committed edits and do not justify automatic replay.

When a discussion conclusion becomes effective, identify its requirement/design/result owner, read current content and sources, rewrite it coherently with its examples/references and essential rationale, submit through its version/file contract, and verify. Preserve immutable Thread history; a precise pointer can locate the effective material. Adding a calendar-day correction only to Thread while the requirement still says 24-hour periods leaves the definition contradictory. Recording the conclusion does not authorize executing it.

## Preserve readable sources and independent results

A shared source has one effective owner. A consumer identifies its Project/Task, description section or exact attachment path, and purpose. Repository sources need an actual immutable revision when a particular version matters. A private local path is not durable evidence for another reader. [Attachment reads](daynight://manuals/attachment-reads.md) owns case-sensitive paths and link bases; retain file/resource layouts and do not invent attachment paths or cross-Task relative URL schemes.

Read real sources before claiming sufficiency. A promised upload, terminal prerequisite, unchanged Task version, inventory or timestamp does not prove material presence/applicability/content. Attachments can change independently. Resolve substantive source conflicts within the actual allowed scope; copying every shared design into every consumer creates competing owners.

Citations and execution dependencies serve different purposes: a reference identifies information, while an edge controls scheduling and chain membership. Neither implies the other; [Dependencies](daynight://manuals/dependencies.md) owns relationships. A cancelled prerequisite may satisfy scheduling while delivering no input.

Write only real producer/consumer contracts: necessary fields/types, requiredness, format/revision, errors, units and null semantics. When no exchange exists, do not invent one. Formal results identify what exists, where to read it, actual observations and limitations. Status alone proves neither outputs nor acceptance. Results can be inline, attached or precisely referenced under the applicable project's requirements; execution chronology remains in Session.
