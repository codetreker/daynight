# Agent Note: Silent Session Operations

Status: implemented

## Problem

Ordinary Session sends inserted relay, controller and provider progress above
the composer. Slow acceptance and background reconciliation also exposed
internal work and shifted the conversation without a problem requiring action.
Hiding those rows must not conceal genuinely uncertain outcomes or weaken
admission, draft ownership and recovery guarantees.

## Decision

Render operation receipts only for actual errors, failed, rejected or expired
operations and genuine uncertainty. Current-page sending and waiting evidence
remains separate from the protocol ledger; normal submission, acceptance,
reconciliation and confirmation have no receipt row or empty container.
Settings retain their confirmed value until confirmation and use their existing
admission gate. Agent activity and native questions remain independent.

This partially supersedes the [delivery progress decision](2026-11-06-session-delivery-progress.md):
its page-local observation and deadlines remain, while its normal progress and
ten-second query display are removed. It also extends the [original success
filter](../../archived/bug-fix/2026-11-03-quiet-session-receipts.md), which kept
pending receipts visible to preserve recoverability before continuous local
observation was distinguished from restored uncertainty.

The [Session requirements](../../../../docs/spec/task-sessions.md#基础会话交互)
and [design](../../../../docs/design/task-session-protocol.md#session-view-的阅读与输入状态)
own the current behavior and mechanism.

## Alternatives

**Hide every unresolved operation.** This would also hide operations restored
without evidence and genuine transmission failures, leaving the send gate
closed without a recoverable explanation.

**Keep a delayed progress row.** The earlier ten-second threshold made slow
acceptance inspectable, but normal background work would still insert rows and
move the reading area. Existing automatic reconciliation does not need that UI.

## Consequences

Successful operations and background checks leave the receipt area absent.
Unknown results retain the original-operation query without replay; concrete
errors remain visible and wrap within narrow layouts. A recovered operation
cannot erase another unresolved operation's error. The thirty-second deadline,
operation IDs, persistence, protocol, admission and draft revision rules remain
unchanged. This is a shared presentation change and provides no new provider
recovery or diagnostic protocol.
