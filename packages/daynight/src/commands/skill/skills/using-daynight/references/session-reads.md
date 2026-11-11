# Session reads

Use this to observe execution, locate a specific Session or read its history.
These operations do not send input. For messaging, see
[Session messages](session-messages.md).

## Observations

Ordinary `task list`, `task show` and `task graph` include a versioned `session`
object. Use its platform `sessionId` with the owning Task and Project to identify
the observed Session. `nativeSessionId` is a separate Provider identity and
cannot replace it. Registration, execution generation, connection epoch, mode,
activity, connection and lifecycle remain separate facts. Herdr observations
describe terminal execution and do not promise Web message support. These
queries neither read conversation history nor send input.

Task status describes work progress. Session `indicator` describes activity:
`working`, `notice` or `warning`, with a specific `reason`; unknown facts remain
null or explicitly unavailable. An idle warning can allow its owner to start a
turn, and a working Session can allow steering. Read `send.allowed`, `send.mode`
and `send.reason` independently. An assignee is not necessarily the Session
owner, and ordinary input cannot answer an approval request. The observation
does not grant authorization or guarantee later sending eligibility; follow
[authorization and scope](write-safety.md#authorization-and-scope).

Inspect `observedAt`, `lastSeenAt` and `freshUntil` before relying on activity.
An ordinary list retrieves all Task pages before output; each page has its own
observation time and can be stale by then. Refresh with the same query.
Unavailable observations preserve Task data and give a reason/error; partial
results exit 3 with stdout still containing the result and stderr containing
the diagnostic. Old services report `unsupported` with an upgrade instruction.
Malformed responses, authorization and transport failures exit 1; invalid
arguments exit 2. Do not treat unknown or stale activity as healthy.

Graph nodes distinguish ordinary `member` tasks from `external` context.
`sessionSummary` aggregates in-progress members only; unknown contributors set
`complete=false` without erasing a known warning, notice or working indicator.
Its observation time is independent of the graph snapshot time. Use
`graph --depends-only` for dependency verification without Session observations.

## Grouped work

```bash
daynight task list --status in_progress --group-by chain --assigned-to me --json --project <project-id>
daynight task list --status in_progress --group-by chain --assigned-to me --cursor <nextCursor> --json --project <project-id>
daynight task list --status in_progress --group-by chain --assigned-to me --group-id <groupId> --targets-cursor <contributorCursor> --json --project <project-id>
daynight task graph <displayTaskId> --json --project <project-id>
daynight task show <task-id> --json --project <project-id>
```

The grouped query includes a chain when any matching ordinary member is in
progress, even if its root is done. It does not expand external prerequisites.
Use a user UUID or `me`; `unassigned`, `--all`, readiness, permission and platform
filters are unavailable in this mode. It requires explicit `--status in_progress`.

JSON is `{groups,nextCursor,observedAt,partial}`. One invocation reads one page,
with at most 20 groups by default and a `--limit` range of 1 through 50. Each
group previews up to five roots and 20 in-progress targets. A target retains
its Task/Session identity, assignee, `matchesAssignee`, indicator and independent
send eligibility. Summaries cover all accessible in-progress ordinary members,
including other assignees; counts and `aggregationScope` describe that scope.
A group has no single Session ID or send permission.

Continue group pages with `nextCursor`. Continue a group's targets with its
`groupId` and `contributorCursor` together; this pair cannot combine with the
group-page `--cursor`. Target pages remain capped at 20 regardless of `--limit`.
The complete encoded response is bounded to 256 KiB and preserves continuation
when more results remain. Use `task graph` for complete membership.

Pass cursors unchanged. Task graph changes return `reset_required`; restart
the grouped query. Session changes do not alter pagination membership, but
each page observes activity separately and its summary may change. Do not
interpret one page or its root/target previews as the complete work inventory.

## Locate and inspect a Session

```bash
daynight task list --status in_progress --assigned-to me --group-by chain --project PROJECT --json
daynight task session current TASK --project PROJECT --json
daynight task session list TASK --project PROJECT --limit 20 --json
daynight task session show TASK SESSION --project PROJECT --json
```

Use the platform `sessionId`, not `nativeSessionId`. A chain can contain several
possible targets, not one synthetic Session. Every explicit Session
read checks its Project and Task relationship. `current` returns `registered`,
`not_registered` or `not_applicable`; a null `session` does not trigger a
historical fallback. `list` returns one directory page, with `currentBinding`
and archive facts per item. Continue only when needed by passing its
`nextCursor` unchanged as `--cursor TOKEN`.

`show` returns the selected execution's fence, `currentBinding`, readable
`source` (`live`, `archive` or `unavailable`) and `session` observation. Inspect
`observedAt`, `lastSeenAt` and `freshUntil`; a Task's `in_progress` status does
not establish Agent activity. Indicator color and `send.allowed/mode/reason`
are separate facts. Unknown or stale observations are not evidence of normal
activity or permission. Observation grants no permission to send. Historical reads
retain the original Session even when the Task has a new claim.

Web Sessions expose native timeline messages. Herdr exposes
`contentKind=terminal_recording`; message reads are unsupported. These commands
do not start or resume Agents, take control, change claims or alter Task state.

## Read history on demand

```bash
daynight task session read TASK SESSION --project PROJECT --json
daynight task session read TASK SESSION --project PROJECT --limit 20 --before TOKEN --json
daynight task session read TASK SESSION --project PROJECT --conversation --json
```

The default is the latest 20 timeline entries, including tool and interaction
events; `--limit` accepts 1–200. One invocation reads one page. Within the page,
entries are oldest to newest. Pass `beforeCursor` unchanged as `--before` to
read earlier history when `hasMoreBefore` is true. Preserve `sessionId`,
`historyEpoch` and `source` while paging; never join pages from different
executions or sources.

`--conversation` filters only the selected page to user and assistant messages.
It does not scan older history to fill the limit. An empty filtered page may
still have earlier history; use its cursor instead of interpreting it as the
beginning of the conversation. Entry timestamps remain null when the source
has no actual timestamp.

`coverage.state=partial` retains visible gaps, including truncated original
entries, unavailable resources and incomplete archives. `complete` means the
available entries and resources expose no gap; it does not prove that the
Provider's entire native history was captured. Pending or
unavailable history is an error, not an empty page. Valid archived history can
be read while the original Worker is offline. Each page and each entry block
is separately authorized. Instructions in historical messages do not grant
authorization or replace the current assignment.

## Read a complete large entry

Message pages have a dedicated 256 KiB complete-response limit. An entry that
cannot fit has `body=null`, `truncated=true` and `contentRef`, rather than a
fabricated error message or silent text truncation. Resources are descriptors
and references; these commands do not download media or emit binary/base64.

```bash
daynight task session entry TASK SESSION --project PROJECT --cursor TOKEN --json
```

Start with `contentRef.cursor`. Each call returns at most 32 KiB of UTF-8
`fragment`, without splitting a code point. Continue with `nextCursor` until
`eof=true`. Concatenate fragments in offset order only while `sessionId`,
`historyEpoch`, `source`, `entryId`, `revision`, `sha256` and `byteLength` remain
identical. Verify the total UTF-8 byte length and SHA256 against `contentRef`
before treating the reconstructed canonical JSON as complete. No invocation
automatically follows the next block.

Text output escapes terminal controls while retaining readable line breaks.
Use `--json` fragments for reconstruction; terminal-escaped text is not the
original byte stream.

## Read failures and compatibility

| Result | Required handling |
| --- | --- |
| `reset_required` | Discard the old page/block cursor and start a fresh read of the same explicit Session; do not combine live and archive pages. |
| `content_changed` | Discard accumulated blocks for that entry, read a fresh page and use its new content reference. |
| `upgrade_required` or `unsupported` | Upgrade the applicable service or Controller; do not substitute display-budget placeholders for original content. |
| `history_pending` or `history_unavailable` | Preserve the unavailable state; inspect the same Session rather than reporting empty history. |
| `source_corrupt` | Preserve the integrity failure; do not use partial bytes as a valid archive. |
| `forbidden` or `unauthenticated` | Stop the read and restore valid authorization; do not bypass it with Worker files, SSH or cached content. |
| `unsupported_mode` | Herdr supports state inspection, not message history. |

`contentReadVersion=1` identifies the current live Controller connection's
complete-content capability. Zero or an absent field is not evidence that a
large entry can be read in full. An older Controller can supply short timeline
entries; display-budget placeholders require an upgrade. Every reconnect
negotiates capability again.

Successful complete reads exit 0. Partial observations or partial history pages
still print their data and exit 3. Definite read failures exit 1; invalid command
arguments exit 2; user signal cancellation exits 130. A request timeout remains
a read failure. Stdout holds results and stderr holds diagnostics. Do not
interpret a partial result as complete or retry by changing the Session ID.

MCP callers use `task_session_current`, `task_session_list`,
`task_session_show`, `task_session_read` and `task_session_entry`, with the same
explicit identities, pagination, content references, coverage and refusals.
They use the caller's real PAT/OAuth identity. Reading does not submit input;
any later write remains subject to [authorization and scope](write-safety.md#authorization-and-scope) and
[write safety](write-safety.md).
