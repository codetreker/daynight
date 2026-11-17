# Agent Note: Worker per-tool readiness

Status: implemented

## Problem

Cloud adoption is independent for each tool, but requiring a complete bootstrap
to prepare any tool blocks Web execution when an unrelated tool is unadopted.
A local replacement would misrepresent the cloud choice and could select an
installation the user did not adopt.

## Decision

The selection manager receives each validated choice or null with its actual
source and revision. Web native qualification requires its provider's tool;
Herdr qualification also requires Herdr. An unadopted required choice cannot
be prepared or selected. Unchanged choices retain their in-flight inspection
when other choices or the target revision change; a changed choice revokes its
own admission. Frozen recipes retain their separate verification and cleanup
responsibilities.

The existing telemetry format requires a non-null target. An unadopted tool's
last real target retains its original source and revision and is reported as
configuration unavailable when the wire permits it. Otherwise its entry is
omitted. Other observations retain their real choices and evidence. Network
bootstrap and telemetry contracts remain unchanged. This refines the
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
