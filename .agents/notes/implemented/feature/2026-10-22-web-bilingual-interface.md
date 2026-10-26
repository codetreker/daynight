# Agent Note: Bilingual Web Interface

Status: implemented

## Problem

The locale runtime needs to reach every shipped Web component without changing
the resource and focus lifecycles that make graphs, centered task details and
attachment operations usable. Product messages include asynchronous results,
existing errors and third-party graph accessibility text. Updating only visible
labels would leave mixed-language controls and results that cannot follow the
current language.

## Decision

The [status assignment decision](../architecture/2026-10-24-task-status-assignment.md) owns the current three-state
protocol. Status journeys use exact registered PUT status writes; current
inventory is 33 native and 28 container results. The rollout counts below retain
their original delivery context; repeatable current commands and mappings belong
to the Web README.

The production entry resolves the initial locale before React rendering, sets
the initial document language and route title, and mounts one persistent
`LocaleProvider`. The initial interface used `App`; the
[authentication activation](../architecture/2026-10-22-authentication-activation.md)
now mounts `AuthenticatedApp` under that same Provider and updates document
metadata on language or route changes.
Navigation focus remains dependent on the route, so changing a language does
not refocus the page. The original integration placed the shared selector in the
navigation bar, task details and fullscreen graph so modal users could change
language while the underlying application was inert. The
[compact-header decision](../simplification/2026-10-24-compact-task-detail-header.md)
removes the duplicate task-detail selector; details consume the same current
application locale through the persistent Provider. Navigation and graph-dialog
headers expose `LanguageSelector` in normal and fullscreen modes; the
[graph-dialog decision](2026-10-26-task-chain-graph-dialog.md) preserves that
access while the page is inert. The
[standalone complete details](../architecture/2026-10-24-standalone-task-detail.md)
use that same Provider and selector outside the workspace shell, with its own
localized route title and ordinary browser keyboard behavior.

The two typed catalogs cover all shipped first-party components. `common`
owns task status labels and the request ID label; `workspace`, `graph` and
`inspection` own their domain messages. The
[authenticated workspace](2026-10-22-web-auth-workspace.md) extends the same
contract with `auth` for login, account and project collaboration. The mandatory
production entry preserves the Provider and complete language/state contracts.
Dates, times, numbers and exact bytes
use the runtime formatters. User content, API field values, state values,
request IDs and attachment bytes remain unchanged. The
[runtime decision](../architecture/2026-10-22-web-locale-runtime.md) retains the
library choice, preference semantics and their original rationale.

Locale Context updates presentation inside memoized graph nodes, root rows and
dependency edges. Layout and paint geometry remain dependent on the existing
graph inputs; locale does not enter request dependencies, resource keys,
preview URLs or iframe identity. Detail, PR pagination and attachment state
remain owned by their existing components and resource identities.

Notifications retain their semantic cause, including a selected task removed
by graph refresh. Rendering maps that cause and structured API, preference and
attachment errors through the current catalog. Pending upload, overwrite and
delete operations retain their original request and state ownership; completion
text uses the language active when the result renders. Raw server diagnostics
remain outside safe error messages, and request IDs retain their original value.

Three stable functional annotations cover the integration on both production
targets: `language-startup-preferences`, `language-state-preservation` and
`language-errors-and-narrow`. At interface delivery each target had thirteen
functional scenarios and native retained five capacity/limit scenarios.
Authentication and the [Markdown description delivery](../architecture/2026-10-22-task-description-markdown.md)
later produced twenty functional scenarios per target and twenty-five unique
native scenarios. The [approval lifecycle](2026-10-22-task-approval-lifecycle.md)
added three approval scenarios per target; the later
[withdrawal decision](2026-10-23-task-unapprove.md) added one more. The inventory at that delivery
was twenty-four functional per target and twenty-nine native, fifty-three across both targets,
retaining all five capacity/limit cases. The existing single project, one worker, zero retries,
capacity matrix, strict coverage and cleanup gates remain required. The
[pipeline decision](../testing/2026-10-21-web-acceptance-pipeline.md) owns phase
scheduling; the [Web README](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns the requirement mapping and receipt interpretation.

The [requirements](../../../../docs/spec/daynight-web-i18n.md) own complete
L1–L10 behavior, and the [design](../../../../docs/design/daynight-web-i18n.md)
owns the current mechanism. Component fixtures and the interactive preview
provide narrower visual evidence.

## Alternatives

**Remount components with a locale key.** Reinitialization would make text
updates straightforward but would discard graph viewport, detail selection,
PR page, file inputs and pending-operation ownership. Context subscriptions
update the existing component instances while retaining those states.

**Retain translated strings in notification state.** This would keep the existing
string representation but freeze an already displayed notice in the language
used when it was created. Semantic causes allow both existing and asynchronous
results to render in the current language without reissuing their operations.

**Include language in graph structure or request inputs.** This would propagate
new text through rebuilt data, at the cost of recalculating geometry or
restarting business requests. Text and accessible descriptions subscribe at
the rendering component, leaving resource identity and geometry independent
of language.

## Consequences

English and Simplified Chinese use one saved origin-local preference across
the shipped workspace. Modal controls, errors and asynchronous results follow
the same language as navigation. Existing per-project browsing formats, URLs,
protocols, user data and attachment execution rules remain intact. This adds
presentation capability without authentication, CLI, backend or new business
operations.

Message completeness is checked by the compiler, while component and browser
tests protect state and request identity. Catalog completeness alone cannot
detect text left outside the catalog, so the component inventory and visible
states remain part of verification. English wrapping can change natural content
height; the interface preserves its existing scroll ownership and tests narrow
layout and focus rather than forcibly resetting scroll positions.

Production claims require complete receipts bound to the actual source and
environment. An isolated mockup, component test or a passing historical run
cannot establish the combined bilingual production result. Adding later
first-party features requires extending both catalogs and their relevant
behavioral checks through the same mechanism.
