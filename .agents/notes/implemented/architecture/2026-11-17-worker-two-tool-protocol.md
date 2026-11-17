# Agent Note: Worker two-tool protocol

Status: implemented

## Problem

Worker configuration, reports and details included a control mode and Herdr
choices after new execution had become Web-only. Strict consumers must agree on
one contract, while old saved targets and their archive and sudo facts must not
be silently rewritten during a read or report.

## Decision

Report, configuration and detail require `Daynight-Worker-Tool-Paths: 2` and
exchange Codex and Copilot in the Web context. Configuration protocols 1 and 2
and the archive capability retain their separate responsibilities. List, Task
and historical reads do not gain this gate. Old raw targets remain visible and
unsupported; an explicit complete replacement removes old mode and tool fields.
The archive column is projected independently and sudo retains its existing
semantics. The service no longer adopts, validates or writes mode configuration
or observations. Its historical observation decoder restores mode before the
archive slot to preserve the original item positions; public projections omit
the mode item. The Worker does not report a mode bootstrap or observation.

This partially supersedes the [negotiated configuration decision](2026-11-11-worker-tool-path-configuration.md)
and the [Web editing decision](../feature/2026-11-12-worker-tool-path-web.md).
It also replaces the configuration behavior in the [cloud mode decision](2026-11-10-worker-cloud-control-mode.md).

## Alternatives

**Keep the three-tool projection and mode capability.** This would retain a
public contract for execution choices the Worker no longer supports and require
all consumers to keep interpreting those fields.

**Convert old targets during reads or reports.** This would change user intent
without a versioned explicit replacement and could erase information needed to
inspect or correct the saved target.

## Consequences

Old clients must upgrade or refresh for report, configuration and detail. Users
can inspect old targets and explicitly save a corrected candidate. The existing
archive and sudo facts remain independent of the protocol transition; saved
choices still do not prove actual tool application.

The schema 10 reader accepts the new raw target using the current protocol
parser while retaining historical decoders and the existing storage envelope.
This direct reader is necessary for persisted current targets to survive a
restart; it does not migrate stored targets or change checkpoint format. Old
Herdr execution and resources remain outside this protocol change and require
separate cleanup. No synthetic mode or tool choice is persisted to bridge them.
