# Agent Note: Bot History Windows and Resource Checkpoints

Status: implemented

## Problem

A long-lived Bot cannot retain every display entry indefinitely. Existing full
history readers and image closure checks interpret their input as complete
history. Feeding them an evictable subset would hide missing history, permit
late responses to restore evicted rows, and couple resource deletion to display
retention instead of actual references and active readers.

## Decision

Use an explicitly negotiated Bot window capability with separate preview and
checkpoint formats. A checkpoint stores the execution identity, history epoch,
source epoch and watermark, monotonic revision, retained boundaries, entry digests and resource references;
the Controller keeps display bytes. Reads validate the returned previews against
the committed checkpoint and recheck authorization and source identity after the
network wait. A source reset requires a checkpoint bound to the new source even
when its numeric watermark reaches the old value. Rebinding the same logical
window preserves its revision and retention constraints.

Window cursors bind the complete execution identity and retained range. A
changed revision triggers a bounded scan that includes revised existing entries;
an interrupted scan or evicted continuation requires a reset with the current
boundary. Old full-history readers receive an explicit upgrade refusal on a
window connection. Empty retained content preserves prior observation and
eviction facts.

Window references are updated transactionally and independently from operation,
approval, recovery and archive ownership. Physical reclamation waits for the
last reference and active resource lease. The
[server design](../../../../docs/design/bot-history-window.md) owns the protocol,
storage and lifecycle details. The
[timeline policy decision](2026-11-18-timeline-history-policy.md) retains its
separate responsibility for local save selection.

## Alternatives

**Reuse the complete history result.** Its truncated entries promise recoverable
content through a content reference. An irreversible display preview cannot
honor that promise, and a valid empty result would conceal eviction.

**Store the entire recent window on the server.** This would add a separate
offline-reading product promise, retention policy and body storage responsibility.
The confirmed scope needs a resource and continuity checkpoint while the
original Controller remains the source of display bytes.

**Use only newly allocated entry sequences for incremental reads.** Revisions
of existing IDs would disappear from the result. A bounded rescan avoids a
second durable change log while preserving those updates.

**Bind checkpoints only to the source counter.** A source reset can reuse that
counter without changing the connection fence or logical history epoch. Old
publications and saved metadata could then pass admission again. Persisting and
checking the source epoch distinguishes event generations without treating a
source reset as display-history eviction.

## Consequences

Consumers must explicitly adopt the new capability; protocol support does not
enable the Controller eviction algorithm or browser window rendering. A new
device cannot infer offline history availability from a checkpoint. Frequent
window changes can require a rescan or reset, trading extra bounded reads for
the absence of another persistent revision log.

Checkpoint commits and physical cleanup have distinct outcomes. Existing
references and readers can legitimately retain resource bytes after display
eviction, so the content budget is not a disk quota. Real database and file
tests remain necessary alongside pure protocol and rule tests.
