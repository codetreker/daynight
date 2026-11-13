# Agent Note: Copilot probe stop confirmation

Status: implemented

## Problem

A Copilot status or model query can succeed while the runtime takes longer than
the graceful shutdown RPC deadline to dispose telemetry. Treating that deadline
as unresolved cleanup after the SDK transport and owned native process have
actually stopped rejects an otherwise valid Worker tool selection.

## Decision

Probe cleanup distinguishes the graceful RPC outcome from final resource
closure. It retains the existing RPC, SDK stop and process escalation deadlines.
When graceful SDK cleanup fails, the probe must confirm forced SDK transport
closure and owned process closure before returning a successful read. Failure of
either final owner remains `cleanup_unknown`; an unsuccessful read remains a
failure even when cleanup succeeds. Cleanup errors retain the original read
failure as well as graceful and final closure errors.

This applies the same distinction used by the Provider runtime. It complements
the [graceful exit decision](2026-11-11-copilot-graceful-native-exit.md), which
governs the bounded wait after an acknowledged shutdown, and preserves the
[frozen runtime decision](../architecture/2026-11-12-worker-frozen-tool-runtime.md)'s
outer supervisor responsibility for descendants.

## Alternatives

**Increase the graceful RPC deadline.** A longer wait might accommodate one
runtime's telemetry delay, but still conflates acknowledgement with resource
closure and adds latency to every slow probe.

**Reject every graceful shutdown error.** This preserves the earlier conservative
classification but blocks healthy selections after final closure is confirmed.

**Ignore all cleanup errors after a successful read.** This permits replacement
probes while their original transport or process remains unconfirmed.

## Consequences

Verified tool and model results survive a failed graceful shutdown only after
both final owners close. The probe does not retry the read or shutdown RPC, change
the frozen selection, create a Session, or relax descendant ownership. Forced
cleanup can terminate unfinished native telemetry; it does not claim that the
graceful RPC succeeded.
