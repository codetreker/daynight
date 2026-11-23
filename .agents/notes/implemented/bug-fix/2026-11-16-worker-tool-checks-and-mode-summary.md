# Agent Note: Worker tool checks and mode application

Status: implemented

## Problem

When Worker targets included five tool/context slots, an online Web Worker could
report every ordinary configuration item applied while its configuration summary
kept waiting on an unused Herdr slot. Separately, adopted automatic tool choices
could stay unchecked indefinitely, leaving users
without either a verified launch path or a concrete failure to repair.

## Decision

The original decision assigned bounded checks for all five adopted tool/context
choices to the selection manager. Checks shared target generations, inspection
and cleanup with execution preparation without admitting a Herdr instance.
Successful checks were to be reused and failures retained during bounded retry;
choice changes invalidated checks without migrating existing executions.

The original application summary used a required set derived from target mode,
default Agent and resolved Project Agents: selected Codex/Copilot contexts for
Web, Herdr itself additionally for Herdr mode, and native observations for Claude.
Details retained failures outside that set. This mode-based success rule and the
five-context check mechanism are replaced by the
[adopted two-tool checks decision](2026-11-24-worker-adopted-tool-checks.md).
Current configuration success requires all editable tool targets, consistent
with the [native presentation decision](../simplification/2026-11-17-worker-native-tool-presentation.md).

The distinction from the [background demand decision](2026-11-13-worker-copilot-background-demand.md)
remains: bounded settings checks do not enable ongoing Provider capability
discovery. This complements the [Web presentation decision](../feature/2026-11-12-worker-tool-path-web.md):
software inventory and configuration application answer different questions.
The [configuration specification](../../../../docs/spec/daynight-worker-configuration.md#工具路径三态)
owns the required outcomes and the [Worker design](../../../../docs/design/daynight-worker.md#本地工具路径选择)
owns probe and execution responsibilities.

## Alternatives

**Change only the waiting label or treat unknown slots as successful.** Neither
produces a checked path and version; the latter also misrepresents missing evidence.

**Require every checked tool for configuration application.** In the original
five-context contract, an unused Herdr failure would block an otherwise applied
Web configuration. Retirement of Herdr removed that rationale; the current
two-tool contract requires confirmation of both editable targets.

**Resume unconditional Provider background discovery.** This would restore the
unrelated model and capability probes that demand gating deliberately removed.
Settings checks need a bounded launch/version result, not ongoing Provider work.

## Consequences

The original design separated launch inspection from runtime-instance readiness
at the cost of inspecting up to five contexts. The replacement retains bounded
checks and truthful errors for the two current tools without restoring retired
runtime ownership. Existing wire fields remain sufficient; old or absent reports
stay unknown and existing execution cleanup obligations remain authoritative.
