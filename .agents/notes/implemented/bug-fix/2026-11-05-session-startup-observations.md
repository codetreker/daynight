# Agent Note: Generation-bound startup observations

Status: implemented

## Problem

A Controller can fail before its first relay hello while the service still has
only a registered, initializing Session. The Worker retains the initialization
error and may block recovery because no original native identity is proven, but
its ordinary phase and native ID summary cannot convey either fact. A timeout
also cannot establish that the provider rejected or never created a session.

## Decision

The Controller persists typed startup observations, distinguishing explicit
rejection from unknown transport outcomes. The Worker combines those facts with
its durable recovery block and publishes a generation-bound, monotonic report
through the existing claim update. Reporting remains independent of execution
recovery and does not send native input. The [protocol design](../../../../docs/design/task-session-protocol.md#启动观察的独立上报)
owns fields, ordering, permissions and compatibility.

A matching journal's unfinished `starting/initializing` observation does not
replace a persisted Worker `unknown/controller_start_unknown` launch outcome.
An abrupt pre-hello exit can leave a nonterminal journal, so its lifecycle alone
cannot show progress after that outcome. The observer accepts subsequent typed
ready, rejection and specific unknown initialization results from the same
generation. It uses the existing semantic-change revision rule, preserving the
observation time when neither startup nor recovery changes. This is a specific
producer precedence rule, not a ranking of all startup states or wall clocks.

Provider adapters normalize proven SDK initialization rejections before cleanup.
Copilot remote RPC errors and Claude structured control-response errors do not
share the native RPC error class; SDK transport errors must retain uncertainty.
Cleanup failures remain private diagnostics and cannot replace the original
startup outcome or establish a process stop proof.

Failed Copilot initialization disposes the SDK transport through its public
`forceStop()` before terminating the owned runtime. It skips graceful session and
runtime RPCs because the failed connection cannot establish their completion.
The SDK arms its teardown writer protection before disposal; process termination
still uses the owner's existing signal and exit checks. Successful providers keep
their graceful close path. This avoids generating a second failure while cleaning
up an already failed startup.

A protected, separate task property stores the report. An explicitly negotiated
current response exposes only the matching claim, Session, generation and
Controller instance. Existing Worker and Session snapshot shapes remain stable.
The report contains fixed reason codes; safe text is derived from a fixed map,
while private raw diagnostics remain local. Observation timestamps describe
historical evidence, not current transport health.

The [persistent recovery pause decision](../../archived/bug-fix/2026-11-04-web-recovery-pause.md)
records the rationale for recovery budgets, explicit retry, original identity
and stop proof. Its original implementation deliberately reported only phase and native
identity; the independent report adds visibility without changing those gates.

## Alternatives

**Always prefer a matching journal.** The journal owns native initialization
facts, but an abrupt Controller exit can prevent it from recording any outcome.
Reading its unfinished record after the Worker observes launch uncertainty would
publish apparent initialization with a higher revision. The launcher outcome
must survive that read until the journal supplies an actual result.

**Put diagnostics directly in every Session snapshot.** This would reach live
consumers but would require compatibility projection across HTTP, welcome frames,
events and archives. Older strict consumers reject new fields, and a Controller
that cannot connect still needs an independent Worker path.

**Extend properties.worker directly.** Existing strict Worker parsers would reject
the entire task on every read surface. A separate protected property lets old
consumers retain their existing ownership parser.

**Report raw errors or infer failure from disconnection.** Raw provider errors can
contain paths, credentials or user input. Disconnection and native timeouts do
not prove rejection. Fixed classified reasons preserve useful facts without
inventing an outcome or publishing private logs.

**Patch the JSON-RPC dependency only.** Its failed-write handler both rejects the
request and throws from an async promise executor, creating an orphan rejection.
A workspace pnpm patch fixes local installs but does not ship with the published
CLI's ordinary npm dependencies. Bundling the SDK or intercepting its private
writer would expand dependency ownership. Public force-stop handles failed-startup
cleanup without either mechanism; arbitrary active-request write races in the
pinned dependency remain outside this correction.

## Consequences

The service can expose startup uncertainty and blocked recovery before any hello,
with the same task authorization and CAS used for Worker updates. Session fencing
and report revisions reject obsolete observations, including after grant rotation
that does not advance the task version. Reconciliation failures preserve local
facts and native recovery budgets.

The [orchestration block decision](2026-11-05-worker-orchestration-blocks.md)
keeps ordinary worktree failures out of native recovery reports and defines the
verified correction of legacy misclassification.

The report is not a heartbeat or an authority to retry. UI presentation remains a
separate consumer of the contract. Old local records remain readable as unknown;
older binaries do not support downgrading a local JSON record containing the new
strict fields. Controlled stdio and HTTP/database evidence does not establish the
cause of a real provider initialization delay.

Service instances must be upgraded together before new Workers publish reports.
The old Go property registry cannot read the new stored property; wire compatibility
does not provide mixed-version server operation or storage downgrade support.
