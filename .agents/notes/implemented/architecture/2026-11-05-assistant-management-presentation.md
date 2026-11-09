# Agent Note: Conversation-first assistant management

Status: implemented

## Problem

Assistant management competes with the conversation for usable space. A wide
inventory, repeated headers and environment diagnostics reduce the area for
reading and input. Details can also consume too much space when global navigation
is expanded, even on a wide window. Moving those controls must preserve the
selected Bot's identity, uncertain operations and the existing Session.

## Decision

The [management design](../../../../docs/design/bot-management-web.md) owns the
current composition. The assistant route fills its existing application workspace.
A 256px list and the conversation share a stable container; below 676px of
available width, CSS shows the list or the selected conversation. The list keeps
search, creation, refresh and essential status, with full environment information
in details. List and conversation scrolling stay bounded by the Session shell.

The original presentation used an inline form with collapsed advanced settings
to keep a name-first operation within the workspace. Its consumption of list
height, particularly with directory and model controls, led to the
[compact creation dialog](2026-11-07-assistant-creation-dialog.md), which supersedes
that placement. Explicit choices remain separate from displayed defaults, and
closing or navigating away cannot turn an unknown creation into a new POST: the
account scope keeps the original ID for observation. The
[management identity decision](2026-11-05-bot-management-web.md) continues to own
default resolution, complete list reads and unknown-result retention. The
[background-check decision](../bug-fix/2026-11-05-bot-background-check-display.md)
continues to separate retained presentation from request admission, and the
[deletion decision](2026-11-05-bot-browser-deletion.md) owns its independent barrier.

The Bot host composes controls supplied by the original Session header and adds
details and navigation. The shared view retains errors, approvals, receipts and
input control. The title uses one-line ellipsis, with the full name available in
details; status and error text can wrap. Details subscribes to the current cached
Session for connection, startup, recovery and confirmed settings, without another
client or a separate copy of selected state.

Nonmodal details requires both a window of at least 1280px and a stable shared
content width of at least 760px. Its 340px sidebar leaves at least 420px for the
conversation. Measuring the parent shared by both regions prevents the open panel
from changing its own eligibility. Otherwise the same dialog becomes modal.
The original conversation ancestor still owns fullscreen; the Session subtree
does not move. Native modality, local keyboard handling and the nested deletion
confirmation each retain their own focus and scroll-lock responsibility. Reading
restoration uses the existing Timeline bookmark handle.

This presentation replaces the layout choices recorded in the
[narrow-heading decision](../bug-fix/2026-11-05-bot-narrow-heading.md) and the
presentation portions of the
[details decision](../feature/2026-11-05-bot-details-panel.md). Those decisions
originally kept full heading content readable and solved competing fullscreen
and drawer focus ownership. Their 420px heading rule, name-button trigger and
1000px drawer threshold describe that earlier composition; current geometry and
controls are owned here and in the management design. Their identity and stable
fullscreen-boundary rationale still applies.

## Alternatives

**Retain the full management heading and separate Session toolbar.** This keeps
configuration visible but spends persistent conversation space on duplicate
identity and controls. A compact list and on-demand details preserve access to
that information while giving reading and input priority.

**Retain modal creation.** At the time of this decision, a modal interrupted
workspace interaction for a name-first operation, while an inline form kept the
then-limited advanced configuration reachable. That trade-off favored inline
placement without changing server resolution. Its unresolved request still had
to outlive the form, just as it did with modal creation. The later creation-dialog
decision preserves this identity rule while reconsidering space and configuration
requirements.

**Use only window width to select the details mode.** This ignores space used by
navigation and the assistant list. Measuring the remaining conversation after
opening details instead would feed the panel's own width back into the decision
and could oscillate between modes. The stable shared parent supplies the required
space independently of whether details is open.

**Move or duplicate the Session to simplify the layout.** This would risk
replacing clients, drafts and reading ownership. Optional header composition and
a stable ancestor boundary permit the layout without changing those identities.

## Consequences

Normal reading has less persistent management UI. Full names and configuration
now require opening details, while errors and necessary actions remain in their
own context. The inline placement consumed list height and required scrolling
to reach actions on short viewports; the replacement dialog owns that form
constraint independently. Responsive details requires
both geometry observation and careful focus restoration across modes.

The two width conditions, nested modal dismissal and reading bookmarks require
browser checks as well as component tests. Controlled fixtures establish Web
behavior only; native Worker/Provider execution and physical keyboard behavior
need their own evidence. Server search or an activity-sorted inventory would
require a separate data contract; this presentation retains complete pagination
and service order. Shared rendering and input remain independently owned, so
header composition does not establish delivery of new message or image abilities.
