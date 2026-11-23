# Agent Note: Recover Unsubmitted Worker Initial Input

Status: implemented

## Problem

A managed Controller can stop after binding its native session but before dispatching its first assignment. Its replacement retains the original journal and input identity, yet refusing every unsubmitted input after a generation change leaves an execution permanently idle even when durable evidence proves no dispatch occurred.

## Decision

The Worker and Controller require the matching current ticket, native binding, adjacent complete stopped-generation receipt and original journal operation before continuing the first input. An absent operation or an exact prepared-only `accepted` operation permits the original queued submission; the Controller creates or atomically adopts that operation before recording dispatch. The [Worker design](../../../../docs/design/daynight-worker.md#web-backend-与执行证据) and [Task Session design](../../../../docs/design/task-session-protocol.md#controller-与原生会话) own the detailed boundaries. This extends the [Controller Worker input admission](../architecture/2026-11-17-controller-worker-input.md) decision without relaxing its task and readiness checks.

## Alternatives

**Refuse every later-generation initial input.** This avoids replay but permanently strands executions whose durable journal proves that dispatch never began.

**Infer non-dispatch from the service snapshot or an empty timeline.** Neither proves that a native request was never sent, so a retry could duplicate an assignment.

## Consequences

The stopped predecessor and journal must remain available and consistent. A lifecycle reservation can be committed before the dispatch record; recovery must also verify and adopt that original prepared reservation under the current admission fence. The two stores do not commit atomically, so a later generation retains the same responsibility after an interrupted handoff. Inputs that may already have reached the Provider remain subject to their existing reconciliation and cannot be reclassified as prepared. Repeated requests for a proven prepared input use the same operation and native queue; they do not establish an exactly-once result after a dispatch becomes uncertain.
