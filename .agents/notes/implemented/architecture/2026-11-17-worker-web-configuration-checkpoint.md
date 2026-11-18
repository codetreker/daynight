# Agent Note: Apply Worker configuration through Web

Status: implemented

## Problem

A configuration target can describe an execution mode that the current Worker
cannot apply. The mode value, native validation and Project cleanup must not
silently turn that target into another execution, invent application evidence or
lose outstanding work. Deployed checkpoints also contain mode-specific facts
whose actual provenance cannot be inferred from the current target.

## Decision

The configuration manager applies current targets through the Web execution
path. An explicit Herdr target remains unchanged in raw authority and is
reported as unsupported. An omitted local mode uses Web; an explicit local
Herdr candidate is rejected with a correction, without rewriting the file.
The original schema 9 decision omitted mode application items to avoid inventing
success merely from the desired value. The later [mode adoption decision](2026-11-18-worker-web-mode-adoption.md)
introduced a persisted confirmation for the then-current public mode field.
The [two-tool protocol decision](2026-11-17-worker-two-tool-protocol.md) retires
that public field and its bootstrap and observation; ordinary current targets
do not produce a mode application item.

GET and report receipts can carry a structurally valid raw target whose known
field type or value this Worker cannot decode. The complete source and validated
revision remain authoritative, while the known view is unavailable; this state
is not null authority and does not trigger a new bootstrap. JSON, envelope,
timestamp, revision, negotiated capability and observation relation failures
remain protocol errors. The schema 9 format introduced `pendingApplication` to distinguish
unreconciled raw authority, including null or unsupported targets, from a Web
target whose ledger has been reconciled. The flag does not claim that individual
side effects succeeded. After restart or recovery from an unsupported target, a
valid Web target is reconciled even when its values match an earlier target.

Schema 9 distinguished the Web ledger from deployed schemas 1–8. The frozen
storage decoder validates the original format before conversion. Its migration dropped
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
[cloud control mode decision](2026-11-10-worker-cloud-control-mode.md); the
two-tool protocol later retires its negotiated public mode contract. It extends the independent
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
availability. Schema 10 retains that boundary and its historical layout; the
current protocol no longer publishes mode feedback. Older binaries cannot consume
the new checkpoint; atomic migration and strict historical readers preserve facts
without granting rollback compatibility. The [Worker design](../../../../docs/design/daynight-worker.md#云端接收与本机提交)
and [configuration contract](../../../../docs/spec/daynight-worker-configuration.md)
own the detailed mechanisms and observable behavior.
