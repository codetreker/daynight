# Agent Note: Worker per-tool readiness

Status: implemented

## Problem

Cloud adoption is independent for each tool, but requiring a complete bootstrap
to prepare any tool blocks Web execution when an unrelated tool is unadopted.
A local replacement would misrepresent the cloud choice and could select an
installation the user did not adopt.

## Decision

The selection manager receives each validated choice or null with its actual
source and revision. Web native qualification requires its provider's tool.
The original Herdr qualification also required Herdr; that execution path is
retired by the [Web-only native model](../simplification/2026-11-18-web-only-native-tool-model.md).
An unadopted required choice cannot
be prepared or selected. Unchanged choices retain their in-flight inspection
when other choices or the target revision change; a changed choice revokes its
own admission. Frozen recipes retain their separate verification and cleanup
responsibilities.

The existing telemetry format requires a non-null target. An unadopted tool's
last real target retains its original source and revision and is reported as
configuration unavailable when the wire permits it. Otherwise its entry is
omitted. Other observations retain their real choices and evidence. The
[two-tool protocol](2026-11-17-worker-two-tool-protocol.md) limits current
network bootstrap and telemetry to the retained Web tools. This refines the
[cloud configuration decision](2026-11-11-worker-tool-path-configuration.md).

## Alternatives

**Require all three choices.** An unrelated unadopted tool blocks a provider
whose actual requirements are already satisfied.

**Fill missing cloud choices from local configuration.** This would assert a
cloud target that has not been adopted and could run an unintended executable.

## Consequences

Providers can prepare independently without inventing tool choices or probes.
The current telemetry cannot expose active-selection details for an unadopted
tool without a reportable historical target; it cannot represent those details
with a null target. The shared probe owner still retains its cleanup obligations.
