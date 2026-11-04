# Agent Note: Codex Native Role Instructions

Status: implemented

## Problem

Controller tickets can carry frozen role text, but a Codex session cannot use
that text unless its native start and resume requests configure it. Sending the
role as initial user input would create a turn before the first real request
and give role configuration the wrong message semantics.

## Decision

The Codex adapter conditionally maps `instructions` to `developerInstructions`
in its shared thread start/resume request. It preserves the exact text and
omits the field when absent. It does not set `baseInstructions`, send a turn,
change native settings or alter the shell environment mapping. Native rejection
uses the existing startup close-and-rethrow path without retrying without a role.
The [role specification](../../../../docs/spec/controller-role-instructions.md)
and [protocol design](../../../../docs/design/task-session-protocol.md#codex-原生角色映射)
own the behavior and mechanism; the
[shared role decision](../architecture/2026-11-04-controller-role-instructions.md)
owns ticket validation and frozen-text responsibility.

This mapping follows the fixed
[ARC start implementation](https://github.com/xuangong/agent-remote-control/blob/a617fa8efc96dca2e0fdd13953f647e64816aa13/packages/agent-provider-codex/src/session.ts#L490)
and [resume implementation](https://github.com/xuangong/agent-remote-control/blob/a617fa8efc96dca2e0fdd13953f647e64816aa13/packages/agent-provider-codex/src/session.ts#L655).
Codex's separate developer field preserves base instructions, but overrides an
existing developer configuration; it is not a concatenation API. This distinction
is visible in the
[Codex configuration precedence](https://github.com/openai/codex/blob/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f/codex-rs/core/src/config/mod.rs#L3914).

## Alternatives

**Use initial user input for the role.** This would add a user turn and couple
configuration to message delivery and replay. The accepted role contract keeps
configuration separate from user requests.

**Replace the native base prompt.** The role supplements Codex's native behavior;
replacing base instructions would discard that behavior instead of selecting the
supported developer instruction layer.

## Consequences

Fresh and resumed Codex sessions receive the same producer-frozen text without
an extra turn. Native PATH, CLI aliases, model/effort and permissions keep their
existing selection rules. A native role rejection fails startup and closes its
owned transport rather than silently losing the role.

Controlled stdio tests cover request bytes, absent fields, settings and input
boundaries, error propagation and child/stream closure. They do not prove a real
Codex installation accepts the field or follows the role. Real provider
acceptance and complete Bot integration remain separate delivery responsibilities.
