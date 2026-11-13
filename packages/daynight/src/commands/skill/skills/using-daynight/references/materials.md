# Materials

Descriptions and attachments hold Task material, Threads durable discussion,
Sessions execution content and activity, and Steps ordered Task records. Read each resource
independently; none substitutes for another. A Goal has its own description,
attachments and Thread, separate from those of its child Tasks. Use the Goal ID
with the same material commands for shared resources; membership does not move
child materials. Writes also require [write safety](write-safety.md).

## Goal outcomes and progress

A Goal owns the current effective shared specification, architecture, task
breakdown, key decisions, stage outcomes, delivery results and whole-Goal
acceptance conclusions. Its child Tasks track the work contributing to that
objective and retain their own definitions, responsibility, status, results and
evidence. Consumers reference the Goal's shared material by its actual resource
ID and location.

This ownership applies whether a conclusion is produced directly in a Session
or through a child Task for discussion, research, design or breakdown. When a
Goal-wide conclusion becomes effective, update the Goal's description or owning
attachment and verify the saved content. A completed child or a conclusion left
only in its material or Thread does not update the Goal. Preserve task-specific
results and evidence with the producing Task and reference them from the Goal
when needed; shared material has one effective owner.

Keep the Goal's overall progress current when a stage result, scope or decision
changes, a delivery is verified, or a significant blocker affects the objective.
Record achieved outcomes, remaining scope and material blockers or limitations;
keep command chronology and temporary execution context in Session. The service's
`progress` counts direct child Tasks; it does not synchronize conclusions or
establish delivery or acceptance. A child entering `in_progress` starts a `todo`
Goal; other Goal status changes remain explicit.

The target project's workflow determines required files, discussion Tasks,
confirmation and delivery gates. Material ownership does not require a fixed
Goal pipeline or a separate child Task for every discussion.

## Descriptions and references

Descriptions are Markdown: Web renders CommonMark/GFM and displays raw HTML as
text; CLI/API preserve the string without a format field. Task details omit
attachment listings/bytes and Thread messages; read them separately.

Description links/images resolve from the Task's attachment root; attachment
references resolve from their directory. Case-sensitive paths must stay inside
the Task root. Cross-task references identify the owning Task and resource;
relative links cannot cross roots. Description updates replace the full text:
preserve required content under [Task metadata](tasks.md#metadata).

## Attachments

```bash
daynight task attachment put <task-id> ./design.md --path docs/design.md
daynight task attachment list <task-id> --tree
daynight task attachment list <task-id> --json
daynight task attachment read <task-id> docs/design.md > ./downloaded-design.md
daynight task attachment remove <task-id> docs/design.md
```

| Operation | Rules |
| --- | --- |
| Put | One regular file; replaces its target path, defaulting to the source basename. |
| Paths | Case-sensitive, Unicode-preserving, `/`-separated and relative to the Task attachment root. Reject empty/dot/parent segments, backslashes and controls. |
| List | `--tree` and `--json` conflict. |
| Read | Exact original bytes, no labels or added newline. Failure can leave a partial redirected file; check exit status. |
| All commands | Accept `--project`, not `--if-version`. Writes leave Task version/status/update time unchanged. |

For unknown uploads/removals, list/read before another decision; apply
[independent-resource rules](write-safety.md#independent-resources-and-operations).

## Threads

```bash
daynight task thread read <task-id>
daynight task thread read <task-id> --after-id <last-read-message-id> --count=20
daynight task thread read <task-id> --before-id <first-shown-message-id> --count=20
daynight task thread read <task-id> --details --project <project-id>
daynight task thread post <task-id> --body 'What should the retry policy be?'
daynight task thread post <task-id> --body 'Use an explicit retry decision.' --reply-to <message-id>
daynight task thread post <task-id> --body 'The check passed.' --claim-id <active-claim-id>
```

Thread reads and posts remain available before execution, while its original
environment is offline, and after completion. Messages are immutable; replies stay within the Task. Posting
neither wakes an Agent nor changes Task status, version, timestamps, properties
or dependencies. Effective requirements, solutions and formal results remain in
descriptions/attachments. All Thread commands accept `--project`; explicit
selection avoids a hidden Task/Project read. Thread commands print readable text;
none accepts `--json`.

Read returns one page: latest by default, oldest to newest within the page.
`--count` is 1–100 (default 20); `--before-id` and `--after-id` conflict. Readable
text includes full Id, Author/account Id, millisecond UTC CreatedAt, optional
ReplyTo and complete Message. Agent authors show `Agent: True`; `--details`
adds verified claim, Worker and Provider attribution.

| Pagination | Rule |
| --- | --- |
| Older content | `... Has more messages before` appears above the page; continue with its first displayed Id. |
| Newer content | `Has more messages after...` appears below; continue from the last fully consumed Id. Empty forward reads retain that position. |
| Output budget | 256 KiB may reduce page size; messages remain complete, contiguous and untruncated. |
| Local posts | After reading A, unseen B followed by local post C must still be read from A; a receipt cannot skip B. |

Post requires nonblank `--body`, preserving whitespace; use `--body=-example`
for a leading dash. The service generates Id and authenticates authors. Ordinary
posts omit claim; verified Agent attribution requires explicit current
`--claim-id`. The CLI infers no claim and accepts no client message Id, version
or submission token.

Readable text escapes dangerous terminal controls. Multiline Message is indented,
retains LF/TAB and encodes literal backslashes before control escapes: DEL is
`\x7f`, CR `\r`, other unsafe controls `\uXXXX`. This preserves the full body
without executing it. Confirmed success prints `Message posted.`, full Id and optional
ReplyTo, not the body.

A validated 201 confirms a post. A validated refusal such as
`503 clock_not_advanced` is definite;
lost responses, dispatched transport failures, malformed success,
`503 message_outcome_unknown` and generic server failures leave outcome unknown.
The CLI reports uncertainty without automatically repeating POST. Read normal
Thread pages before deciding again: equal text cannot recover the original
receipt. Apply [uncertain results](write-safety.md#uncertain-results), including
preservation of confirmed posts after local output or cleanup failure.
