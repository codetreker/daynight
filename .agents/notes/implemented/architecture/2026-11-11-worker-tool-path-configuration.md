# Agent Note: Negotiated Worker tool path configuration

Status: implemented

## Problem

Local tool choices cannot survive cloud ownership unless the existing desired
resource represents them. A single adopted flag would discard local choices for
other tools when the Web first edits only one. Strict older readers reject new
fields, while older complete replacements can erase values they do not know.
Saved paths and bare version strings also cannot establish which executable
admits new work or which older selections still own running processes.

## Decision

The existing desired resource stores one nullable choice per tool. Null means
unadopted; explicit auto is a durable choice that never reimports an old local
path. A complete local bootstrap fills only null entries under the Worker lock.
Mode adoption and all tool adoptions form one final candidate, one budget check
and at most one revision increment. A cloud choice already committed wins;
a stale Web save conflicts rather than overwriting a concurrent import.

An independent `Daynight-Worker-Tool-Paths: 1` capability composes with the mode
capability and configuration protocols 1 and 2. Legacy readers receive their
strict projection. Legacy PUT preserves current tool values after CAS inside the
same lock, then validates and compares the complete candidate. The client learns
support from authenticated configuration reads, including authenticated 404,
and scopes that knowledge to origin and principal. A receipt missing either
negotiated projection schedules another configuration read before the next report.
Confirmed mode support does not suppress tool discovery after a server upgrade.
A report without confirmation cannot grant capability or justify replaying a
write with an unknown result.

Tool telemetry has one producer: the runtime selection manager. Public data
separates the current admission selection, a verified pending candidate and
aggregated active selections. It contains paths, version, timestamps and opaque
selection identity, never launch arguments, artifact contents or credentials.
Strict bounded groups and explicit incomplete observations preserve ordinary
heartbeats under report pressure. The existing request and resource limits remain
in force alongside the tool sub-budget.

The original tool-path cache seam used schema 4 to preserve mode, native, failure
and removal history. Schema 5 now separates current and retained records while
keeping those facts and their genuine provenance, as specified by the
[fact separation decision](2026-11-12-worker-configuration-fact-separation.md).
Runtime tool proofs start unverified. Complete targets and optional
selection-key inputs connect the configuration owner to the selection manager
without another application ledger or another probe. Incomplete cloud adoption
does not relabel a local choice as a cloud fact. Matching native qualification
includes the relevant choices and keys when the runtime adapter is present;
unrelated tool changes do not revoke that qualification.

This decision extends the [shared resolution decision](2026-11-11-worker-tool-path-resolution.md)
and the [cloud mode decision](2026-11-10-worker-cloud-control-mode.md).
Keeping local choices outside the old wire format was necessary before capability
negotiation existed. Their original rationale remains; negotiated cloud ownership
and selection-aware qualification now have explicit contracts in the
[configuration specification](../../../../docs/spec/daynight-worker-configuration.md)
and [snapshot specification](../../../../docs/spec/daynight-worker-snapshots.md#工具路径观察).

## Alternatives

**Add fields to every existing response.** Old strict clients reject them, and
configuration protocol versions already have separate prompt semantics. An
independent capability preserves their combinations without allowing unknown keys.

**Adopt all three tools when any cloud choice exists.** A Web edit of Codex would
erase an explicit local Copilot or Herdr path. Per-tool null preserves those
choices until their own import, while explicit auto prevents repeated imports.

**Keep old fields from a preflight GET.** Another writer can change the target
before PUT acquires its lock. Preservation must use the value observed after CAS
under the same Worker transaction.

**Rediscover extensions only while control mode is absent.** A server can support
mode before tool paths. Its legacy tool projection then persists across a later
upgrade, leaving a healthy running Worker unable to import local tool choices.

**Use version probes as application evidence.** A bare probe can observe another
installation or context, and one version cannot describe old and new running
selections. Only the runtime owner can provide those facts; bounded reporting must
describe omissions instead of inventing a complete inventory.

## Consequences

Configuration, telemetry and cache consumers can exchange tool targets without
changing the existing storage layout or old strict envelopes. The adoption state,
capability combinations, concurrency and output budgets require explicit tests.
Server validation proves representation and ownership, not executable behavior.
Until both extensions are present, configuration reports incur an additional
authenticated read to detect upgrades without restarting the Worker.

The [runtime integration decision](2026-11-12-worker-frozen-tool-runtime.md)
connects Web Task/Bot launches and a snapshot source to these API and cache seams;
Herdr instance mapping remains separate. The default collector emits no tool-path
facts without that source. The [Web consumer](../feature/2026-11-12-worker-tool-path-web.md)
negotiates the extension and preserves the three-state drafts and submitted
projection. Legacy saves remain safe. Real Provider startup retains its own
acceptance boundary; controlled browser results prove presentation and
configuration handling only.
