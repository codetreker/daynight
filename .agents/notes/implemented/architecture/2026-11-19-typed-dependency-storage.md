# Agent Note: Typed Dependency Storage

Status: implemented

## Problem

Goal acceptance relationships need to coexist with ordinary Task dependencies without changing task readiness, graph traversal or mutation. Existing instances can still write ordinary edges while an additive schema upgrade is applied. An old binary cannot safely interpret future Goal edges.

## Decision

Keep the existing dependency table and primary and reverse indexes. A non-null `dependency_type` defaults to `task`; a nullable `goal_edge_id` reserves identity for Goal edges. Every ordinary dependency read, traversal and mutation filters the task type, and inserts specify it. The initial storage delivery withheld Goal edge writes; the [independent REST resource](../feature/2026-11-19-goal-dependency-rest.md) exposes them with lifecycle and Project cleanup protection. Existing rows and old writes receive the task default.

The schema migration is additive. A running old instance can briefly coexist before Goal edges are introduced, but an old binary restarted against the new migration ledger rejects it. All old instances that access the table must exit before Goal edge writes are enabled.

## Alternatives

**A separate Goal edge table.** This isolates reads physically but duplicates adjacency storage and traversal infrastructure. The typed shared table retains the existing indexed paths while requiring explicit filters in each consumer.

**Infer edge type from endpoints.** The stored type makes each query and mutation explicit and avoids coupling ordinary reads to endpoint joins; inferring it also leaves old writers and future edge handling harder to distinguish.

## Consequences

Mixed data requires type predicates on every dependency access. New consumers and mutations must retain this isolation. The existing primary key prevents duplicate endpoint pairs across types; task and Goal endpoints are disjoint. The additive columns do not themselves enforce endpoint types. The [Goal lifecycle decision](2026-11-19-goal-dependency-lifecycle.md) protects stored relationships during status and direct deletion operations.
