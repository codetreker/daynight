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
