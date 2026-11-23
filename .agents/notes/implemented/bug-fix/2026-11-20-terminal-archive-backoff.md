# Agent Note: Back off terminal archive capacity refusals

Status: implemented

## Problem

Terminal Session uploads compete with other archive operations for service
capacity. A flat random retry delay does not reduce repeated pressure as the
same request continues to be refused. Early refusal on an older service can
precede its Task body response-version header, hiding a usable capacity error
behind an upgrade error. Preparation and sealing can also refuse capacity after
recoverable media settlement, so a refusal cannot establish that nothing was
committed.

## Decision

The stopped Controller uploader shares one archive-specific policy across Worker
initial uploads, historical backfill and independent Controller uploads. It
reads at most 65,536 bytes of a structured error under the request signal and
classifies only HTTP 429 with the exact code resource_busy. That refusal is
identified before the Task body response-version check; successful and other
responses retaining that check still require the advertised version. Invalid or
oversized error bodies do not authorize capacity replay.

An explicitly replayable request uses a one-second exponential baseline capped
at ten seconds and an independent uniform multiplier from 0.8 to 1.2 per retry.
A valid Retry-After is a minimum delay. A hint above twelve seconds or a selected
delay beyond the remaining round budget returns the last capacity error. The
uploader retains its sixty-second round, fifteen-second request, eight-retry
limit and parent cancellation. A new request starts at the first retry.

The internal archive-retry module owns classification, sampling and cancelable
waiting; callers own round budgets, approved replay and diagnostics. The
[Worker design](../../../../docs/design/daynight-worker.md#结束清理与退出) owns the
exact exported capabilities and request flow. Original identity, intent,
offset, hash, content and receipt reconciliation remain authoritative. Unknown
write outcomes continue through the existing status checks. Independent archive
maintenance and safe worktree cleanup retain their existing responsibilities
from the [archive priority decision](2026-11-11-worker-archive-priority.md) and
[Web cleanup decision](2026-11-16-web-archive-independent-cleanup.md).

## Alternatives

**Keep the flat 500–5000 millisecond random wait.** This distributes immediate
retries, but persistent refusal never increases the baseline. It cannot express
the required one-second-to-ten-second progression.

**Check the Task body version before every error.** An older service can reject
capacity before adding that header. This loses the exact actionable busy error
and prevents an otherwise supported request from completing after capacity
becomes available. Restricting the ordering exception to exact capacity
classification preserves version checks for accepted content.

## Consequences

Repeated refusal spaces requests progressively while bounded jitter spreads
competing clients. Capacity exhaustion remains observable through the original
HTTP status and code, and cancellation stops later requests without changing
cleanup ownership. These retries provide neither cross-client fairness nor a
guaranteed completion time. Oversized or unclassified errors retain the ordinary
failure path. A long Retry-After ends this upload round; an outer maintenance
owner may later retry under its own existing schedule.
