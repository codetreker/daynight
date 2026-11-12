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
the original process exits, a short read-only v8 snapshot distinguishes the
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
new generation. Production journal format remains v8; later storage ownership
work can protect the same read-only classification without changing its result.
