# Agent Note: Preserve submitted Controller launch identity

Status: implemented

## Problem

A Controller can remain alive before authenticating IPC, or exit before writing
its generation. A timeout or a preceding journal cannot identify which happened.
Treating either as a stopped current generation can create another writer or
replay input, and a spawn proof on Windows has no Job Object boundary yet.

## Decision

Task, Bot and independent Test launchers retain the submitted ticket and spawn
proof and share one observation of authenticated IPC, original process identity
and the current journal. Only authenticated IPC acknowledges the launch. After
the original process exits, a short read-only current-format snapshot distinguishes the
committed current generation from a missing writer or exact stopped predecessor;
conflicting identity and unknown process facts remain errors. The
[protocol design](../../../../docs/design/task-session-protocol.md) owns the
identity, cancellation and recovery contracts.

Bootstrap cancellation terminates the single original process with a bounded
identity-checked operation. A committed generation still requires the separate
full Controller and native process stop proof. Pre-writer exit retains the original
intent and resources as blocked. The independent
[startup report decision](2026-11-05-session-startup-observations.md) continues
to describe the public classification and its precedence.

If the independent launcher cannot capture spawn proof, it attempts a bounded
stop over the original ticket's authenticated IPC after matching the Controller
PID to the spawned child. On Windows it can terminate the original spawn handle;
POSIX does not signal an unverified PID.
Unconfirmed children are unreferenced so they cannot hold the foreground CLI
open, while the capture error, execution evidence and native lease remain.

An observation, stop IPC or bookkeeping failure during active cleanup does not
skip bounded stopping of the original bootstrap process. Matching current journal
evidence permits a subsequent full native stop and confirmation, but the original
failure remains visible and does not authorize archival or resource release. The
same cleanup deadline bounds process probes, Job operations and stop recording;
started native calls still finish and release their handles. A pure journal I/O
failure can use previously authenticated POSIX evidence only to attempt stopping
an attributable original group; it cannot establish complete native stop.

A Windows Job name can be reused after the original name or object disappears.
The Controller retains its Job handle for its lifetime. An observer acquires a
lease while an original member is verifiable and keeps that same handle through
termination and complete stop confirmation. A missing name or unavailable lease
remains unknown. A versioned marker in the current snapshot binds the committed stop
to the ticket and snapshot only after that confirmation; it permits later recovery
without reopening a vanished name. Older records without the marker remain blocked.
Older binaries do not enforce the marker, so their existing stop behavior does
not acquire this guarantee. The marker protects consistency, not against a
malicious local writer. This
strengthens the [native Job API decision](../testing/2026-11-05-native-controller-job-api.md)
while retaining its no-breakaway and kill-on-close choices.

A reparented POSIX zombie can establish the original Controller's exit when its
birth and process group match; its parent and displayed command can change during
exit. This does not establish descendant stop. Bot orderly shutdown persists its
authenticated current health before deciding whether restart consumes recovery
budget, while retaining any recorded terminal startup failure.

## Alternatives

**Use the journal as launch acknowledgement.** A preceding generation may be
present before the new Controller writes, and local data does not authenticate
the new IPC peer. It cannot authorize acknowledgement or a replacement launch.

**Use the complete process-tree stop helper for bootstrap.** Windows spawn proof
does not yet contain a Job Object. A single-process stop proves only the original
Controller exit and leaves complete native stop verification to the committed
journal's evidence.

## Consequences

Waiting and failed cleanup retain the original execution identity and resource
responsibility. A pre-writer exit cannot establish native stop or authorize a
new generation. This work originally targeted journal v8; mainline subsequently
introduced v9 for message origins. The shared observer uses the current format
without migrating it, and later storage ownership work can protect the same
read-only classification without changing its result.
