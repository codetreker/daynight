# Agent Note: Automatic Task Session Entry

Status: implemented

## Problem

The Task Session page offered both a current execution and a history selector,
although the history catalogue could contain that same Session. A saved selection
could keep an old execution visible after a new claim started. Readers had to
choose which entry represented the task, and completed tasks could retain a live
control surface while their archive was still being prepared. Tasks whose claim
had been removed could lose the main Session entry despite retaining history.

## Decision

The main entry follows the actual task lifecycle. Active claims retain their
existing Web or Herdr reader. Completed and released claims resolve their original Session
with the corresponding read-only current API and use the fixed archive reader.
A missing current registration remains a recoverable state, never a reason to
substitute another claim's history. With no claim, the latest actual catalogue
entry is read-only history. Only a complete empty observation permits hiding the
Session tab; loading, failure and denial remain separate states.

The registry enforces one Session per project/task/claim across both backends.
Current reads bind that identity even after the Worker is completed or released.
They require the selected Task Session tab and a visible document under the
[current-read visibility decision](../architecture/2026-11-08-task-current-read-visibility.md);
no-claim catalogue discovery remains independently responsible for entry presence. Native
recovery stays within the existing provider and Worker mechanisms; page opening,
refresh and reconnect do not launch or replay anything. Task completion withdraws
write controls independently of archive preparation and verification. A Web
Session still active or draining can have no archive row yet; unavailable
records in that preparation interval continue read-only observation until the
current lifecycle confirms archival, instead of treating the temporary absence
as a final result.

The host removes the execution selector and ignores its former persisted
selection. Cleanup addresses only its user/project/task recording key. Older
records remain independently readable from Attachments. Background checks retain
eligible readers and content; real identity changes and permission loss fence
content and late responses. Web archive reading retains the same Session display
preference, and Herdr retains its own terminal recording reader.

This replaces the entry retained by the [compact selector layout decision](../bug-fix/2026-11-06-session-record-selector-layout.md).
That earlier decision bounded an existing control without changing selection
semantics; its shared-toolbar isolation remains useful for other controls. The
[catalogue cache decision](../architecture/2026-11-05-session-records-cache.md)
continues to own complete-empty proofs, refresh ordering and storage limitations.
The [requirements](../../../../docs/spec/task-sessions.md#执行身份与页面入口)
and [shared entry design](../../../../docs/design/herdr-session-web.md#页面与身份)
own current behavior and mechanisms.

## Alternatives

**Keep the compact selector.** It preserves deliberate selection in the main
Session page, but keeps two entries for an active Session and lets a saved
historical choice override the task's current execution. Attachments already
provides an explicit history entry.

**Always choose the newest history item.** Catalogue ordering is sufficient when
there is no claim, but a newly claimed execution may not yet have registered.
Selecting an older claim would present the wrong conversation as current.

**Use startup metadata as the common identity source.** The Web startup report
contains a Session ID but does not provide the Herdr contract. Both protocols
already provide claim-bound current reads, so a second cross-protocol identity
source would create unnecessary disagreement and fallback rules.

## Consequences

The ordinary Session page presents one execution without persistent selection
controls. Completion requires no reader choice, while incomplete or unavailable
archives remain explicit and recoverable. Older claims remain accessible through
Attachments without merging or deleting their history.

Automatic discovery must preserve authenticated scope, complete-empty evidence
and reader stability. Archive readiness cannot be inferred from Task status, and
history catalogue metadata grants no content or control permission. Provider
launch, recovery, recording formats and archive retention remain with their
existing owners; changing those mechanisms would require separate justification.
