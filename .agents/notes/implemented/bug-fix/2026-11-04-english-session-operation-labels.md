# Agent Note: English Session Operation Labels

Status: implemented

## Problem

Translating familiar Session operation and activity labels changes the terms
users recognize while controlling an agent. A Chinese interface still needs
localized explanations and errors, so changing the whole Session to English
would remove useful localization beyond those controls.

## Decision

The normal native Session header and composer activity labels, permission trigger, primary
send button, interrupt button, and built-in Command/File changes tool labels
use the existing English catalog values in both supported locales. Each marked
operation position keeps English for its alternate states as well. Startup,
connection and recovery diagnostics follow the localized
[startup presentation decision](2026-11-05-session-startup-presentation.md), which
partially supersedes the original blanket header rule. Fixed English text
has a local language annotation rather than changing the language of the whole
Session.

These are explicitly selected product labels, not provider-supplied strings or
a fallback for missing translations. Components read an English subset only at
the specified positions. Shared localized messages remain available for
operation receipts, interaction cards, archive explanations and settings
panels, including messages whose English values also appear in a fixed label.

The [Session requirements](../../../../docs/spec/task-sessions.md#chatbox-设置命令与运行状态)
own the exact positions. This is a scoped exception to the
[bilingual interface decision](../feature/2026-10-22-web-bilingual-interface.md);
locale selection, persistence and state ownership keep that decision's behavior.

## Alternatives

**Translate every Session label.** This preserves uniform language selection
but changes the familiar operation vocabulary that users rely on.

**Use the English catalog for the whole Session.** This also changes errors,
instructions and settings explanations that should remain readable in the
selected language. Some shared keys serve both a fixed label and localized
content, so changing their Chinese catalog values has the same problem.

## Consequences

Chinese Sessions intentionally combine English operation labels with Chinese
explanations. Locale changes preserve those labels without changing drafts,
capability gates, permission confirmation, operation identity or recovery.
New native activity and operation states at the specified positions keep this language behavior;
unrelated labels do not become English implicitly. Component checks cover
both the fixed terms and adjacent localized content.
