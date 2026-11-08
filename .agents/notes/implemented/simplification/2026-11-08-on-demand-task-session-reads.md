# Agent Note: On-Demand Task Session Reads

Status: implemented

## Problem

Chain lists and Task Session observers repeatedly requested complete current
Session snapshots. Lists consumed a few identity and activity fields, while the
response also carried the provider's settings, model options and command catalogue.
Collapsed chains observed every eligible member, and hidden native detail tabs
retained an independent refresh loop. Each read repeated authorization, database
transactions, Session state loading and serialization for content that was not
being viewed.

Worker startup and recovery reports are separate from live Session snapshots.
Removing their observation together with unused list reads would leave an open
Session unable to update initialization failures or recovery gates accurately.

## Decision

Chain headers and children show ordinary Task status, progress and execution
metadata. The list consumes its existing project Task synchronization and does
not discover Sessions or offer Session activity annotations. Titles preserve
Task detail navigation. This replaces the observation feature recorded in the
[archived chain status decision](../../archived/feature/2026-11-04-task-session-status.md).

Task Session discovery starts when its detail tab is active. Visibility and
execution ownership remain separate: hidden native tabs retain eligible content,
drafts and healthy channels, but do not start current reads or discovery retries.
Necessary work deferred while hidden resumes only under current identity and
permission admission. Terminal viewers keep their own channel and lease policy.

`TaskDetailSurface` passes the startup report from its authorized Task observation
to the native client. The client binds reports to Session, claim, execution
generation and Controller instance, retains the highest same-execution revision
and rejects conflicting content at the same revision. While existing Task
observation and execution ownership admission remain valid, report revisions
update presentation and history admission without complete current reads or
channel replacement. The established WebSocket supplies snapshots, controls, events and
lifecycle changes.

Initial discovery, explicit refresh, actual reconnect and newly observed execution
identity can require a current read. A report that arrives before its corresponding
snapshot triggers controlled identity discovery rather than publication under an
old snapshot. Unchanged reports and unrelated Task versions do not trigger reads;
old reports and late responses cannot replace a newer execution. Visible archive
preparation remains recoverable through its existing read-only lifecycle.
Independent Test and Bot authority observation retains its own policy.

The [startup presentation decision](../bug-fix/2026-11-05-session-startup-presentation.md)
continues to own status precedence and history gates; this decision replaces its
periodic Task full-current reads. The [automatic entry decision](2026-11-06-automatic-task-session-entry.md)
continues to own claim and archive selection. The [requirements](../../../../docs/spec/task-sessions.md#执行身份与页面入口)
and [Session design](../../../../docs/design/task-session-protocol.md#session-view-的启动状态选择)
own the visible behavior and report flow.

## Alternatives

**Keep complete polling with a longer interval.** It reduces frequency but still
loads and serializes unused catalogues for every eligible member. Its resource
cost grows with all represented Sessions, even when no Session is viewed.

**Introduce a batch Session summary endpoint.** It could reduce payload and query
fan-out while retaining list activity annotations. The chosen behavior does not
need proactive list Session observations, so a new query and refresh contract
would preserve work with no required consumer.

**Remove startup and recovery observation.** WebSocket snapshots do not contain
Worker reports. Dropping the independent evidence would preserve stale failure
or blocked-recovery presentation and history gates. Authorized Task observations
already carry that report and preserve channel continuity.

## Consequences

Lists and hidden Task Session tabs no longer generate periodic complete current
reads. A visible healthy native Task Session receives content immediately through
its existing channel; startup and recovery report visibility follows the ordinary
Task observation cadence. List activity annotations and their shortcuts are
removed, while ordinary task state and detail navigation remain available.

Summary-backed details retain their existing full-detail freshness admission.
When a summary version advances before its matching body read finishes, that gate
can withdraw Session admission and require revalidation after the detail becomes
current. Direct details retain admission during successful ordinary background
refreshes. The [Task synchronization design](../../../../docs/design/daynight-task-sync.md#6-投影时钟与详情)
owns these rules; the report observer does not replace them.

Task observations remain the only source of Worker reports after discovery.
Their identity and revision checks are required before updating a viewed Session,
and a report alone grants neither content access nor execution authority. Viewer
visibility must not be treated as a replacement for ownership, authentication or
permission admission. Session payload, provider execution, recording and archive
formats remain with their existing owners.
