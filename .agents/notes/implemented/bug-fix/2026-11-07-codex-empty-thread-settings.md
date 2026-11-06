# Agent Note: Persist explicit settings before an empty Codex thread becomes ready

Status: implemented

## Problem

Codex can acknowledge an explicit model and effort at thread startup without
persisting those choices for a thread that has never received user input. A
cold resume then keeps the original thread identity but resolves different
settings. Reapplying startup configuration during resume would overwrite later
settings that the user changed inside the native conversation.

## Decision

The shared Codex Provider materializes the empty rollout through its existing
`thread/read(includeTurns: true)` call, then persists only explicitly requested
initial model and effort with one `thread/settings/update`. This ordering is
required by the observed Codex 0.167.0 behavior: an update before the read does
not retain the selection after a cold resume. An empty-thread read may perform
the persistence side effect and still return a native history error. For
explicit initial selections, only code `-32601` with the exact message
`list_turns is not supported yet` is accepted as that compatibility case.
Other read errors stop initialization before updating settings. Calls without
explicit selections retain the prior native-read compatibility behavior.

A same-value update can acknowledge with `{}` without emitting a settings
notification. Initialization therefore accepts a valid object RPC result and
does not use the interactive controls path that waits for a changed-setting
notification. Rejection, malformed results, timeout and disconnect prevent
readiness and close the owned process. No update, input or new thread is
automatically retried. The already observed native identity remains available
to the existing recovery owner.

Omitted fields remain omitted. Resume continues to read the native settings
without injecting frozen initial choices, preserving the authority described
by the [Worker override decision](../architecture/2026-11-06-worker-local-native-overrides.md).
The [shared requirements](../../../../docs/spec/task-sessions.md#启动结果与恢复阻断)
and [protocol design](../../../../docs/design/task-session-protocol.md#codex-初始设置持久化)
own the current contract and mechanism.

## Alternatives

**Reapply frozen choices on every resume.** This repairs an untouched thread by
overwriting subsequent user settings, losing native conversation authority.

**Update immediately after startup.** The empty rollout has not yet been
materialized, so the acknowledged update does not establish cold persistence.

**Use the interactive controls setter.** Same-value initialization need not
produce the notification that this path requires, causing a false timeout.

**Accept every native read error before updating settings.** A denied rollout
write can be followed by a successful `{}` settings receipt, while a cold
resume still fails because the rollout is missing. Broad read compatibility
would therefore falsely confirm durable explicit settings.

**Persist resolved defaults too.** That would freeze values the caller omitted
and turn display fallbacks into user intent.

## Consequences

Explicit fresh choices add one native RPC before readiness. Native versions
that reject the operation fail visibly instead of claiming durable settings.
Fixture tests cover request ordering, omission, unchanged resume and failure
cleanup; native-version evidence is still required to establish actual cold
persistence. The change does not repair historical threads whose original
choices were never persisted, change interactive controls confirmation, or
weaken the existing identity and stop-proof gates for recovery.
