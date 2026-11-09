# Agent Note: Worker local model and effort overrides

Status: implemented

## Problem

An enrolled Worker obtains its native configuration from the service. Editing
the legacy local model seed cannot change new executions, and an effective
configuration without per-field provenance makes local operator choices hard
to distinguish from cloud intent. A restart must also preserve the native
settings of an existing claim.

## Decision

Two optional local fields, `agentModel` and `agentReasoningEffort`, independently
override the effective cloud native tuple. The cloud manager retains its own
desired and applied values. A separate versioned telemetry observation reports
the composed values and their sources. Removing a field restores the cloud
value or delegates to the native Agent on the next Worker start.

The normalizer extracts model and effort options before applying overrides and
emits the Provider-specific representation. It does not edit native files.
Same-layer legacy model disagreements are rejected. New claims persist their
native tuple, while native resume omits model and effort arguments so that
current defaults cannot overwrite an existing conversation.

This partially supersedes the cloud-only native authority and Herdr restart
choice in the archived [runtime configuration decision](../../archived/architecture/2026-11-04-worker-cloud-runtime-configuration.md).
That record preserves the original rationale for independent application,
retries and cloud intent. The [Worker requirements](../../../../docs/spec/daynight-worker.md)
and [design](../../../../docs/design/daynight-worker.md) own current behavior.

## Alternatives

**Apply the new fields only during bootstrap.** Enrolled Workers would ignore
local changes, preserving the original problem.

**Write local overrides back to cloud desired state.** Removing a local field
would leave its copied value in the cloud and could not restore the previous
lower-priority setting. The displayed source would also be false.

**Keep Herdr restart on current defaults.** This would change a claim's model
after a restart while its original native identity remains unchanged.

## Consequences

Cloud intent and effective execution settings have separate representations.
Consumers must use the source observation for composed defaults and must not
interpret null/native as an observed resolved model. Older stored reports
remain readable; services must support the new optional telemetry object before
receiving it. Native capability and startup failures remain visible rather than
silently selecting a replacement model or effort.

Old claims without a historical tuple cannot acquire fabricated historical
settings. A known native session resumes without model/effort injection; an old
record with no session freezes its first new execution configuration.
