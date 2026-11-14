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
presentation while retaining their business selection rules.
Management consumers use the same component: Team and
Project roles choose filter density with a 120px layout wrapper; transfer,
Token expiry and GitHub installation use full-width form density. Their options,
permission gates, drafts and explicit confirmations remain caller-owned.
A shared popup-state predicate gives enclosing Escape handlers a native
observation without making the component an event owner. ManagementDialog uses
it before its ordinary Escape close, retaining native cancellation and stopping
outward propagation while respecting prevented events and IME input.

Session Provider settings, interaction form choices and terminal recording zoom
use the shared component without moving their value or operation ownership.
Pending presentation retains the confirmed Provider value. Multi-select responses
still use native selected options as arrays, and recording zoom remains local
player state.

BotSessionHost sets the Composer presentation touch mode after spreading caller
configuration. Composer and ControlsPanel pass it to the common control; ordinary
Task and Test callers retain the default mode. The existing Bot reading element
provides both `bot-reading` and `native-select-region` names with inline-size
containment. This keeps reading queries and control sizing tied to the same
actual panel width despite nested Composer containers.

Composer owns settings-panel Escape, while the shared Session fullscreen handler
owns both its React and document entry points, including timeline interaction
forms and recording controls outside Composer. Both honor consumed events and
IME. An open native popup consumes propagation without preventing its default
cancellation; panel, draft and fullscreen ownership survive until a later
ordinary Escape. The [Bot Session design](../../../../docs/design/bot-session-view.md)
records the presentation chain and keyboard responsibilities.

This generalizes the geometry choice recorded in the
[Worker spacing decision](../bug-fix/2026-11-06-worker-configuration-select-spacing.md)
and the archived [language selector decision](../../archived/bug-fix/2026-11-04-language-selector-spacing.md).
Their original reason remains valid: text padding cannot set a browser-drawn
arrow's inset. The Worker record preserves the original local-wrapper choice and
its rationale; the shared component owns current Worker presentation and the
reusable contract. The
[PR arrow decision](../bug-fix/2026-11-14-pr-filter-arrow-alignment.md) records
the earlier local implementation and its replacement.

Webhook owner and status filters use the filter variant; subscription and
delivery filters use the full-width form variant. Their callers retain scope
isolation, option eligibility and explicit delivery-filter application.

Task platform and PR pagination use compact controls; Task organization and Step
forms use fill-width form controls. Their callers retain confirmation, numeric
conversion, drafts and real element refs. Task detail and Step draft handlers
leave native Escape cancellation intact while preventing an open picker from
closing the enclosing view or discarding a draft.

## Alternatives

**Share CSS while retaining page-owned structures.** Each caller could still
omit or duplicate the arrow wrapper, modify internal padding or restore native
appearance. Shared structure and explicit presentation properties keep those
decisions with one owner.

**Build a custom selection menu.** That would require reimplementing native
keyboard and touch selection, form constraints, multi-selection and element-ref
operations for a presentation problem. Keeping a real select preserves these
mechanisms and platform menu behavior.

**Size Bot settings from viewport width.** A narrow Bot panel can appear inside
a wide desktop window. Viewport sizing would miss that touch target, while
replacing the existing container name would disconnect reading layout queries.
Multiple names on the same container preserve both responsibilities.

**Protect popup Escape only in Composer.** Timeline forms and terminal playback
controls bypass the Composer form. Guarding the common fullscreen handler also
protects those controls and the external-boundary document path without moving
event ownership into NativeSelect.

**Keep the native single-line arrow and adjust text padding.** Its position is
controlled by the browser independently of text padding. The earlier spacing
decisions already identified why this cannot guarantee a fixed inset.

## Consequences

Consumers share geometry and state styling while retaining their business
timing and exact native element identity. List mode keeps native size and
selection semantics without a dropdown arrow. Explicit responsive and named
container modes support touch-sized forms without enlarging ordinary compact
controls. Bot settings use their reading container width independently of the
viewport, and shared fullscreen keyboard handling covers selects outside the
input form. Native popup cancellation keeps current values and drafts intact.

Worker configuration fields use the form/fill variant; the personal prompt
preview uses filter/content. Their caller-owned drafts, inheritance and save
timing remain separate from presentation. Control-mode adoption retains a real
select ref with exactly the `herdr` and `web` options. Its nullable draft keeps
no selection through the caller-owned layout effect.

The extra wrapper must remain shrinkable and match the control's height.
Inherited fieldset disabling, hidden state and direction must also affect the
arrow. The browser suite renders production code to verify these conditions;
module tests retain property, event, ref and form proofs. System-menu behavior
still depends on the browser and platform, and simulated touch does not prove a
physical phone's picker. The common browser configuration runs independently
from routine unit quality and is registered in the main/manual browser workflow.
