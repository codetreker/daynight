# Agent Note: Session Slash Submission Classification

Status: implemented

## Problem

Pasting an absolute path followed by an explanation into a Session chatbox was
blocked as an unknown command. Both the composer and client rejected slash-led
messages, while the command menu treated its default prefix highlight as a user
selection. A selected parameterized command also lost its identity when its
catalog changed, making plain text alone insufficient to preserve the user's
operation choice.

## Decision

Submission and button gating share full-name classification against the current
command catalog and the reserved local model/permissions entries. Zero matches
use ordinary message submission and its send/steer gate; ambiguous or unavailable
commands retain errors. The client accepts slash-led text through its existing
message path without changing ownership, execution, capability or pending gates.
Only existing outer whitespace trimming applies.

Default menu highlighting remains presentation. Tab, click or explicit arrow
selection establishes a candidate choice; direct Enter on an unmatched prefix
sends the text. Temporary selection resets with input, catalog and menu lifetime. Catalog
comparison uses descriptor values and revision, so reconstructed equivalent
snapshots do not change an explicitly selected operation.
A chosen parameterized command separately retains its ID and command head.
Argument edits and menu dismissal preserve that intent; submission validates the
same ID against the current catalog revision. Removal, same-name replacement,
unavailability and ambiguity cannot convert the operation into a message.
Changing the head, clearing the draft or switching Session clears the intent.

This partially supersedes the original
[native controls decision](../../archived/feature/2026-10-28-chatbox-native-controls.md):
explicit commands still require native methods and receipts, while unknown slash
text is ordinary input. The [command menu decision](../../archived/bug-fix/2026-11-04-session-command-menu.md)
records the rationale for the existing layout, dismissal and focus rules. The
[requirements](../../../../docs/spec/task-sessions.md#chatbox-设置命令与运行状态)
and [design](../../../../docs/design/task-session-protocol.md) own the full contract.

## Alternatives

**Remove only the unknown-command UI error.** The client would still reject the
message, and prefix Enter would still select an unintended command. Classification
must govern both submission and button availability, with the client allowing
the resulting ordinary text operation.

**Reclassify selected commands from text after every catalog change.** This loses
the explicit operation identity and could send a removed command as a prompt or
execute a replacement with the same name. Retaining ID and head preserves the
choice without freezing a stale controls revision.

## Consequences

Paths, unknown slash text and multiline content use the same draft and receipt
rules as ordinary messages. Failed or unknown command dispatch never falls back
to message dispatch, and only the accepted draft revision is cleared. Regression
tests cover both shared Composer behavior and Task/Test client operation payloads;
controlled browser transport can prove Web classification but cannot establish
how each Provider SDK interprets native text. Provider protocols, discovery and
the chatbox layout remain separately owned.
