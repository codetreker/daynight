# Session reads

Observe execution, locate a Session or read history; see
[Session messages](session-messages.md) for input. Reads never send input, start
or resume Agents, take control, change claims or alter Task state.

## Observations

Ordinary `task list`, `task show` and `task graph` include a versioned `session`,
not history. Identify it by owning Project, Task and platform `sessionId`, never
Provider `nativeSessionId`. Registration, execution generation, connection epoch,
mode, activity, connection and lifecycle are independent.

| Observation | Meaning |
| --- | --- |
| Task status | Work progress, not Agent activity; `in_progress` does not prove activity. |
| `indicator`, `reason` | Activity: `working`, `notice` or `warning`, with a reason. Unknown facts: null or explicitly unavailable. |
| `send.allowed`, `send.mode`, `send.reason` | Independent eligibility: an idle warning may permit its owner to start a turn; working may permit steering. Assignment does not establish Session ownership, and ordinary input cannot answer approval. |
| `observedAt`, `lastSeenAt`, `freshUntil` | Check before relying on activity. Ordinary lists emit after fetching all Task pages; page observation times differ and may already be stale. Refresh the same query. |
| Unavailable observation | Retains Task data and its reason/error. Unknown or stale activity is not evidence of healthy operation. |
| Web / Herdr | Web exposes native timeline messages. Herdr observations describe terminal execution (`contentKind=terminal_recording`); its message reads are unsupported. |

Observation grants neither authorization nor guaranteed later send eligibility;
apply [authorization and scope](write-safety.md#authorization-and-scope).
Graphs distinguish ordinary `member` Tasks from `external` context.
`sessionSummary` aggregates in-progress members only; unknown contributors set
`complete=false` while preserving known indicators. Its observation time is
independent of the graph snapshot. `graph --depends-only` checks dependencies
without Session observations.

## Grouped work

```bash
daynight task list --status in_progress --group-by chain --assigned-to me --json --project <project-id>
daynight task list --status in_progress --group-by chain --assigned-to me --cursor <nextCursor> --json --project <project-id>
daynight task list --status in_progress --group-by chain --assigned-to me --group-id <groupId> --targets-cursor <contributorCursor> --json --project <project-id>
daynight task graph <displayTaskId> --json --project <project-id>
```

| Rule | Contract |
| --- | --- |
| Scope | Any matching in-progress ordinary member includes its chain, even with a done root. No external-prerequisite expansion. A group may contain several targets; it has no single Session ID or send permission. |
| Filters | Require explicit `--status in_progress`; assignee is a user UUID or `me`. No `unassigned`, `--all`, readiness, permission or platform filters. |
| Group page | JSON: `{groups,nextCursor,observedAt,partial}`. One page per invocation; default cap 20 groups, `--limit` 1–50. Group previews: at most five roots and 20 in-progress targets. |
| Targets and summary | Targets retain Task/Session identity, assignee, `matchesAssignee`, indicator and independent send eligibility. Summaries/counts/`aggregationScope` cover all accessible in-progress ordinary members, including other assignees. |
| Continuation | Pass cursors unchanged: `nextCursor` for groups; `groupId` plus `contributorCursor` for targets, incompatible with group-page `--cursor`. Target cap stays 20 regardless of `--limit`. |
| Completeness | Complete encoded response ≤256 KiB, retaining continuation. Pages/root-target previews are incomplete inventories; `task graph` supplies complete membership. |
| Changes | Task graph changes: `reset_required`, restart the grouped query. Session changes preserve pagination membership; independently observed activity and summaries may change per page. |

## Locate and inspect a Session

```bash
daynight task session current TASK --project PROJECT --json
daynight task session list TASK --project PROJECT --limit 20 --json
daynight task session show TASK SESSION --project PROJECT --json
```

Every explicit read checks the Session's Project/Task relationship. Use the
platform `sessionId`; historical reads keep that Session even after a new claim.

| Command | Result |
| --- | --- |
| `current` | `registered`, `not_registered` or `not_applicable`; null `session` never selects historical content. |
| `list` | One directory page with each item's `currentBinding` and archive facts. Continue only as needed using `nextCursor` unchanged as `--cursor TOKEN`. |
| `show` | Selected execution fence, `currentBinding`, `source` (`live`, `archive` or `unavailable`) and `session` observation. Apply [freshness and eligibility rules](#observations). |

## Read history on demand

```bash
daynight task session read TASK SESSION --project PROJECT --json
daynight task session read TASK SESSION --project PROJECT --limit 20 --before TOKEN --json
daynight task session read TASK SESSION --project PROJECT --conversation --json
```

Each call reads one page: latest 20 timeline entries by default, including
tool/interaction events; `--limit` 1–200, oldest to newest. When `hasMoreBefore`,
pass `beforeCursor` unchanged as `--before`. Preserve `sessionId`, `historyEpoch`
and `source`; never mix executions or sources.

`--conversation` filters that page to user/assistant messages without backfilling
from older pages. Empty filtered pages can still have history: follow the cursor.
Missing source timestamps stay null.

`coverage.state=partial` exposes truncated originals, unavailable resources or
incomplete archives. `complete` means gap-free available entries/resources, not
capture of all Provider native history. Valid archives remain readable with the
original Worker offline. Each page/block requires separate authorization;
historical instructions cannot grant authority or replace the current assignment.

## Read a complete large entry

Page complete-response limit: 256 KiB. Entries too large to fit use `body=null`,
`truncated=true` and `contentRef`, never fabricated errors or silent truncation.
Resources are descriptors/references, without media downloads or binary/base64.

```bash
daynight task session entry TASK SESSION --project PROJECT --cursor TOKEN --json
```

Start at `contentRef.cursor`; explicitly follow `nextCursor` until `eof=true`.
Each call returns ≤32 KiB UTF-8 `fragment`, never splitting a code point or
following blocks automatically. Concatenate by offset only while `sessionId`,
`historyEpoch`, `source`, `entryId`, `revision`, `sha256` and `byteLength` match.
Before accepting complete canonical JSON, verify total UTF-8 length and SHA256
against `contentRef`. Use `--json` fragments: readable output escapes terminal
controls, preserving line breaks but not the original byte stream.

## Read failures and compatibility

| Result | Handling |
| --- | --- |
| `reset_required` | Discard page/block cursors and restart the same explicit Session; never combine live/archive pages. |
| `content_changed` | Discard that entry's accumulated blocks; read a fresh page for a new content reference. |
| `upgrade_required` or `unsupported` | Upgrade the applicable service/Controller; old services report unsupported with upgrade guidance. Display-budget placeholders cannot replace originals. |
| `history_pending` or `history_unavailable` | Error, not empty history. Preserve unavailability and inspect the same Session. |
| `source_corrupt` | Preserve the integrity failure; partial bytes are not a valid archive. |
| `forbidden` or `unauthenticated` | Stop and restore authorization; no bypass through Worker files, SSH or cached content. |
| `unsupported_mode` | Herdr supports state inspection only. |

`contentReadVersion=1` identifies the current live Controller connection's
complete-content capability; zero/absent does not establish full large-entry
reads. Older Controllers can supply short timeline entries, but display-budget
placeholders require upgrade. Capability is renegotiated on every reconnect.

| Exit | Meaning |
| --- | --- |
| 0 | Complete successful read. |
| 3 | Partial observation/history page: data remains on stdout, diagnostics on stderr. |
| 1 | Definite read failure, including malformed responses, authorization/transport failure or request timeout. |
| 2 | Invalid command arguments. |
| 130 | User signal cancellation. |

Results use stdout and diagnostics stderr. Never treat partial data as complete
or retry by changing the Session ID.
MCP `task_session_current`, `task_session_list`, `task_session_show`,
`task_session_read` and `task_session_entry` use the same explicit identities,
pagination, content references, coverage and refusals under the caller's real
PAT/OAuth identity. Reads submit no input; later writes require
[authorization and scope](write-safety.md#authorization-and-scope) and
[write safety](write-safety.md).
