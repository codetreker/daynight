# Session observations and selection

Read [Overview](daynight://manuals/overview.md) first.

Use this topic to observe activity, read grouped ongoing work or select one exact
Session. Read [Session history](daynight://manuals/session-history.md) before
reading history pages or complete entries, and
[Session messages](daynight://manuals/session-messages.md) before sending or
recovering a message. Use [Concepts](daynight://manuals/concepts.md) when Account
or Project identity is unknown.

## Select an observation

| Purpose | Tool and result |
| --- | --- |
| Observe Tasks being read | `task_list`, `task_show` and normal `task_graph` attach `session`; graph also supplies `sessionSummary`. |
| Group ongoing work | `task_work_list` returns groups, aggregate observations and individual targets. |
| Find the current association | `task_session_current` returns registration status and an inspection when registered. |
| Find historical executions | `task_session_list` returns a newest-first directory. |
| Inspect a selected Session | `task_session_show` returns original identity, execution fence, current binding and readable source. |

`task_ready`, Task mutation results and dependency-only graphs omit Session
observations. Session tools do not create/resume execution, change claims/control
mode or send input. Read Task definitions and separate materials through their
[owners](daynight://manuals/materials.md).

## Interpret activity and freshness

Task `session` is an ephemeral `schemaVersion: 1` projection, not a Task property.

| Fields | Meaning |
| --- | --- |
| `observation`, `registration`, `reason`, `error` | Observed, unavailable or protocol-unsupported information; registered, waiting, not applicable or unknown association. Retain the reason. |
| `sessionId`, `nativeSessionId`, `claimId`, `executionGeneration`, `connectionEpoch` | Separate Daynight/native identities, original execution and connection generation. |
| `agentControlMode`, `contentKind`, `provider` | Actual execution kind; Herdr uses `terminal_recording`. |
| `activity`, `connectionState`, `lifecycle`, `currentTurnId` | Independent activity, connection, lifecycle and turn observations. |
| `indicator`, `needsAttention` | Attention hints; indicators are `working`, `notice`, `warning` or null. Unknown activity has no inferred normal indicator. |
| `send.allowed`, `send.mode`, `send.reason` | This caller's ordinary-message availability: `start`, `steer` or no known mode; `allowed: null` means unknown. |
| `observedAt`, `lastSeenAt`, `freshUntil` | Available UTC freshness evidence at its returned precision; null supplies no evidence. |

Observations can become stale immediately; Task version cannot freeze them.
`in_progress` or an active Worker does not prove activity. An owner's idle Session
can have `warning` and permit `start`; working permits `steer` only with actual
support and the current turn. Ordinary messages cannot answer pending approvals.
Attention hints confer no intervention authority; sending rechecks admission.
Do not invent heartbeat or expiry evidence.

Local observation failure preserves successful Task data with `unavailable`, a
reason and page `meta.partial`. `execution_changed` prevents joining old Task
data to a replacement execution. Invalid/revoked credentials, Project permission
failure and cancellation fail the entire read. `unsupported` differs from
unavailable/unknown and implies no CLI fallback, prompt or exit-code behavior.

## Read grouped ongoing work

`task_work_list` defaults `assignedTo` to `me`; an explicit user UUID is supported,
`unassigned` is not. A group is selected when an in-progress member matches the
assignee. Ordinary dependency components form chains; standalone Tasks have
`kind: task`. Direct external prerequisites neither expand nor contribute to
groups. Ended roots do not hide in-progress members.

Groups sort by matching members' latest `startedAt`, then `groupId`, the
component's smallest Task UUID. `displayTaskId` is the earliest-created root,
breaking ties by UUID. Counts distinguish all, matching and in-progress members
and roots. Root previews are capped at five; target previews at twenty. Retain
`titleTruncated`, `rootsTruncated` and continuation markers. Targets sort by Task
UUID and retain assignee, `matchesAssignee`, Session identity and send eligibility.

`aggregationScope: accessible_in_progress_members` includes accessible in-progress
members of every assignee. Summary priority is `warning > notice > working > null`;
counts, unknown count and `complete` remain independent. Unknowns do not erase
known hints or imply normal activity. A group has no shared Session/send
permission; inspect each intended target exactly before intervention.

| Continuation | Next request |
| --- | --- |
| Page `nextCursor` | Pass unchanged as `cursor`, preserving Project and assignee. |
| Group `contributorCursor` | Pass unchanged as `targetsCursor`, with original `groupId`, Project and assignee. |

Groups default to 20 per page, maximum 50. Do not combine group and target
continuation; `groupId` and `targetsCursor` must be paired. Target pages continue
that group's in-progress contributors; its summary still covers the full group.
Cursors bind caller, Project, assignee and Task graph snapshot. Graph changes
return `reset_required`: restart. Session activity changes preserve membership.

Each complete encoded result, including the MCP envelope, is at most 256 KiB.
Pages may end early, continuing after the last returned group/target. If no
complete result fits, `resource_limit_exceeded` fails explicitly. This budget
does not apply generally to ordinary Task reads.

## Preserve the selected Session

`task_session_current` takes Project/Task IDs. `registered` includes an inspection;
`not_registered` means the applicable execution has no registration;
`not_applicable` means no execution association. Neither selects historical
fallback. Goals have no applicable execution and an empty Session directory.

`task_session_list` uses the same scope, defaults `limit` to 20 (range 1–200),
and continues with unchanged `nextCursor` as `cursor` until null. Rows identify
original claim, execution generation, control mode, content kind, current binding
and archive status. `task_session_show` additionally takes the chosen `sessionId`.
Its inspection separates `currentBinding`, `fence`, observed state and `source`
(`live`, `archive`, `unavailable`); `contentReadVersion` reports live
original-content capability. Unavailable does not mean idle.

Every Session read checks current credentials, visible Task, Project access and
the selected Session's Task association. Historical executions remain readable
within that scope; a new claim does not replace the explicit Session selected
for inspection/history. Hidden Tasks and deleted Projects do not expose retained
content. Reads grant no Controller, upload or independent Bot/Test permissions.
