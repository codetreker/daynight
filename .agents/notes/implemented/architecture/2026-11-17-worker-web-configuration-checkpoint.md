# Agent Note: Apply Worker configuration through Web

Status: implemented

## Problem

A configuration target can describe an execution mode that the current Worker
cannot apply. The mode value, native validation and Project cleanup must not
silently turn that target into another execution, invent application evidence or
lose outstanding work. Deployed checkpoints also contain mode-specific facts
whose actual provenance cannot be inferred from the current target.

## Decision

The configuration manager accepts only an adopted Web target for new
configuration work. An explicit Herdr target remains unchanged in raw authority
and is reported as unsupported. A null or unadopted mode has no execution
qualification. The existing public capability and three-tool wire remain, with a
real `controlModeBootstrap:web`; no mode application item is synthesized. The
service may accept a partial observation and omitted mode evidence remains unknown.
An omitted local mode produces a Web bootstrap candidate; an explicit local
Herdr candidate is rejected with a correction, without rewriting the file.

Schema 9 distinguishes the Web ledger from deployed schemas 1–8. The frozen
storage decoder validates the original format before conversion. Migration drops
mode items and `nativeMode`; only native actual values proven to have used Web
retain their values and sources, and the new process still revalidates them.
Other native values, sources and corresponding failures become pending. Raw
authority, remote observations, hidden sources, sudo provenance, identities,
started removals, blockers and other failure ownership survive conversion;
generation changes and the report cursor resets. Atomic persistence completes
before the checkpoint becomes ready. Corrupt or foreign files are errors rather
than empty state.

Native proofs bind the current process, record, native tuple and actual Web tool
choices and selection keys. Only the Provider's required Codex or Copilot choice
is prepared; no Herdr candidate is probed for configuration. A valid current
proof may follow its record's actual value, while a changed relevant selection
invalidates that proof. A historical source is not process proof. Unsupported
raw Projects do not authorize a new application or an empty replacement set;
existing removal responsibility and exact receipt/failure fencing remain. Project
removal operates on Web responsibility and does not take over old Herdr resources.

This decision replaces the Worker application and proof portions of the
[cloud control mode decision](2026-11-10-worker-cloud-control-mode.md), while its
negotiated service contract remains. It extends the independent
[stored decoder](2026-11-17-worker-stored-configuration-decoder.md) and
[configuration fact separation](2026-11-12-worker-configuration-fact-separation.md)
without discarding their raw-source or provenance guarantees.

## Alternatives

**Reuse schema 8 for both layouts.** The deployed schema 8 contains mode items
and mode-bearing records. Structural discrimination requires special handling
for indistinguishable empty ledgers and makes the version alone ambiguous.

**Rewrite Herdr targets to Web.** This changes user-owned desired configuration
and could authorize new execution without the user's chosen target.

**Retain the mode application item with a synthetic success.** The Worker would
report a mode result it did not actually apply. The existing service accepts
partial observations without that fiction.

## Consequences

The current Worker can synchronize and preserve an unsupported target while
closing admission, and its Web qualification does not depend on Herdr tool
availability. Older binaries cannot consume schema 9; the atomic migration and
strict historical reader preserve facts without granting rollback compatibility.
The public mode and tool fields remain until their actual consumers and protocol
are retired. The [Worker design](../../../../docs/design/daynight-worker.md#云端接收与本机提交)
and [configuration contract](../../../../docs/spec/daynight-worker-configuration.md)
own the detailed mechanisms and observable behavior.
