# Session history and complete entries

Read [Overview](daynight://manuals/overview.md) first.

Use `task_session_read` for pages and `task_session_entry` for complete large
entries. Retain the exact Project, Task and Session IDs throughout. Use
[Session selection](daynight://manuals/session-reads.md) when those identities or
the readable source are unknown; a historical target remains that target after
a new claim. History reads neither produce write receipts nor grant sending
authority. Read [Session messages](daynight://manuals/session-messages.md) for
sending or original-operation recovery.

## Read pages without skipping history

`task_session_read` initially selects the recent page, at most 20 timeline
entries by default (`limit` range 1–200), including tool and interaction events.
Items run oldest to newest within the page. To read earlier history, pass returned
`beforeCursor` as `before` with the same three IDs; follow `hasMoreBefore`.
Concurrent appends preserve the earlier page boundary.

`conversation: true` filters only the selected page to user/assistant messages;
it neither fills from older content nor changes the boundary. An empty filtered
page can still have an earlier continuation.

Each item preserves `entryId`, `entrySeq`, `revision`, kind, role and available
time; null `timestamp` supplies no inferred time. Complete entries have `body`
and no `contentRef`. Entries that cannot fit have `body: null`, `truncated: true`
and a reference instead of partial JSON; the page cursor still advances.
Resource descriptors contain no binary/base64 bytes and can report
`resourcesTruncated`.

## Assemble a complete referenced entry

Call `task_session_entry` with the same Project/Task/Session IDs and
`contentRef.cursor`. Append returned `fragment` values in byte-offset order and
follow `nextCursor` until `eof`. Each UTF-8 fragment is at most 32 KiB and never
splits a code point; one fragment need not be parseable JSON.

Preserve `entryId`, revision, source, `historyEpoch`, SHA-256 and exact
decimal-string byte lengths/offsets. Require the assembled UTF-8 byte length and
SHA-256 to match before parsing the canonical JSON. Do not combine revisions,
sources, epochs or hashes.

## Response budgets and continuation failures

Each history page and entry chunk has a 256 KiB complete-response limit,
including MCP envelope, request identity and errors. Send each history read as
a separate request. A one-call legacy batch is supported; a multi-call batch
containing history reads fails before any tool executes. Oversized identity or
response returns bounded `resource_limit_exceeded`, never half a successful
object. This budget is specific to history pages/chunks.

Every page/chunk rechecks current credentials, visible Task, Project access and
the exact Session's association. Hidden Tasks/deleted Projects do not expose
retained history. Live/archive cursors have separate domains; continue on the
original source. `reset_required`, including live-to-archive change, requires
restarting from the latest page. `content_changed` requires a fresh entry
reference.

| Result | Meaning |
| --- | --- |
| `history_pending` | Archival is pending. |
| `history_unavailable` | History is unavailable. |
| `source_corrupt` | The content is corrupt. |
| `upgrade_required` | A display placeholder cannot provide original content; compatible old Controllers can expose short entries. |
| `unsupported_mode` | Herdr chat-history reads are unsupported. |

## Preserve known coverage gaps

Archive reads return bounded pages/chunks without downloading the entire archive;
an offline Worker does not prevent valid archive reads. `coverage.state: partial`
and `meta.partial` preserve known gaps, including missing resources and incomplete
archives. Filtering, another page or a reference introduced only to fit the
budget cannot erase known gaps. A budget-only reference is not itself a gap;
`complete` does not prove capture of the Provider's entire native history.
Failed reads remain failures, never empty history.
