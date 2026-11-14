# Agent Note: Single Project GitHub Sync Executor

Status: implemented

## Problem

A Project needs complete, recoverable PR synchronization across service instances even when a traversal takes longer than a lease, GitHub pages change during the traversal, or authorization and webhook hints change while requests are in flight.

## Decision

Use one callable executor per claimed Project. Short database transactions establish and renew a generation-bound lease, publish finite batches, and complete work; external requests remain outside those transactions. Each HTTP hop and publication batch checkpoints the original lease. A completed open traversal individually confirms previously active PRs absent from its pages. Webhook hints fetch current facts and acknowledge only their captured request IDs. The [executor design](../../../../docs/design/github-sync-executor.md) describes the execution and recovery contract.

## Alternatives

**Use a fixed deadline for the entire poll.** A large but finite repository could repeatedly lose the tail and never finish absence reconciliation. A renewable lease bounds individual operations while allowing the traversal to finish.

**Treat missing list entries or webhook payloads as current state.** GitHub pagination is not a snapshot and delivery can be delayed or reordered. Current individual reads and lease-fenced writes preserve facts without assuming absence means closure.

## Consequences

The executor can resume through subsequent work after failures and preserves independent poll and webhook status. A crashed process or uncertain renewal can leave a claim until its five-minute expiry. Per-Project isolation can repeat requests for the same repository; the caller owns scheduling and lifecycle integration. The [synchronization setting decision](2026-11-14-project-github-sync-setting.md) uses the generation and lease fence to reject work after synchronization is disabled.
