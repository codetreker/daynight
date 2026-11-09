# Agent Note: Claude Native Role Append

Status: implemented

## Problem

Controller startup carries role instructions separately from user input, but the
Claude adapter needs to apply them without removing Claude Code's base guidance
or changing recovered native identity and permissions. A preparation user turn
would misrepresent a role as an actual user request.

## Decision

The adapter maps present instructions to the SDK's `claude_code` system-prompt
preset with `append`, using the same query-options path for creation and resume.
Absent instructions leave `systemPrompt` absent. The SDK's preset retains native
base guidance, and the role text remains unchanged. This consumes the
[shared role contract](2026-11-04-controller-role-instructions.md); the producer
continues to own frozen role selection across generations.

The mapping leaves input streaming, native identity checks, settings selection,
approval callbacks and shutdown ownership on their existing paths. Requirements
live in the [role specification](../../../../docs/spec/controller-role-instructions.md#claude-原生追加)
and mechanisms in the [session design](../../../../docs/design/task-session-protocol.md#claude-角色追加).

## Alternatives

**Replace the full system prompt with a string.** The SDK permits this, but it
would discard the native base prompt instead of adding a role to it.

**Send the role as initial user input.** This would create an artificial request
and turn, conflating configuration with user intent and complicating recovery.

## Consequences

Fresh and resumed Claude queries receive the same caller-supplied role without
additional input. Existing sessions without instructions retain their options.
Role presence does not enable unattended permission bypass or override restored
model, effort or sandbox state. The adapter does not validate frozen equality
across generations or enable Bot hosting by itself.

Provider fixtures cover mapping, absent fields, input separation, native
identity and settings, approvals, initialization failures, stream loss and
close. Such fixtures establish the adapter boundary, not live model compliance
or complete Bot acceptance.
