# UI Design

These principles apply when designing, adding, modifying, or reviewing UI.
Product specifications and design documents own specific interface behavior.

## Express business rules through controls and interaction

Prefer control availability, selected states, busy states, and interaction flows
to express business rules. Do not add visible status messages or operating
instructions that repeat what those controls and interactions already express.

| Situation | Expression through the UI | Redundant text to omit |
|---|---|---|
| A refresh is running | The refresh button is busy and disabled | "Refreshing, please wait" |
| A setting is enabled | The switch is on | "Currently enabled" |
| An item is selected | The item has a selected state | "You have selected this item" |

Business information such as task status, field labels, and actual errors must
remain clear and visible. These are information the user needs to read, even
when controls also reflect them.

When context does not explain why a control is disabled, its reason may be
presented on demand near the control. Hover explanations must also be available
through keyboard focus.

## Keep rendered interfaces stable during background checks

Run identity, permission, and data checks in the background while preserving
the interface that has already been displayed.

- Switching windows or browser tabs, restoring focus or visibility, and
  returning to a previously visited page do not request a visible refresh.
  These events may trigger background checks.
- During a check, preserve displayed content, selected tabs, open dialogs and
  menus, drafts, unapplied selections, loaded pages, expanded items, scroll
  positions, focus, text selection, and graph viewports. A pending check must
  not by itself hide or remount content, clear a list, replace content with a
  loading placeholder, close an overlay, reset interaction state, disable local
  editing, or insert and remove status rows that shift existing content.
- When the confirmed identity, permissions, and data are unchanged, completion
  of the check must leave the displayed interface and interaction state
  unchanged. Preserving only the final state is insufficient: the interface
  must remain stable throughout the wait and recovery reads.
- Actual data changes may update the affected content. Confirmed account
  changes, session expiry, and access revocation must still trigger the
  required isolation and cleanup. Actual failures must remain visible and
  recoverable under the applicable error policy.
- An explicit refresh may show the progress of that operation. Navigating to
  another resource may load its target content. Neither action implicitly
  resets unrelated retained interface state.

Keeping existing content visible does not grant request, publication, or
mutation permission. Existing authentication and authorization gates remain
enforced while a check is pending.

## Keep global language selection at page level

The main Web interface provides its global language selector in the page
header. Standalone pages may retain their existing language selectors in their
existing locations.

Dialogs, overlays, and their own headers must not provide additional global
language selectors. Modal, fullscreen, or other presentation modes must not
cause a selector to be added, duplicated, relocated, or assigned its own
mode-dependent visibility rules. An overlay's header is not the main Web
header.

Overlays inherit the current application language. Preserve existing modal
isolation, focus behavior, and fullscreen layouts; the containing page regions
continue to follow their existing layout and interaction rules.
