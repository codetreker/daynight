# Agent Note: Web-only native tool model

Status: implemented

## Problem

After the Herdr execution consumers were removed, native selection and platform
resolution still modeled its tools, launch arguments and live terminal protocol.
These unused paths obscure the remaining execution contract, while old stored
claims and uploaded recordings must retain their original meaning.

## Decision

The former Herdr qualification in the [per-tool readiness decision](../architecture/2026-11-17-worker-per-tool-readiness.md) is retired; independent Web provider tool readiness remains.

Native verification and configuration use Web provider arguments only. Active
platform tool selection contains Codex and Copilot in the Web context. The
Worker leaves old Herdr SQLite rows untouched and does not admit them for
execution. Frozen configuration decoders and the historical recording reader
retain the formats needed for existing data; live terminal message types and
their dedicated fixtures are removed.

This completes the native argument closure left by the [daemon removal](2026-11-18-remove-herdr-daemon.md)
and narrows the active model in the [tool resolution decision](../architecture/2026-11-11-worker-tool-path-resolution.md).
The [two-tool protocol](../architecture/2026-11-17-worker-two-tool-protocol.md)
continues to preserve raw unsupported targets.

## Alternatives

**Retain the wider execution model.** This would leave an unsupported mode and
launcher reachable from shared validation, obscuring which arguments are usable.

**Erase old formats with the runtime.** This would lose historical claim and
recording facts that remain readable independently of execution.

## Consequences

Existing Herdr resources remain the user's responsibility. Web, Controller and
Bot continue to use their existing process and tool ownership proofs. Old local
or cloud Herdr configuration requires explicit correction; it is not converted.
