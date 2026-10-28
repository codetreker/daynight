# Agent Note: Session Reading and Draft Ownership

Status: implemented

## Problem

Native tool logs lose literal characters and whitespace when rendered as Markdown. Layout changes and a touch without scrolling can interrupt reading. A component-local draft disappears on navigation, and a delayed input acknowledgement can erase newer edits or move focus away from an approval.

## Decision

Claude displays locally dispatched user text under the same stable identity as a later native echo or history row. The SDK does not always echo live input. Displaying that row never supplies native identity, acknowledgement, or recovery evidence; receipts remain authoritative for unknown outcomes.

The shared Task/Test Session View separates raw tool output from safe message Markdown. It preserves message line breaks, namespaces generated footnotes, and exposes bounded tool regions and tables to keyboard navigation. Copilot result projection removes identical native summary/detail fields while retaining distinct output and errors; native success remains authoritative.

Reading state follows user intent. A visible text anchor preserves the reading line across width changes, with a stable entry fallback. Touch starts alone do not pause following. Keyboard reading and internal footnote navigation can pause it.

The Session client owns tab-local drafts, partitioned by principal, session scope, and full execution fence. A submission associates the exact operation and draft revision. Acknowledgements cannot erase subsequent edits, and unknown outcomes never cause replay. Logout, identity changes, execution changes, and denied reentry clear the corresponding drafts. Storage failure leaves memory editing available.

The [design](../../../../docs/design/task-session-protocol.md#session-view-的阅读与输入状态) owns the mechanisms and the [requirements](../../../../docs/spec/task-sessions.md#基础会话交互) own their observable guarantees.

## Alternatives

**Render all text as Markdown.** This reused a renderer but reinterpreted shell output and obscured error evidence. Only authored messages and reasoning retain Markdown semantics.

**Keep drafts only in the component.** This avoided persistence but lost unsent work on refresh and view changes. Tab-local storage limits sharing while preserving that work.

**Clear the current draft on any successful send.** This could erase edits made while an earlier operation was pending. Operation identity and draft revision are both required.

**Restore only the top of an entry.** This kept entry identity but moved the visible line within a long message after reflow. Text anchors improve continuity without replacing the existing entry fallback.

## Consequences

Drafts remain local plaintext protected by the browser origin, not end-to-end encrypted storage. An inactive page does not maintain a global revocation watcher; denied reentry clears its scope. Browser storage failures reduce persistence, not editability. Text anchors depend on rendered text and fall back when content changes. Native provider capabilities and success semantics remain distinct; rendering cannot infer a shell failure from arbitrary output or manufacture steer support.
