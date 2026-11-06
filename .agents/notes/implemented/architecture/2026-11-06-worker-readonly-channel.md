# Agent Note: Worker-owned read-only request channel

Status: implemented

## Problem

Assistant creation needs to inspect directories on a selected Worker before an
assistant Session exists. Browser-local and server-local directory APIs cannot
establish the selected machine's contents. Reusing a running assistant would
couple configuration discovery to unrelated execution and access rights.

## Decision

Use an authenticated ephemeral Worker WebSocket with owner-scoped HTTP queries.
The service binds every request and response to the owner, Worker, request,
connection, and capability generation. Configuration changes replace the
connection. The Worker alone enumerates directories using OS permission checks.
The [design](../../../../docs/design/worker-readonly.md) owns the wire protocol
and lifecycle; the [requirements](../../../../docs/spec/worker-readonly.md) own
observable behavior and limits.

Keep directory enumeration bounded in time, bytes, scanned entries and retained
operations. Signed cursors retain only page identity, while each page scans a
bounded current layer. Cancelled filesystem calls retain their capacity until
native completion and directory closure because Node cannot cancel those calls.
Keep the operation deadline separate from the HTTP response context so an expired
operation can still return its timeout error. Caller cancellation during credential
checks is not evidence that the shared Worker connection lost authorization; it
ends only that query and leaves unrelated pending queries intact. Caller credential
revocation also belongs to the affected query; Worker authorization and
protocol failures retain their channel-wide effect. Response encoding preserves the
admitted directory payload budget instead of expanding filesystem names through
HTML escaping.

## Alternatives

**Worker report polling.** Existing telemetry and configuration exchange could
carry queries, but would tie interactive browsing latency and directory contents
to reporting cadence and report storage responsibilities.

**Existing Session relay.** It already supplies authenticated connections, but
requires a concrete Session and execution grant. Creation-time browsing has no
such execution and must not access another assistant's session.

**Full directory snapshots.** Sorting all entries would simplify pagination but
make memory use depend on remote directory size. Bounded scanning and signed
cursors preserve resource limits at the cost of rescanning and rejecting a
changed or excessively large directory.

## Consequences

Queries require the Worker and HTTP caller to reach the same service instance;
there is no cross-instance broker or durable result recovery. Old Workers return
unsupported and no local fallback is available. Directory mutations invalidate
cursors. Hidden filtering means dot-prefixed names, including on Windows; it does
not inspect Windows hidden attributes. [Model discovery](2026-11-06-worker-model-discovery.md)
uses a typed operation without opening arbitrary command execution. A need for cross-instance routing
or directories above the scan limit requires revisiting these explicit limits.
