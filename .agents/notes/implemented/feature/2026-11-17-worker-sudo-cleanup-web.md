# Agent Note: Edit the Worker sudo cleanup target in Web

Status: implemented

## Problem

A per-Worker cleanup target needs an understandable control without treating a
saved value as proof that the Worker applied it. Older services may omit the
field, and the platform or application report may be unavailable.

## Decision

The configuration form recognizes the optional `enableSudoCleanup` boolean and
its application result. Linux and macOS targets are editable when the field is
present, including offline and before an application report. Windows and unknown
platforms disable the control. An absent field remains absent in a submission.
The existing source baseline preserves other unknown data and checks the complete
receipt. A disabled draft is retained while other edits save against its baseline.

The [Web specification](../../../../docs/spec/daynight-web.md#云端运行配置) owns
the interaction. This extends the [service target decision](2026-11-17-worker-sudo-cleanup-target.md)
and the [Web source preservation decision](../architecture/2026-11-17-web-worker-configuration-source.md).

## Alternatives

**Require a Worker capability report.** A missing application item would prevent
an offline or older Worker from receiving a target even though the service has
already exposed the field. Application evidence remains separate from editing.

**Default an omitted field to false in the request.** An older service does not
provide that field, so manufacturing it would change the submitted configuration.

## Consequences

Users can save a target before the Worker reports it, while pending feedback
makes the lack of application evidence visible. Platform discovery is required to
edit this setting; other configuration remains editable without it.
