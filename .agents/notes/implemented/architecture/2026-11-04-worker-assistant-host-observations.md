# Agent Note: Worker Assistant Host Observations

Status: implemented

## Problem

A recent Worker heartbeat proves neither that the Worker understands assistant
hosting nor that its native providers can use the Web adapter's arguments. The
existing version observations omit Claude and do not carry effective defaults.
Reusing another provider's model or treating an old successful probe as current
would select an environment that cannot start the requested conversation.

## Decision

The optional assistantHost v1 observation carries the startup directory, global
provider, and one bounded preflight result for each supported provider. It uses
the Web adapter argument rules and executable sources. Only the configured
provider inherits global model and arguments. The collector validates a real
local directory; the server validates platform-specific absolute path syntax.

The existing telemetry JSONB owns storage. A new report replaces the complete
observation, including clearing a former assistantHost when it is omitted.
Strict input parsing keeps the extension optional while requiring every field
inside a provided object. Worker detail parsing accepts the extension without
changing ordinary Worker summaries or enabling assistant UI.

The service evaluates Worker receipt time and assistant observation time
separately with the existing 120-second liveness bound. Future observations are
not evidence of availability. A fresh successful provider probe is a candidate
condition, not proof of authentication or a synchronized native Session.

The default runtime leaves the collector disconnected until the complete
hosting path is integrated. When composed, ordinary Codex/Copilot version
observations and assistant-host preflight now share one process-lifetime
cleanup-uncertainty barrier per executable identity (`codex` or `copilot`).
After either observer reports unconfirmed command cleanup, both observers stop
starting replacement probes for that executable while unrelated executables
remain observable. The first cleanup error remains authoritative for later
unavailable reports and shutdown propagation.

The [snapshot contract](../../../../docs/spec/daynight-worker-snapshots.md#助手托管预检)
owns exact fields and limits; the [collection design](../../../../docs/design/daynight-worker-reporting.md#助手托管预检接入)
owns execution and cleanup behavior.

## Alternatives

**Advertise from ordinary heartbeat or version data.** This would admit old
Workers and confuse installed software with Web argument support. It also cannot
provide the configured default provider without inventing a fallback.

**Keep successful capabilities when later reports omit them.** The task
inventory's null semantics preserve historical observation intentionally, but
applying that rule to hosting capabilities would retain an unsupported or
withdrawn candidate. Complete telemetry replacement provides the required
revocation without a separate migration or history store.

**Add a derived state to every Worker summary.** The existing Web reader checks
exact summary fields. The reusable service decision and optional detail object
provide the creation consumer's input without changing that unrelated response
shape or adding a second UI availability indicator.

## Consequences

Legacy reports remain valid and cannot become assistant candidates. Failures
remain explicit, and unsupported arguments and raw native output are excluded
from reports. Bounded probes retain cleanup responsibility instead of starting
replacement processes after uncertain termination. In composed mode, a cleanup
uncertainty reported by either observer blocks later probes by both observers
for that executable even after ordinary cache expiry. Telemetry joins every
probe before propagating assistant failure or cancellation, preserving all
cleanup errors so reporter shutdown cannot finish before native cleanup.

The protocol does not provide hosting, authentication checks, successful Bot
creation, or cross-machine path verification. Those consumers must combine the
fresh observation with their own execution and permission checks. Enabling the
advertisement requires a complete hosting implementation; publishing a field
alone must not make an unfinished Worker selectable.
