# Agent Note: Unified Session Chatbox

Status: implemented

## Problem

A border around only the textarea makes the model and permission controls,
activity status, and send and interrupt actions appear separate from the input
they control. The extra visual separation also consumes conversation space.

## Decision

A shared composer surface encloses the input, controls, activity and actions.
The keyboard hint belongs to the send action and appears on hover or keyboard
focus without reserving a row. The input occupies the upper area without its own
border. The original grouping placed interruption with activity and allowed
flex wrapping to fit narrow containers. The
[responsive footer decision](2026-11-06-responsive-session-footer.md) replaces
that layout with settings, status, and a joint Interrupt/submission group while
retaining the common surface and DOM order. Focus remains visible both for the
input surface and for individual keyboard controls.

The form retains submission and keyboard ownership, and errors remain visible.
The grouping decision preserved settings and command panel lifecycles without
moving state ownership or changing provider capability gates, draft recovery or
operation confirmation. The
[command menu decision](2026-11-04-session-command-menu.md) owns the menu's
container sizing and dismissal behavior, including IME Escape handling. The
[Session requirements](../../../../docs/spec/task-sessions.md#chatbox-设置命令与运行状态)
own the presentation contract; the
[native controls decision](../feature/2026-10-28-chatbox-native-controls.md)
continues to own provider interaction semantics.

## Alternatives

**Keep separate input and control regions.** This preserves the old markup but
leaves status and actions visually detached from the message composer.

**Import the reference composer's complete implementation.** Its resource,
window and runtime ownership differ from Daynight. Adopting its visual grouping
through the existing components avoids changing those unrelated contracts.

## Consequences

One border expresses the complete chatbox while each control keeps its existing
role and accessible name. Long labels, pending actions and narrow containers
must remain readable within that border. Layout checks need real browser
geometry and focus evidence in addition to operation regression tests.
