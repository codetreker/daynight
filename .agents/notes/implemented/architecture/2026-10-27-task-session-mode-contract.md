# Agent Note: Claim-Frozen Session Control Mode

Status: implemented

## Problem

A task's native session identifier does not identify which service controls its
execution. Reinterpreting an existing claim from the machine's latest settings
could route recovery or cleanup through the wrong backend. Browser clients also
need a durable source for deciding whether a task has a Web session.

## Decision

The worker configuration and claim carry `agentControlMode: herdr | web`.
Existing request negotiation can omit the mode under its Herdr semantics; stored
claims always include it. The [property-row migration](2026-10-30-task-property-rows.md)
freezes normalization of missing legacy record values to `herdr`, without runtime
stored-data fallback. Mode is frozen with the claim; Web also freezes execution
configuration and protected from summary and general task-property updates.
Provider and mode are validated together. The
[claim design](../../../../docs/design/daynight-worker-claims.md) owns storage and
HTTP behavior; the [session contract](../../../../docs/design/task-session-protocol.md)
owns shared wire identity, supported operations and upgrade behavior.

The original [worker design](2026-10-22-worker-design.md) used Herdr for every
native execution. Herdr remains the default backend, while the independent Web backend owns
Controller launch, native identity and stopping evidence. A failed Web
connection never routes its claim or cleanup through Herdr.

The initial Web implementation covered Codex and Claude; Copilot retained its
existing Herdr path while the Web runtime ownership and native receipt rules
were established. The [Copilot SDK decision](2026-10-28-copilot-web-sdk-runtime.md)
extends Web execution to Copilot without changing the frozen-mode rule or adding
a TUI handoff. Each provider keeps its own transport and acknowledgement evidence.

Shared pure TypeScript code is compiled into the CLI and consumed by the Web
build. Go and TypeScript validate common wire fixtures. Per-tool waiting and working states stay in the Session stream; they do not
change the task version, because native approval could otherwise invalidate
the version read immediately before a task update. Execution generations
are separate from connection epochs; browser operations are tied to the native
execution and current turn or interaction, not to one network connection.

## Alternatives

**Infer mode from local settings or native session IDs.** Settings can change
after a claim starts, and native IDs exist in both modes. Neither preserves the
original cleanup responsibility or tells another machine how to render a task.

**Observe the TUI and take control later.** This would require transcript
projection, a native-owner handoff and recovery across execution models. Choosing
one mode before execution removes that transition; the browser path needs its
own runtime and relay instead.

**Publish a separate shared package immediately.** The CLI is distributed as a
standalone npm package. An additional package introduces release ordering and
version compatibility for a contract whose consumers live in one repository.
Pure source reuse preserves one definition without that publication dependency.

## Consequences

The [Web evidence decision](2026-10-28-web-execution-evidence.md) separates
Controller persistence from Herdr’s minimal claim index and process-local jobs.

The [independent Controller testing decision](2026-10-28-controller-test-session-ownership.md)
extends the shared session implementation with explicit Test ownership. It does
not add a task mode or relax this decision's claim-bound execution rules.

The initial response contract required client-first upgrades because old strict
parsers rejected new WorkerClaim fields even for Herdr. The
[worker protocol negotiation decision](2026-10-28-worker-protocol-negotiation.md)
replaces that rollout requirement with explicit response negotiation and locked
mutation guards, while preserving this decision's stored mode and claim ownership.
Unsupported executable backends fail before acquiring new work or performing
Herdr operations; schema availability must not be advertised as native execution
support.

Text input is the initial command shape. Typed content and session-bound resource
descriptors allow attachment input to be added without replacing message identity
or weakening resource authorization. The Controller owns one private native writer and a durable journal; the
Daynight service owns authenticated relay and operation fencing. The
[local content decision](2026-10-28-local-session-content.md) replaces its original
stored-history responsibility with Controller-owned content and online reads.
The Task Session UI consumes that local projection and provider-specific capabilities.
Native user-message identity can resolve uncertain input receipt when it carries
the original operation identity. Copilot cannot correlate lost input ACKs from
historical message text; only an exact late result from the same live call can
resolve that uncertainty. An idle state cannot confirm input. Real-provider validation remains necessary for lifecycle and
interaction guarantees; parsing and fixtures cannot establish them.

POSIX stopping evidence covers the Controller process group and recorded native
process identities. Tools that deliberately detach into a different group need
explicit task cleanup; an empty original group does not prove that arbitrary
daemons have stopped. Windows uses a non-breakaway Job Object and requires
platform-specific runtime validation.
