# Agent Note: Confirm CLI Step movement against observed order

Status: implemented

## Problem

A successful position response can contain the wrong order or conceal changes
to unrelated records. A move can also be a no-op, including at the maximum parent
version. The CLI must distinguish that from an actual version increment without
adding reads to the explicit-version request budget. A lost response must retain
the original identity and remain unknown even if the target is currently found.

## Decision

The [CLI movement contract](../../../../docs/spec/daynight-task-steps.md#cli-移动与结果确认)
uses four mutually exclusive positions and Task-local canonical identities.
`step-move.ts` compiles exactly one position and rejects malformed IDs, versions
and self-reference before configuration or transport. The command definition
owns help and both shell completion generators.

The typed API confirms the requested endpoint or anchor adjacency in the complete
resource and permits only the submitted version or +1. When the default-version
path supplies a real pre-read, it compares all Step fields and timestamps, the
surviving relative order and the actual target index. Unchanged index requires
the same version; a different index requires +1. Explicit versions preserve the
single PUT budget and cannot compare content against an unobserved baseline.

Move and [Add](2026-11-04-task-steps-cli-add.md) share `executeStepWrite`,
operation-tagged attempts, factual recovery and safe diagnostics. Each retains
its actual target and request UUID; an eligible unknown result gets at most one
same-operation `.r1` GET, never a repeated write. The existing transport and
runtime confirmation marker preserves a validated result through later local
cleanup, rendering or output failure. JSON remains the complete service resource;
readable output retains the current saved order and safe terminal escaping.

## Alternatives

**Always read before an explicit-version move.** This would make comparing old
content possible but violate the one-business-request budget. Exact position,
resource and version checks use the facts available in the chosen mode instead.

**Accept any valid resource with version equal to the input or +1.** With an
observed baseline, this would accept a changed order without an increment or an
incremented no-op. Comparing the complete expected order exposes both and checks
that movement preserves content timestamps.

**Copy Add's unknown-result pipeline for Move.** Separate failure classification
and observation code would duplicate cancellation, principal and byte-budget
rules. A shared operation-tagged handler keeps those rules with their owner while
each API method confirms its own result semantics.

## Consequences

Default-version writes provide stronger baseline comparisons, while explicit
versions retain their documented request budget. Unknown current-state reads
cannot confirm historical attribution. Moving to the existing position is still
a confirmed operation and does not invent a parent increment or content time.

Client tests cover malformed receipts, exact versions and placement. Command
tests cover pre-I/O validation, request counts, safe diagnostics and local result
failures. Installed Go/PostgreSQL cases cover complete persisted order, no-op,
maximum version and lost responses after real commits. No new transport executor,
retry service or Step workflow policy is introduced.
