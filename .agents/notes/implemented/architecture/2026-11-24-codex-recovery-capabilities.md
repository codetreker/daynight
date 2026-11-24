# Agent Note: Codex Recovery Capability Checks

Status: implemented

## Problem

A Codex update prevented a new Bot from starting because its recovery adapter
accepted only 0.169.0. Validation coverage had become an exact runtime admission
rule, even when the runtime still supported the required history behavior.
Version equality also prevented restoring otherwise compatible saved threads.

## Decision

Runtime versions are diagnostic metadata, not admission rules. This replaces the
version restriction in the [original recovery decision](2026-11-19-codex-bot-recovery-points.md).
Creation still requests legacy history and protects the materialized empty
rollout before readiness. Recovery verifies the saved format, identity, digest,
terminal watermark and actual native response. Before projecting recovered
history, the returned turns must have unique IDs, complete item arrays and
terminal statuses; their final ID must match the protected watermark. An empty
watermark requires empty history. A changed or unavailable version string alone
cannot block these operations.

The manifest retains its format version and observed runtime version. The
rollout's creation version can differ from the runtime protecting it after
resume. Unsupported material and unknown operation outcomes remain refusals;
there is no fallback to a new thread or an older clean point.

## Alternatives

**Add each tested runtime to a whitelist.** This fixes one upgrade but recreates
the outage on the next compatible release and still confuses test coverage with
capability.

**Remove the version gate without checking restored history.** A runtime could
return an empty or truncated history while the original rollout still passes
its digest and terminal checks. Readiness must also depend on what was restored.

**Allow work after recovery protection fails.** This would change the existing
Bot durability guarantee and require a distinct degraded lifecycle. It is not
needed to admit a compatible runtime, so failed protection continues to close
dispatch and preserve the original evidence.

## Consequences

Compatible new runtimes and upgrades can use the existing recovery path without
an application release for each version number. This is not a promise that all
future native formats are compatible: concrete format or protocol failures
remain visible and retain recovery evidence. Dirty barriers, ownership, stopped
writer proofs and immutable snapshots are unchanged. Other providers and unrelated
version-qualified capabilities keep their existing contracts.
