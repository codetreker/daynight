# Agent Note: Discard settled Worker recordings when archival is disabled

Status: implemented

## Problem

Operators need to stop retaining completed Session recordings on a Worker while
preserving active Sessions, confirmed cloud archives, and the original stop and
worktree settlement guarantees. A configuration target alone does not establish
the value actually applied by a Worker.

## Decision

The Worker uses the applied `archiveSessions` value at terminal cleanup and
historical maintenance. An unknown value does not select deletion or start an
upload. A false value selects local recording deletion; an existing selection
survives later configuration changes. Web persists the choice in its terminal
cleanup record and serializes source readers, repair, upload and removal under
the original execution's source lock. Deletion follows the original stop,
worktree and local settlement. Previously ready cloud content and receipts remain
unchanged. The [Worker design](../../../../docs/design/daynight-worker.md) owns
the mechanisms and recovery boundaries. Herdr recording execution has since been
removed; existing Herdr resources remain the user's responsibility.

This extends the [negotiated configuration decision](../architecture/2026-11-17-worker-archive-configuration.md)
and the [independent Herdr cleanup decision](../bug-fix/2026-11-16-herdr-cleanup-independent-of-archive.md).

## Alternatives

**Add a new archive lifecycle protocol.** New remote states and policy epochs
would require coordinated deployments and add state without helping local
cleanup once the original stop and settlement are already established.

**Delete immediately on configuration change.** Active Sessions and already
admitted readers could still hold the source. A durable per-record choice and
the existing stop and serialization boundaries preserve those operations.

## Consequences

Selected local recordings cannot be uploaded later, even after re-enabling the
setting. Interrupted deletion resumes from its durable decision; filesystem
errors remain diagnosable and retry independently of remote inventory. The
Worker retains execution definitions, launch tickets and shared native state.
