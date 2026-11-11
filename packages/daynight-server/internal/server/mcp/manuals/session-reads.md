# Session observations and history

Read this to observe Task activity, find grouped ongoing work, locate one exact
Session or read its history. These tools do not create or resume execution,
change a claim or control mode, or send input. For sending or recovering a
message, read [Session messages](daynight://manuals/session-messages.md).
Establish unknown Account and Project context through
[Concepts](daynight://manuals/concepts.md).

## Choose the read

| Purpose | Tool and result |
| --- | --- |
| Observe Tasks already being read | `task_list`, `task_show` and non-dependency-only `task_graph` attach `session`; graph also supplies `sessionSummary`. |
| Find ongoing work by assignee and ordinary dependency group | `task_work_list` supplies groups, aggregate observations and individual targets. |
| Find the current association | `task_session_current` returns registration status and the exact inspection when registered. |
| Find historical executions | `task_session_list` returns a newest-first Session directory. |
| Inspect an explicit Session | `task_session_show` returns its original identity, fence, current binding and readable source. |
| Read messages or a complete large entry | `task_session_read` selects a history page; `task_session_entry` follows an entry's `contentRef`. |

`task_ready`, Task write results and dependency-only graph reads do not attach
Session observations. A Session read does not read Task descriptions, Steps,
Thread or attachments; select those [material owners](daynight://manuals/materials.md)
when the decision needs them.

## Interpret an observation

Task `session` is an ephemeral `schemaVersion: 1` projection, never a Task property.
Its identity and state fields describe independent facts:

| Fields | Interpretation |
| --- | --- |
| `observation`, `registration`, `reason`, `error` | Observed, unavailable or protocol-unsupported data; registered, waiting for registration, not applicable or unknown association. Preserve the reason. |
| `sessionId`, `nativeSessionId`, `claimId`, `executionGeneration`, `connectionEpoch` | Daynight and native identities, original execution and connection generation. These IDs and generations have different roles. |
| `agentControlMode`, `contentKind`, `provider` | Actual execution kind. Herdr uses `terminal_recording`, not a fabricated Web conversation. |
| `indicator`, `needsAttention` | Attention hints, not intervention authority. |
| `activity`, `connectionState`, `lifecycle`, `currentTurnId` | Separate activity, connection, lifecycle and current-turn observations. |
| `send.allowed`, `send.mode`, `send.reason` | This caller's ordinary-message availability: `start`, `steer` or no known mode. `allowed: null` means unknown, not false. |
| `observedAt`, `lastSeenAt`, `freshUntil` | Available UTC freshness evidence, preserving its precision. Null means no known evidence; do not invent an expiry or heartbeat. |

An observation may become stale immediately after return; Task version cannot
freeze Session state. `in_progress` or an active Worker alone does not prove the
Agent is working. Indicators are `working`, `notice`, `warning` or null; unknown
activity does not acquire a normal indicator. A real owner's idle Session may
have `warning` and allow `start`. Working permits `steer` only with real steer
support and the current turn. Waiting for an approval does not permit answering
it with an ordinary message. Recheck actual admission when sending.

Local Session observation failure preserves successful Task data and reports
`unavailable` with a reason and page `meta.partial`. `execution_changed` prevents
joining an old Task with a replacement execution. Invalid or revoked credentials,
Project permission failure and cancellation fail the whole read. Failed reads
are not empty results. `unsupported` is distinct from unavailable or unknown;
the schema value does not imply CLI fallback, prompts or exit codes.

## Read grouped ongoing work

```json
{
  "name": "task_work_list",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "assignedTo": "me",
    "limit": 20
  }
}
```

The assignee defaults to `me` or accepts an explicit user UUID, not `unassigned`.
A group is selected when an in-progress member matches that assignee. Ordinary
dependency connected components form chains; standalone Tasks form `kind: task`.
Direct external prerequisites do not expand groups or participate in aggregation.
Ended roots do not hide in-progress members. Groups sort by matching members'
latest `startedAt`, then `groupId`; that ID is the component's smallest Task UUID.
`displayTaskId` identifies the earliest-created root, with UUID breaking ties.

Counts distinguish all members, matching members, in-progress members and roots.
Root previews are at most five and target previews at most twenty; preserve
`titleTruncated`, `rootsTruncated` and continuation markers. Targets sort by Task
UUID and retain their assignee and `matchesAssignee` alongside their own Session
identity and send eligibility.

`aggregationScope: accessible_in_progress_members` includes all accessible
in-progress members, including other assignees. The summary prioritizes
`warning > notice > working > null` and retains each count, unknown count and
`complete`. Unknown observations do not erase known hints or mean normal activity.
A group has no shared Session ID or shared send permission. Its targets require
their own exact inspection before intervention.

| Continuation | Next call to `task_work_list` |
| --- | --- |
| Page `nextCursor` | Pass its unchanged value as `cursor` with the original Project and assignee. |
| Group `contributorCursor` | Pass its unchanged value as `targetsCursor` together with that original `groupId`, Project and assignee. |

Groups default to 20 per page, maximum 50. Group and target continuation cannot
be combined; `groupId` and `targetsCursor` must be paired. Target pages continue
the same group's in-progress contributors while the summary still covers the
entire group. Cursors bind caller, Project, assignee and Task graph snapshot.
Graph changes return `reset_required`: restart the group read. Session activity
changes alone preserve pagination membership.

Each complete encoded work result, including the MCP envelope, is limited to
256 KiB. A page may finish early and supplies continuation after the last output
group or target. If no complete result fits, `resource_limit_exceeded` is an
explicit failure. This is not a general byte limit for ordinary Task reads.

## Preserve the selected Session

`task_session_current` requires Project and Task IDs. `registered` includes an
inspection; `not_registered` means the applicable execution has no registration,
and `not_applicable` means no execution association. Neither status selects the
latest historical Session. Goals have no applicable execution and their Session
directory is empty.

`task_session_list` takes the same scope, optional `limit` and `cursor`. Its default
is 20, range 1–200; pass `nextCursor` unchanged until null. Rows identify original
claim, execution generation, control mode, content kind, current binding and
archive status. For `task_session_show`, add the selected `sessionId`. Inspection
separates `currentBinding`, `fence`, observed state and `source` (`live`, `archive`
or `unavailable`); `contentReadVersion` reports live original-content capability.
Unavailable does not mean idle. A new Task claim never changes the explicit
Session being inspected or read.

Session tools check current credentials, visible Task and Project access, and
the selected Session's association with that Task. Historical executions remain
addressable within that scope; a hidden Task or deleted Project does not expose retained Session
content through these tools. Reading does not expand Controller, upload or
independent Bot/Test permissions.

## Read history and complete entries

```json
{
  "name": "task_session_read",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "sessionId": "33333333-3333-4333-8333-333333333333",
    "limit": 20
  }
}
```

The default recent page selects at most 20 timeline entries, range 1–200, including
tool and interaction events. Items run oldest to newest within a page. Pass
`beforeCursor` as `before` with the same three IDs to read earlier history, using
`hasMoreBefore` to continue. Concurrent appends preserve an earlier page boundary.
`conversation: true` filters only that selected page to user and assistant
messages; it neither fills the page from older content nor changes its boundary.
An empty filtered page can still have an earlier continuation.

Each item retains `entryId`, `entrySeq`, `revision`, kind, role and available time;
`timestamp: null` is not an inferred timestamp. A full entry has `body` and no
`contentRef`. An entry that cannot fit has `body: null`, `truncated: true` and a
reference instead of partial JSON; its page cursor still advances. Resource
descriptors contain no binary/base64 bytes and may report `resourcesTruncated`.

For complete canonical JSON, call `task_session_entry` with the same three IDs
and `contentRef.cursor`. Append `fragment` in returned byte-offset order and
continue with `nextCursor` until `eof`. Each UTF-8 fragment is at most 32 KiB and
does not split a code point; a fragment need not be parseable JSON. Preserve
`entryId`, revision, source, `historyEpoch`, SHA-256 and decimal-string byte lengths
and offsets. Check the assembled UTF-8 byte length and SHA-256 before parsing.

History pages and entry chunks each have a 256 KiB complete-response limit,
including the MCP envelope, request identity and errors. Send each history read
as a separate request. A one-call legacy batch is supported; a multi-call batch
containing history reads is rejected before any tool executes. An oversized
identity or response produces bounded `resource_limit_exceeded`, never half a
successful object. This limit belongs to history pages/chunks, not all reads.

Every page and chunk rechecks access and the exact Session. Live and archive
cursors are separate domains; continuation stays on its original source.
`reset_required` restarts from the latest page, including after live-to-archive
change. `content_changed` requires a fresh entry reference. Do not combine
revisions, sources, epochs or hashes. `history_pending`, `history_unavailable` and
`source_corrupt` distinguish pending archival, unavailable history and corrupt
content. Compatible old Controllers can expose short entries; `upgrade_required`
means a display placeholder cannot supply original content. Herdr chat-history
reads report `unsupported_mode`.

Archive reads supply bounded pages/chunks without downloading the whole archive
to the client; an offline Worker does not prevent valid archive reads.
`coverage.state: partial` and `meta.partial` retain known gaps, including missing
resources and incomplete archives. Conversation filtering, another page or a
budget-only content reference does not erase known gaps. A reference used only
to fit the response is not itself a gap; `complete` does not prove the Provider's
entire native history was captured. Preserve errors instead of treating failed
reads as empty history. These tools produce no write receipt or sending authority.
