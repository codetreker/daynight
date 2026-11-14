# Agent Note: Shared Native Select Presentation

Status: implemented

## Problem

Page-specific native select wrappers duplicate arrow geometry, focus treatments
and disabled styling. Fixing one wrapper does not prevent another page or an
independent entry from drawing an arrow against its border or allowing long text
to overlap it. A common control must also preserve native list and multiple
selection, form validation, events and real element refs.

## Decision

`src/ui/native-select/NativeSelect.tsx` owns the native select structure and imports
its presentation CSS directly. Its noninteractive wrapper adds a pointer-free SVG
arrow only for a single-line select. Public density, width, focus, pending and
touch properties express presentation; native values, options, constraints,
events and refs stay with the select and its caller. Consumer wrapper classes
are limited to external layout. The [component design](../../../../docs/design/native-select.md)
owns the complete API, geometry and caller responsibilities.

The component has no business state, network or Provider dependency.
LanguageSelector and the public MCP setup client field use it without requiring
an authenticated shell. Project and search status, PR status, and tag match filters
use the shared filter variant while retaining their separate values and behavior.
Bot creation and assistant task forms and record filters also use the shared
presentation while retaining their business selection rules. Task platform and PR
pagination use compact controls; Task organization and Step forms use fill-width
form controls. Their callers retain confirmation, numeric conversion, drafts and
real element refs. A shared popup-state predicate gives enclosing Escape handlers
a native observation without making the component an event owner. Task detail
and Step draft handlers leave the native Escape default intact while preventing
an open picker from closing the enclosing view or discarding a draft.

This generalizes the geometry choice recorded in the
[Worker spacing decision](../bug-fix/2026-11-06-worker-configuration-select-spacing.md)
and the archived [language selector decision](../../archived/bug-fix/2026-11-04-language-selector-spacing.md).
Their original reason remains valid: text padding cannot set a browser-drawn
arrow's inset. The Worker record still owns its existing local implementation;
the shared component owns the reusable presentation contract. The
[PR arrow decision](../bug-fix/2026-11-14-pr-filter-arrow-alignment.md) records
the earlier local implementation and its replacement.

## Alternatives

**Share CSS while retaining page-owned structures.** Each caller could still
omit or duplicate the arrow wrapper, modify internal padding or restore native
appearance. Shared structure and explicit presentation properties keep those
decisions with one owner.

**Build a custom selection menu.** That would require reimplementing native
keyboard and touch selection, form constraints, multi-selection and element-ref
operations for a presentation problem. Keeping a real select preserves these
mechanisms and platform menu behavior.

**Keep the native single-line arrow and adjust text padding.** Its position is
controlled by the browser independently of text padding. The earlier spacing
decisions already identified why this cannot guarantee a fixed inset.

## Consequences

Consumers share geometry and state styling while retaining their business
timing and exact native element identity. List mode keeps native size and
selection semantics without a dropdown arrow. Explicit responsive and named
container modes support touch-sized forms without enlarging ordinary compact
controls.

The extra wrapper must remain shrinkable and match the control's height.
Inherited fieldset disabling, hidden state and direction must also affect the
arrow. The browser suite renders production code to verify these conditions;
module tests retain property, event, ref and form proofs. System-menu behavior
still depends on the browser and platform, and simulated touch does not prove a
physical phone's picker. The common browser configuration runs independently
from routine unit quality and is registered in the main/manual browser workflow.
