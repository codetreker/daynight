# Agent Note: Copilot Session Execution

Status: implemented

## Problem

A review can publish to GitHub before the local process records completion.
Retries must retain the same conversation and reconcile earlier effects. Agent
output is free text, and local process closure alone does not establish either
remote publication or descendant-process exclusion.

## Decision

The Copilot adapter extends the
[foreground execution model](2026-10-16-foreground-review-cli.md). It launches
sequential skill-discovery and review children in the prepared PR worktree and leaves scheduling, process
exclusion and final review transitions to the coordinator. The existing
[store](2026-10-17-durable-review-state.md) persists the per-PR UUID and launch
intent before spawning; no additional execution database or process layer is
introduced.

The [bundled-skill decision](2026-10-20-bundled-review-skill.md) extends each
attempt with native discovery of an immutable package-owned skill snapshot.
Both child phases share one budget and timeout deadline. Discovery must resolve
the enabled named skill to the current snapshot; its prompt explicitly invokes
that entrypoint even on resume. The discovery execution must be excluded before
its exact PID and identity can be cleared and the review child launched. A failed
exclusion retains uncertainty and cannot advance to review.

First invocation selects the persisted UUID. Existing opaque session history
selects explicit full-UUID resume, including after an interrupted first launch.
Missing history for an established session is an error. The adapter checks only
the session directory; it does not parse Copilot history or JSONL.

The prompt is sent through stdin in Copilot's documented noninteractive mode.
`cross-spawn` handles installed executable and Windows command-shim resolution
with separate arguments and `shell: false`. Prompt text stays out of the command
line. Copilot home, cache, diagnostics and temporary files use runtime paths;
existing home, GitHub CLI configuration and authentication environment remain
available. Copilot's documented authenticated-`gh` fallback avoids copying
credentials into application state or prompts. The
[model options decision](../../implemented/feature/2026-10-22-review-copilot-model.md) extends
only the formal review child with independent optional model and reasoning-effort
arguments from startup configuration, including when resuming or retrying. Skill discovery,
session ownership and process supervision retain their existing behavior.

The adapter reuses the Git manager's environment isolation before applying the
[prepared raw/full-checkout settings](2026-10-17-owned-review-worktrees.md).
Captured PR/review identity, head, base, merge base and prior unfinished review
identity travel in the prompt. The agent reads current PR metadata and linked
scope requirements, checks the complete captured diff, and rechecks metadata and
eligibility before publishing or confirming prior publication. It binds reviews
to the captured commit and reconciles existing effects before retry. The
[PR-quality decision](../process/2026-10-21-review-pr-quality-gates.md) partially
supersedes the original approval rule: description and scope gates must pass in
addition to there being no Critical/Major code issues. Blockers use `COMMENT`,
with actual native review threads; PR-level reasons use clearly labeled file-level
threads and suitable findings remain inline. Passing reviews use `APPROVE`. The
[conversation-cycle decision](2026-10-21-review-conversation-cycle.md) partially
supersedes marker-only completion and head-only follow-up facts: stable-identity
remote results are verified, comments arm one follow-up after resolution, and
existing approvals are preserved during confirmation. Agent-owned publication
and process execution remain here.

Each attempt has a unique log directory with separate stdout and stderr logs
for discovery and review. Discovery JSON has its own bounded complete capture;
only review output participates in the completion protocol.
A rejected launch intent cannot occupy the next attempt's paths. Full logs stream
to disk; the final stdout line uses at most 8,192 UTF-16 code units in memory. Only a normal zero exit, complete output capture and an exact final
nonempty stdout line `PR N Review Completed` produce an execution completion assertion. The coordinator persists that assertion
after process exclusion and verifies the remote publication before recording
round completion.
Timeout, cancellation, malformed output and logging failure remain incomplete.
The result reports direct-child evidence and explicit command-not-found launch
failure; the coordinator supplies process exclusion before retry or worktree
mutation. A Windows command wrapper can have a PID even when the requested
executable never starts. Only an exact structured spawn-ENOENT error identifies
that failed launch, and its wrapper must still close. Other capture failures
remain distinct from this launch evidence. See the
[pinned command-not-found hook](https://github.com/moxystudio/node-cross-spawn/blob/77cd97f3ca7b62c904a63a698fc4a79bf41977d0/lib/enoent.js#L6).

Primary references are the
[programmatic guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically),
[session storage reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference),
[authentication guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli#authenticating-with-github-cli)
and [cross-spawn implementation](https://github.com/moxystudio/node-cross-spawn/blob/77cd97f3ca7b62c904a63a698fc4a79bf41977d0/lib/parse.js).

## Alternatives

**Pass the full prompt with `-p`.** This is supported, but prompt size and shell
metacharacters then travel through Windows command-shim parsing. Supported stdin
input removes those constraints without a custom launcher or binary resolver.

**Select the most recent global session.** Concurrent PRs would share or select
the wrong conversation. Persisted UUIDs make session choice independent of
launch order.

**Parse findings and publish from the adapter.** This would add an output schema
and a second publisher. The selected protocol gives the agent both publication
and retry reconciliation responsibility.

## Consequences

Controlled executables verify invocation, durable intent, skill selection,
sequential process exclusion, session selection, prompt delivery, stream handling
and incomplete outcomes without live reviews.
Actual Copilot/GitHub acceptance remains a separate delivery check. Research
verified the relevant options against local Copilot CLI 1.0.98; this is observed
version evidence, not an inferred minimum-version guarantee.

The completion marker remains an agent assertion. The conversation cycle requires
matching remote approval or actual review/thread evidence before local completion,
with read-only confirmation retries across restart. GitHub publication and SQLite
updates are not one transaction, and a closed CLI wrapper does not prove that
all descendants have stopped. The [foreground coordination decision](2026-10-17-foreground-review-coordination.md)
defines the supported foreground-tools contract, current-tree cancellation and
operator recovery for ambiguous execution.
