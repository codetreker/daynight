# Agent Note: Bot CLI identity and remote Worker observations

Status: implemented

## Problem

A Bot belongs to an account rather than a Project, while the existing Worker
commands mostly manage local execution. Users and assistants need public CLI
access without making the current directory a Project or confusing a remote
observation with local runtime ownership. A lost write response must retain the
identity needed to inspect its outcome; a successful HTTP response alone cannot
prove startup or deletion completion.

## Decision

Bot management uses the existing owner-scoped HTTP resources. The command
creates its business UUID before dispatch: the Bot ID for creation and the
deletion ID for deletion. Explicit overrides remain explicit, and the service
resolves omitted settings. Deletion requires the caller's observed version.
Bot int64 values retain their decimal-string representation through parsing,
request construction and JSON output.

Unknown writes retain the original business identity and an explicit show
command. No automatic POST/DELETE retry or replacement identity is introduced.
HTTP correlation IDs remain separate from business IDs. Public diagnostics
project the operation, identities, phase, status and error code without exposing
raw transport causes, credentials or server error bodies. Valid refusals and
unconfirmed outcomes remain distinguishable.

Lists follow all pages before emitting output and reject repeated cursors or
resource identities. A later-page failure cannot look like a complete empty or
partial result. Remote Worker list/show bypass local execution state and locks;
server observation times and inventory availability remain visible. Missing
inventory is unknown, and an online report does not promise idle capacity or a
working Provider.

The [requirements](../../../../docs/spec/assistant.md) and
[design](../../../../docs/design/assistant.md) own command behavior and mechanism.
The [Bot definition decision](2026-11-04-bot-definition-storage.md) continues to
own persistent identity and deletion responsibility; the
[Worker snapshot decision](2026-10-28-worker-runtime-snapshots.md) owns remote
observation storage and visibility. This decision adds their CLI consumers.

## Alternatives

**Resolve defaults in the CLI before creating the Bot.** This would make a
client observation part of the submitted configuration and duplicate the
service's default-selection rules. Sending only explicit choices preserves the
creation fingerprint and lets the service freeze defaults once.

**Retry a lost write response automatically.** A stable ID can support an
explicit same-request replay, but it does not justify silently retrying an
uncertain operation or substituting a newer version. Preserving the ID and
requiring observation keeps conflict and unknown-outcome handling visible.

**Stream each list page to output.** This reduces buffering, but a failure after
the first page leaves a plausible incomplete inventory. Buffering until complete
pagination gives callers one complete result or a failure within the existing
operation budget.

## Consequences

The CLI works outside repositories and exposes the same account permissions as
the management API. JSON consumers retain exact versions and observation times;
users can distinguish accepted definitions, startup states and deletion stages.
The command owns bounded pagination and parsing overhead, and diagnostics expose
less arbitrary server text while retaining actionable identity and error codes.

Complete native hosting, UI entry enablement and bound-Session cleanup remain
separate capabilities. The CLI preserves the service's current refusal of
bound-Bot deletion, and pending intents may remain pending until cleanup
consumers are available. Later cleanup producers must keep the same deletion
identity and two-party completion semantics; command availability cannot be
used as evidence that those producers or the whole assistant experience work.
