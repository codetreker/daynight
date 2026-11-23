# Agent Note: Native Worker tool presentation

Status: implemented

## Problem

Worker software observations can include several execution contexts and a separate Herdr tool. Showing all of them obscures the native tool facts and can associate a legacy version with a current execution.

## Decision

Worker software and tool details present Codex and Copilot Web observations. Configuration summaries use the same observations and preserve missing, stale, offline and failed states. The initial presentation change retained the three-tool payload and editor; the [two-tool protocol decision](../architecture/2026-11-17-worker-two-tool-protocol.md) later removed the Herdr tool and mode from the public contract and editor. Overall configuration success requires confirmation of every editable tool target. The [tool path editing decision](../feature/2026-11-12-worker-tool-path-web.md) retains the separate target, actual, candidate and running-selection facts.

## Alternatives

**Show legacy observations alongside native facts.** Their versions can describe different installations and would retain execution-mode distinctions in a native tool view.

**Replace missing Web observations with legacy values.** This would invent evidence for the current tool and could incorrectly show a target as applied.

## Consequences

Users can inspect real native selections and their errors without promoting legacy observations to current values. Missing observations remain unchecked; target and observed values remain independent.
