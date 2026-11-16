# Agent Note: Worker tool checks and mode application

Status: implemented

## Problem

An online Web Worker can report every ordinary configuration item applied while
its configuration summary keeps waiting on an unused Herdr slot. Separately,
adopted automatic tool choices can stay unchecked indefinitely, leaving users
without either a verified launch path or a concrete failure to repair.

## Decision

The existing tool selection manager owns bounded checks for all five adopted
tool/context choices. Configuration checks share target generations, inspection
and cleanup with execution preparation, but do not admit a Herdr instance.
Successful checks are reused; failures retain their code during bounded retry.
Changing a choice invalidates its check without migrating existing executions.

Configuration application and the Tool launch paths summary use one required
set derived from the target mode, default Agent and resolved Project Agents.
Web requires only its selected Codex/Copilot contexts. Herdr additionally requires
Herdr itself. Claude relies on native observations. Details preserve every
reported check and original active selection, including failures outside that set.
Current revision, choice and online evidence remain prerequisites for success.

This extends the [background demand decision](2026-11-13-worker-copilot-background-demand.md)
with settings checks, while retaining demand gating for ongoing Provider capability
discovery. It complements the [Web presentation decision](../feature/2026-11-12-worker-tool-path-web.md):
software inventory and configuration application answer different questions.
The [configuration specification](../../../../docs/spec/daynight-worker-configuration.md#工具路径三态)
owns the required outcomes and the [Worker design](../../../../docs/design/daynight-worker.md#本地工具路径选择)
owns probe and execution responsibilities.

## Alternatives

**Change only the waiting label or treat unknown slots as successful.** Neither
produces a checked path and version; the latter also misrepresents missing evidence.

**Require every checked tool for configuration application.** An unused Herdr or
Copilot failure would still block an otherwise fully applied Web configuration.

**Resume unconditional Provider background discovery.** This would restore the
unrelated model and capability probes that demand gating deliberately removed.
Settings checks need a bounded launch/version result, not ongoing Provider work.

## Consequences

Unused tool failures become actionable details without blocking unrelated modes.
Startup and choice changes incur bounded inspection work for up to five contexts.
Checking a Herdr executable does not establish that its runtime instance is ready;
instance admission and retained cleanup obligations still govern new execution.
The existing wire fields remain sufficient, and old or absent reports stay unknown.
