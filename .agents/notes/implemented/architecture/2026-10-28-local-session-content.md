# Agent Note: Controller-Owned Session Content

Status: implemented

## Problem

Persisting every projected message, tool result, event and resource in the task
service makes database growth and backup contents depend on native Agent output.
That responsibility is unnecessary when viewing a session may require its
original execution environment to be online. Removing the content tables alone
would lose reconnect history and command delivery guarantees because the relay
also used their contents for dispatch and approval validation.

## Decision

The Controller owns session content in its local execution environment. Its
SQLite projection retains stable entry order and revisions after transport ACKs;
local operation records retain full input and native evidence. The service
forwards authenticated history and resource requests to the online Controller.
PostgreSQL retains enumerated control identity and small operation summaries,
without message text, tool results, resource bytes, control catalogs or native
error details. Display state and recent events have bounded in-memory caches.

This replaces the service-owned history responsibility in the
[mode decision](2026-10-27-task-session-mode-contract.md). That initial design
used durable server cursors and content to make replay independent of Controller
availability. Requiring the original environment to be online removes that
requirement without relaxing execution ownership, authorization or unknown-input
handling. The [session design](../../../../docs/design/task-session-protocol.md)
owns the resulting protocol and bounds.

After reconciliation, every new connection synchronizes current state and
pending interactions before accepting controls. A history response carries its
source boundary; the Controller sends preceding events first and newer events
afterward. The service captures the browser cursor while processing that response,
so a concurrently changing timeline cannot skip newer output. Invalid cursors or
lost caches require fresh local hydration.

Transport outbox compaction does not remove the local timeline or operation
journal. It advances an explicit source floor and requires a new display
synchronization. A disconnected relay does not stop a healthy native loop merely
because unsent display events accumulate. Local storage failure remains an
execution failure because the Controller cannot preserve required evidence.

## Alternatives

**Keep full PostgreSQL history with retention.** Retention could bound some
storage, but still centralizes Agent content, adds backup exposure and requires
content lifecycle policy. It does not meet the selected ownership requirement.

**Move the server history to another storage engine.** Files or object storage
would remove PostgreSQL payload growth but retain the same unnecessary server
responsibility and offline-history promise.

**Use only an unrecorded byte relay.** Without local projection and input
records, reconnect cannot recover accurate UI state or distinguish uncertain
native dispatch from an unsent input. Local durability and a minimal authorized
control ledger remain necessary.

## Consequences

A new browser cannot load session content while its Controller is offline. An
already-open view can retain its loaded offline picture; controls stay disabled.
Archived session URLs expose identity and necessary receipts, not server-side
chat playback. Local data loss has no database content fallback. Native history
can assist recovery but cannot invent lost approval or operation evidence.

The service is no longer a durable command-body queue. A relay acceptance means
temporary receipt; browser drafts remain until native acceptance. Reconnect
reconciles the original operation rather than regenerating input from a hash or
retrying an uncertain operation. Operation summaries have an explicit admission
limit and are not expired in a way that would permit old inputs to execute again.

Live content belongs to the relay process owning the Controller connection.
Deployments must route reads to that process; a shared database does not provide
cross-instance content. Wrong-instance requests fail explicitly. Connection and
content limits are admission bounds, not measured throughput claims.

Existing database content and backups are not automatically deleted. New content
writes cease; deleting historical data remains an explicit operator action.
Execution-environment backup, containers and native-history retention remain
separate responsibilities. A Worker worktree is not a security sandbox.
