# Task and Goal materials

Start with [Overview](daynight://manuals/overview.md).

Use this topic to define independently understandable work, maintain effective conclusions and record results. Collection and mutation mechanics belong to the relevant operation topics.

## Effective ownership

A Goal independently owns its description, properties, Thread and attachments. Its ordinary children have separate material; Parent ownership neither copies nor moves it. Address the actual owning resource.

| Information | Owner |
| --- | --- |
| Current shared specification, architecture, breakdown, key decisions, stage outcomes, delivery results and whole-Goal acceptance | Goal description or owning attachments |
| Child definition, responsibility, status, outputs and evidence | Producing child Task; reference from the Goal when needed |
| Brief problem, outcome, scope, constraints, inputs, deliverables and acceptance, with detailed references | Task/Goal description plus actual readable referenced material |
| Full requirements, solutions, detailed designs, implementation instructions, research, acceptance evidence, images and prototypes | Owning Task/Goal attachments |
| Durable participant questions, proposals and replies | Immutable Thread |
| Commands, tools, debugging chronology, temporary todos, worktrees, runtime logs, claim and waiting context | Session or actual runtime platform |
| Execution and delivery authority | Actual user/project authorization context, not reconstructed Task content |

Shared material has one effective owner regardless of which Session or child produces it. When a Goal-wide conclusion becomes effective, update and verify its Goal owner. A completed child or conclusion left only in its material/Thread does not synchronize the Goal. Preserve task-specific evidence with its producer.

Update overall Goal progress when stage results, scope or decisions change, delivery is verified, or significant blockers arise. State achieved outcomes, remaining scope and material blockers/limitations. Service `progress` counts direct children; it neither synchronizes conclusions nor establishes delivery or acceptance. [Task writes](daynight://manuals/task-writes.md) owns Goal lifecycle effects.

## Define complete work concisely

Keep descriptions brief and link detailed attachments rather than duplicate their full content. A simple task completely explained in a few sentences needs no attachment. There is no fixed length or required heading template: description and readable sources together must establish concrete work, responsible scope, required inputs and their locations, actual outputs/exchanges, and observable acceptance including relevant boundary/failure behavior.

Unexplained links, previous-chat references and cycles of empty documents leave inputs missing. Required implementation approaches belong in durable material for another executor. Do not invent architecture, acceptance thresholds or future prerequisite outputs to fill gaps. The target project's workflow determines required documents and discussion/delivery gates; material ownership adds no universal pipeline.

Classify by purpose: a migration plan may be a formal deliverable; the Session's command schedule for producing it is operating context. Threads preserve discussion; accepted conclusions also belong in the effective requirement/design/result owner.

## Maintain coherent content

Read complete current owner content and required sources, using [Task projections](daynight://manuals/tasks.md) and separate material reads. For an effective change, rewrite a coherent whole preserving requirements, references, examples and essential rationale, then verify the saved content. Preserve immutable Thread history and point readers to the effective owner. A correction left only in Thread while the requirement remains contradictory is incomplete. Recording a conclusion grants no execution authority.

`description` replaces the whole field; [Task writes](daynight://manuals/task-writes.md) defines its versioned mutation. Preserve Markdown newlines, code and valid links. Descriptions retain their raw string; Web renders CommonMark/GFM and displays raw HTML as text.

## References, inputs and results

A consumer identifies a source's Project/Task, description section or exact attachment path, and purpose. Use an actual immutable repository revision when a particular version matters. Private local paths are not durable evidence for another reader. Preserve supporting resource layouts and [attachment link bases](daynight://manuals/attachment-reads.md); invent neither paths nor cross-Task relative URL schemes.

Read real sources before declaring them sufficient. A promised upload, terminal prerequisite, unchanged Task version, inventory or timestamp establishes neither presence nor applicability/content. Attachments change independently. Resolve substantive source conflicts within authorized scope; copied shared designs create competing owners.

References identify inputs; [dependencies](daynight://manuals/dependencies.md) govern scheduling and chain membership. Neither implies the other. A cancelled prerequisite can satisfy scheduling without delivering input.

Specify only real producer/consumer exchanges: necessary fields/types, requiredness, format/revision, errors, units and null semantics. Invent no exchange when none exists. Results identify what exists, its read location, actual observations and limitations. Status alone establishes neither outputs nor acceptance. Keep detailed results/evidence in owning attachments and summarize/link them from descriptions.
