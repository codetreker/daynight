# Agent Note: Native Worker tool presentation

Status: implemented

## Problem

Worker software observations can include several execution contexts and a separate Herdr tool. Showing all of them obscures the native tool facts and can associate a legacy version with a current execution.

## Decision

Worker software and tool details present Codex and Copilot Web observations. Configuration summaries use the same observations and preserve missing, stale, offline and failed states. The three-tool payload and configuration editor remain intact; overall configuration success still requires confirmation of every editable tool target. The [tool path editing decision](../feature/2026-11-12-worker-tool-path-web.md) retains the separate target, actual, candidate and running-selection facts.

## Alternatives

**Show legacy observations alongside native facts.** Their versions can describe different installations and would retain execution-mode distinctions in a native tool view.

**Replace missing Web observations with legacy values.** This would invent evidence for the current tool and could incorrectly show a target as applied.

## Consequences

Users can inspect real native selections and their errors without promoting legacy observations to current values. Missing observations remain unchecked; the existing configuration form and wire format continue to preserve their values independently.
