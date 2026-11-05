# Agent Note: Session Display Classification

Status: implemented

## Problem

A conversation-focused view must retain messages, plans, interactions and real
errors without rewriting session history. Persisted subagent activity can carry
the error kind, so classification by kind alone would expose normal delegation
as an error even when ordinary tools are hidden. Display consumers need one
classification contract independent of rendering and session operations.

## Decision

The pure display module exports Standard and Conversation modes, a Conversation
default constant and an ordered selector of existing entry references. It
classifies every timeline kind explicitly and matches plan tools by the exact
last dot-separated name segment. Messages retain all parts; interaction state
and tool success do not change their classification. The full contract belongs
to the [Session design](../../../../docs/design/task-session-protocol.md).

The renderer and selector share the existing strict legacy activity recognizer.
It delegates to the native parser after checking the exact error code and
diagnostic prefix. Invalid payloads remain errors. This preserves the
[subagent projection decision](../bug-fix/2026-11-03-codex-subagent-activity.md)
without strengthening its required native fields or inferring missing state.

## Alternatives

**Recognize legacy activity independently in each consumer.** Duplicating the
parser would let rendering and filtering disagree about malformed errors or
new native activity kinds. Sharing the existing recognizer preserves one
interpretation without changing persisted data.

**Enable Conversation at the existing timeline entry point immediately.**
During classification delivery, users would have lost visible history before a
mode control and appropriate reading position handling existed. The selector
therefore shipped without changing ordinary entry points. The later
[shared view integration](2026-11-04-session-display-integration.md) supplies the
control, preferences and explicit mode before enabling Conversation by default.

## Consequences

Filtering neither reads resources nor invokes providers and leaves original
entries, revisions and ordering available to future pagination and scroll
consumers. The selector has no React, client or preference dependency. Adding a
timeline kind requires an explicit classification because the predicate has an
exhaustive switch and a boolean return type.

The timeline consumes this selector for explicit modes, including filtered
pagination and mode-switch scroll recovery as described by the
[display reading decision](2026-11-04-session-display-reading.md). That consumer
retains complete source order separately from visible entries. The independent
[preference module](2026-11-04-session-display-preferences.md) provides persisted
choices to the shared Session View, which explicitly supplies the selected mode
and defaults to Conversation. Preference and menu integration remain outside
this classification module; the selector owns neither session state nor resource
loading. Omitted-mode timeline callers retain Standard compatibility.
