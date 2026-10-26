# Agent Note: Foreground Review CLI

Status: implemented

## Problem

A local PR reviewer must keep polling while agents run, retain each PR's context,
and distinguish a completed review from an interrupted one. These needs require
persistent state and execution ordering, but do not inherently require a service
installation or independent execution infrastructure.

## Decision

The repository records the [requirements](../../../../docs/spec/daynight-review.md) and
[design](../../../../docs/design/daynight-review.md) for the foreground
`daynight review run` command in `packages/daynight/`. This note records the
selected execution model. The
[client composition decision](2026-10-20-client-command-composition.md) partially
supersedes the original package-wide review framing: review remains a single
foreground workflow within a client that composes command modules. The
CLI/configuration foundation and
[durable state module](2026-10-17-durable-review-state.md) are implemented;
the [GitHub observation module](2026-10-17-github-observation.md) reads complete
repository passes. The [Git manager](2026-10-17-owned-review-worktrees.md) owns
clones and disposable PR worktrees. The [Copilot adapter](2026-10-17-copilot-session-execution.md)
executes retained sessions. The [foreground coordinator](2026-10-17-foreground-review-coordination.md)
connects these modules to continuous review operation. Review configuration, entry point,
and
runtime storage follow the [user-home configuration decision](2026-10-16-user-home-review-configuration.md).
The [local status listing](../feature/2026-10-18-review-status-listing.md) inspects
persisted progress without entering this execution workflow or taking its lock.

Polling, pending work, SQLite updates, worktree management, and direct Copilot
child invocation belong to that single process. Each PR retains a session UUID
and worktree. Captured review revisions are separate from latest desired state,
so an old completion cannot discard a later trigger. Agents publish their own
GitHub outcomes and report execution completion through one exact final text line.
The [conversation-cycle decision](2026-10-21-review-conversation-cycle.md) partially
supersedes the original marker-only confirmation and head-only follow-up: the
coordinator verifies actual publication, and resolved comment feedback can wake
one later round without a commit. Agent-owned publishing and this foreground
execution model remain unchanged.

The CLI supports Linux, macOS, and Windows using ordinary command execution and
platform termination behavior. Agents obey a foreground-tools contract; runtime
cancels current managed execution on shutdown. Abnormal termination
retains unfinished state and requires previous processes to have ended before
retry; no transparent recovery of a live child is promised.

## Alternatives

**Detached runner with IPC and platform helpers.** This can preserve agent
execution across coordinator crashes, but adds admission, independent ownership,
receipts, and native packaging. Those components solve a stronger process
lifecycle problem than the selected foreground CLI needs. Ambiguous abnormal
exits instead remain visible for operator recovery.

**Wait for every review inside the polling loop.** This reduces scheduling code,
but delays discovery and closure detection for the duration of each review. The
same Node.js process can poll and await children asynchronously.

**Parse model findings and publish from the CLI.** This introduces a findings
schema and publisher contrary to the agent-owned publication requirement. The
original plain-text marker trusted the agent's assertion and left GitHub
reconciliation to that same agent session. The conversation cycle adds read-only
publication verification without moving findings or publishing into the CLI.

## Consequences

One command starts and owns the workflow, with SQLite preserving cutoff,
revisions, sessions, and retries. The execution model needs no separate runner,
IPC service, or native process helper. Cross-platform subprocess behavior still
requires real platform tests.

Abnormal exits can leave child execution uncertain and require operator
attention. GitHub publication is not atomic with local state, so confirmation
checks prior publication before retrying. The marker does not independently
prove remote effects or transactional exactly-once delivery. Session files live
outside disposable worktrees and must remain available for continuity.
