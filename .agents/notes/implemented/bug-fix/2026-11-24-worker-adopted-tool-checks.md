# Agent Note: Adopted Worker tool checks

Status: implemented

## Problem

An adopted automatic tool choice can remain unchecked when no current workload
uses that provider. Hiding its concrete failure as an unchecked state leaves the
configuration waiting without explaining which installation needs repair.

## Decision

The Worker checks each adopted Codex and Copilot Web choice through the existing
selection manager, independently of provider demand. Current successful checks
are reused. Failed checks retain their real error and retry no more often than
the background interval. Changed choices, unavailable targets and shutdown
cancel the corresponding checks; selection generations and existing cleanup
receipts remain authoritative. An unadopted choice starts no check.

The editor and software shortcut call the section Tool launch paths. Summaries
preserve the reported failure, checking, pending and unchecked states. Overall
configuration success still requires current applied evidence for every editable
tool, as required by the [native presentation decision](../simplification/2026-11-17-worker-native-tool-presentation.md).
An unused tool's failure does not imply that unrelated execution is unavailable.

This replaces the five-context and mode-based parts of the
[original checks decision](2026-11-16-worker-tool-checks-and-mode-summary.md)
under the [two-tool protocol](../architecture/2026-11-17-worker-two-tool-protocol.md).
It extends [background demand gating](2026-11-13-worker-copilot-background-demand.md)
only for bounded configuration checks; ongoing capability discovery remains
demand-based. The [configuration specification](../../../../docs/spec/daynight-worker-configuration.md#工具路径三态)
and [Worker design](../../../../docs/design/daynight-worker.md#本地工具路径选择)
own the current contract and mechanism.

## Alternatives

**Require only providers selected by current work.** This would let a failed
editable tool target appear within a fully applied configuration and contradict
the current all-tool confirmation contract.

**Retain five-context checks and Herdr inspection.** The retired protocol no
longer supplies those targets. Restoring their lifecycle would introduce new
execution and compatibility obligations unrelated to the remaining defect.

**Resume unconditional capability discovery.** Settings need a bounded launch
inspection, not repeated model discovery or long-lived provider resources.

**Change only the waiting label.** This exposes no verified path or concrete
failure when the adopted choice has never been inspected.

## Consequences

Adoption and choice changes can inspect both tools even without workload demand;
automatic Copilot may materialize its bundled runtime. Inspections share existing
budgets and process ownership. Success is not an authentication or future
execution guarantee. Missing or offline evidence remains unconfirmed, and failed
configuration checks remain visible during bounded retries. Existing executions
keep their frozen selections. No extra wire fields or remote installation flow
are needed; broader provider recovery remains outside this mechanism.
