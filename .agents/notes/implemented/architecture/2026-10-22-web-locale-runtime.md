# Agent Note: Web Locale Runtime

Status: implemented

## Problem

At the foundation decision, the browser workspace used Chinese product text
and locale-specific formatting throughout its existing components. English and Simplified Chinese needed one
language choice, consistent message parameters, observable preference failures,
and a way to update presentation without resetting graph, detail or attachment
state. The existing per-project browsing records already have independent
storage formats and must retain their meaning.

## Decision

`packages/daynight-web/src/i18n/` provides an explicitly mounted locale runtime.
Two eagerly imported TypeScript catalogs satisfy one `Messages` interface, and
React Context distributes the selected catalog and cached native `Intl`
formatters. Fixed strings and named-parameter message functions share that
interface. The foundation initially contained only runtime messages. The
[bilingual interface decision](../feature/2026-10-22-web-bilingual-interface.md)
extends that contract with the current component callers and owns production
integration and state preservation.

Initial resolution prefers a valid explicit `en` or `zh-CN` value, then the first
supported browser language, then English. Every Chinese language variant uses
Simplified Chinese. Automatic detection does not save a preference. Explicit
selection immediately updates presentation and saves a raw string under the
origin-local `daynight.web.locale` key. Existing project preference keys and JSON
formats remain independent.

The Provider receives an explicit initial result and an injectable storage
getter. Its current preference issue preserves a read, invalid-value or write
failure and its cause. Every successful save clears that issue, including an
issue produced during startup. Presentation values and preference errors have
separate subscriptions, so a storage error does not replace the catalog or
formatters. Missing Provider usage fails explicitly.

The shared native selector has a bilingual visible label, language self-names,
safe localized failure text and a save retry. Multiple instances share one
Provider. Date and time formatting retains the local timezone and 24-hour clock;
byte formatting keeps the exact byte count. The language runtime has no domain
requests and does not modify API, task, project or database data.

The [requirements](../../../../docs/spec/daynight-web-i18n.md) own the complete
bilingual outcome; the [design](../../../../docs/design/daynight-web-i18n.md)
explains both runtime and production integration. `main.tsx` now mounts the
Provider before rendering, and the public entry, authenticated application and
feature components use the same catalogs. The linked interface decision owns that integration; the foundation
choice recorded here remains in force.

## Alternatives

**Typed TypeScript catalogs and React Context.** This is the selected approach.
Messages are maintained by developers and released with the application, so
the compiler can check the complete catalog and named arguments directly. It
does require the application to own its small message interface and deliberate
component integration. Native `Intl` supplies formatting and plural categories;
the runtime does not grow a template parser or translation platform.

**i18next with react-i18next.** Resource namespaces, interpolation and a dedicated
translation-library workflow were considered. The confirmed scope has two
developer-maintained catalogs and no external translation pipeline. Adopting
that resource model would add library configuration and message conventions
without a present consumer for that workflow. Reconsider it if translation
platform collaboration or independently managed resource namespaces become
requirements.

**FormatJS with react-intl.** ICU messages and message extraction were considered
for a workflow centered on structured message authoring. Current messages can
be expressed with strings and typed functions, so an ICU authoring and
extraction pipeline would add another maintained representation. Reconsider
this choice if translators need ICU resources or complex rich-text messages.

## Consequences

Both catalogs are compiled into the existing Web build and require no runtime
resource fetch. Catalog completeness and argument types fail at compilation;
tests cover runtime language matching, storage transitions, shared selectors
and formatting. Callers outside a Provider fail rather than silently choosing
a language. Storage failures remain visible while the current page can still
change language.

The runtime, interface integration and production acceptance have separate
tracked completion conditions. The foundation was delivered independently so its
behavior could be reviewed before replacing product text, and its catalog grew
with actual callers. Explicit mounting, absence of domain-side effects and
complete message functions let the interface integrate without changing runtime
preference semantics. The linked interface decision owns state preservation.

The isolated preview and test helper allow components to adopt the runtime
explicitly. They do not establish complete English coverage, initial document
metadata, modal integration or production-browser acceptance. The interface
integration supplies those component and metadata behaviors while retaining
resource identity, business request dependencies, graph geometry and existing
browsing records. Combined production verification remains separately tracked.

Cross-tab live synchronization and account-level preferences are outside the
current guarantee. The origin-local value is read at startup and written on an
explicit choice or retry. A future synchronization mechanism can observe that
same independent preference without changing task or project data.
