# Agent Note: Separate Task Bodies, Bot Recovery and Recent Display Windows

Status: implemented

## Problem

Completed task conversations need a predictable reading period, while long-lived
assistants need bounded display storage and recoverable native execution. A
single complete timeline cannot satisfy all three lifetimes: tool output can
exhaust task history, cache eviction can destroy recovery evidence, and a lost
Worker index can hide an otherwise intact assistant.

## Decision

The repository specifications define separately negotiated contracts for Task
body retention, grouped history directories, Bot recovery and recent windows.
This delivery establishes the specification, not the runtime capabilities or
Provider acceptance. Their field and failure owners are the
[Task history specification](../../../../docs/spec/task-session-history.md),
[assistant specification](../../../../docs/spec/assistant.md) and
[Bot view specification](../../../../docs/spec/bot-session-view.md).

The [explicit timeline save policy](2026-11-18-timeline-history-policy.md) provides
module-level selection and results. Its compatibility callers retain detailed
history until live reconstruction and versioned history consumers can activate
the body policy together.

Task body selection occurs by entry kind before history persistence. A readable
archive receives at least seven days from the later of scope termination and
its first successful commit, with an explicit legacy upgrade grace period.
Attachments retain independent ownership. Bot recovery belongs to its private
directory; display windows may evict details without discarding execution proof.
Independent same-machine takeover preserves native and platform identities,
requires current authorization and local exclusion, and never replays an
unknown command.

The [Task history decision](../feature/2026-11-10-task-session-history.md)
originally preserves complete available entries, including tool details, through
raw reads. That remains appropriate for legacy archives and live sources; the
new body policy explicitly describes a narrower retained source. The
[Worker runtime decision](2026-11-05-worker-bot-runtime.md) originally places
independent Bot execution evidence in Worker SQLite to reuse lifecycle ownership.
The recovery specification replaces that storage authority only for the new
capability. Existing writers require a guarded migration. The
[persistent preview decision](2026-11-09-bot-persistent-history-preview.md)
continues to own account isolation and display-only authority; window-aware
previews additionally obey the authoritative eviction boundary.

## Alternatives

**Persist complete tool traces for ordinary Tasks.** This preserves more audit
detail but lets independent tool output consume the body archive budget. Explicit
Task attachments preserve selected durable reports without making every command
part of the retained conversation.

**Keep Bot recovery in shared Worker and Controller locations.** This reuses the
current indexes but makes their loss fatal to independent discovery. Bot-owned
state costs migration and private storage coordination while allowing a new
Worker to discover the same assistant.

**Use a display timeline as a recovery backup.** It does not contain Provider
native state or sufficient proof that an external command stopped. Recovery
requires verified native records and execution evidence independent of eviction.

**Protect the entire active turn from eviction.** A single long message or tool
stream can exceed any fixed budget. Bounded Unicode-safe previews and explicit
summaries preserve a useful display while making omission visible.

## Consequences

Strict old response decoders retain their existing field shapes. New consumers
need explicit capability negotiation, identity-bound cursors, expiry and reset
errors; source completeness must be interpreted within the advertised policy.
Long unfinished chains can retain substantial old archives and require separate
storage measurement. Expired and physically deleted bytes cannot be recovered
by reopening a task.

The initial 500-entry/16-MiB Controller budget and 50-entry first page have no
performance measurements. Browser snapshots retain their smaller existing
limits. Database free pages, WAL and media are additional physical costs.
Native recovery, including compacted Codex threads, needs real Provider evidence;
this specification does not claim that result. Cross-machine failover and
first-visit offline history on a new browser are outside the adopted guarantee.
