# Materials

Descriptions and attachments hold Task material; Threads hold durable discussion;
Sessions hold execution content and activity. A Step is a separate ordered work
record. These resources have independent reads and do not replace each other.
For writes, also read [write safety](write-safety.md).

## Descriptions and references

Task descriptions contain Markdown. Web renders CommonMark/GFM and displays raw
HTML as text; CLI and API preserve the original string and have no format field.
Task details contain neither attachment listing/bytes nor Thread messages.
Read required resources separately.

Relative links and images in a description resolve from that Task's attachment
root; references inside an attachment resolve from its directory. Paths preserve
case and stay within the Task root. Cross-task references must name the actual
owning Task and resource; an ordinary relative link cannot cross Task roots.
Use [Task metadata](tasks.md#metadata) to replace a description, preserving its
required complete content.

## Attachments

```bash
daynight task attachment put <task-id> ./design.md --path docs/design.md
daynight task attachment list <task-id> --tree
daynight task attachment list <task-id> --json
daynight task attachment read <task-id> docs/design.md > ./downloaded-design.md
daynight task attachment remove <task-id> docs/design.md
```

Put uploads one regular file, replacing the same target path; the default is
the source basename. Paths are case-sensitive, use `/`, preserve Unicode and
remain relative to the attachment root. Empty, dot or parent segments,
backslashes and control characters are invalid. `--tree` and `--json` conflict.

Read writes only original bytes, without labels or an added newline. A failed
read can leave a partial redirected file; check its exit code. All attachment
commands accept `--project`; none accepts `--if-version`. Writes do not change
Task version, status or update time. Reconcile an unknown upload/removal with
list/read before another decision, under
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

Threads remain readable and writable before execution, while its original
environment is offline, and after completion. Messages are immutable; replies
name a message in the same Task. Posting changes no Task status, version,
timestamps, properties or dependencies and does not wake an Agent. Descriptions
and attachments remain the owners of effective requirements, solutions and
formal results.

Read returns one page, defaulting to the latest messages. `--count` accepts
1–100, default 20. `--before-id` and `--after-id` conflict. A page displays oldest
to newest with full Id, Author and account Id, millisecond UTC CreatedAt,
optional ReplyTo and complete Message. Agent authors show `Agent: True`;
`--details` expands verified claim, Worker and Provider attribution. Thread
commands print readable text and do not accept `--json`.

`... Has more messages before` appears above a page with older content;
`Has more messages after...` appears below one with newer content. Read older
history with the first displayed Id; continue forward from the last fully
consumed Id. The 256 KiB output budget can reduce page size, but complete
messages remain contiguous and bodies are never truncated. An empty forward
read preserves its input position. A post receipt cannot advance reading past
unseen messages: after reading A, another person's B and local post C must still
be read from A.

Post requires nonblank `--body`, preserving its original whitespace; use
`--body=-example` for text starting with a dash. The service generates the message
Id and authenticates the author. Omit claim for an ordinary account post; provide
a current `--claim-id` explicitly for verified Agent attribution. The CLI infers
no claim and accepts no client message Id, version or submission token.

Readable text escapes dangerous terminal controls. Multiline Message lines are
indented, preserve LF/TAB and encode literal backslashes before visible control
escapes: DEL is `\x7f`, CR `\r` and other unsafe controls `\uXXXX`. These escapes
preserve the full body without executing it. Confirmed success prints
`Message posted.`, the complete Id and optional ReplyTo without repeating the
body. A validated 201 confirms a post. A validated refusal such as
`503 clock_not_advanced` is definite; lost/dispatched transport responses,
malformed success, `503 message_outcome_unknown` and generic server failures
leave the result unknown. The CLI reports that uncertainty and never repeats
POST automatically. Read normal Thread pages before a new decision; equal text
cannot recover the original receipt.

All Thread commands accept `--project`; an explicit Project avoids a hidden
Task/Project read. Local output or cleanup failure does not undo a confirmed
post. Apply [uncertain results](write-safety.md#uncertain-results).
