# Agent Note: Predefined Task Properties Design

Status: implemented

## Problem

Tasks need structured references to the pull requests that deliver their work.
Descriptions cannot expose those references reliably to clients. An unrestricted
attribute bag would also let callers create names and value shapes without an
agreed purpose, making validation and presentation harder to maintain.

## Decision

The delivered artifacts are the [requirements](../../../../docs/spec/daynight-task-properties.md),
[design](../../../../docs/design/daynight-task-properties.md)
and [interactive preview](../../../../docs/design/mockups/task-properties.html).
Server persistence, migration, HTTP operations, CLI property input/output and
read-only web presentation are implemented. This design extends the task
lifecycle and transaction foundation chosen in the original
[server task design](../../archived/architecture/2026-10-19-daynight-server-task-design.md).

The server owns a concrete TaskProperties type. Its first predefined property,
pullRequests, is an ordered array of records with caller-provided url and title
strings. The [worker claim foundation](2026-10-24-worker-claim-foundation.md) adds
a protected worker read property and separates full read/stored codecs from
public writable PR inputs. The interface validates structure and known field
names, while content remains opaque: empty strings, whitespace, control
characters, duplicates and
cross-repository references remain representable. There is no dynamic property
registration or provider-specific PR identity.

Properties use one serialized JSON document in a PostgreSQL text column and the
existing task row transaction. JSON escaping permits embedded NUL in decoded
string values without passing a NUL byte to PostgreSQL text. Equality compares
the typed ordered list. A supplied list replaces that property; omission keeps
it and an empty array clears it. The existing task-wide version covers all task
fields, dependencies and properties together.

CLI URL and title options repeat independently and pair by their occurrence
index. This reuses existing ordered repeatable text options, including empty
values. The bundled public task skill preserves required PR URLs and titles in
the complete property list while retaining merge evidence in the description.
The web task detail dialog presents all values as text and enables navigation only
for HTTP(S) absolute URLs, independently of storage acceptance. Local pages mount
at most 100 records while retaining the complete array, its order and duplicates.
Native paging controls expose every record without another request; task or
collection replacement resets the page before display. Complete task
reads contain properties; the bounded graph projection remains independent.

## Alternatives

**Arbitrary properties or runtime field definitions.** These would allow callers
to add unrelated concepts without a server contract. Concrete definitions make
each addition an explicit schema and product decision, matching the controlled
property catalog requirement.

**JSONB storage.** PostgreSQL JSONB enables field queries and indexes, but rejects
escaped NUL inside strings. That would add a content restriction to a property
whose strings are deliberately opaque. There is no confirmed property query
requirement to justify that restriction.

**One relational row per PR.** This enables independent PR queries but requires
position identity to preserve ordered duplicates, additional reads and a new
collection persistence boundary. Direct text columns also cannot represent NUL.
The accepted write unit is the complete list on its task.

**A JSON array in one CLI option.** This mirrors the API directly and works well
for generated commands, but hand-written values require shell and JSON quoting.
The existing parser already preserves ordered repeated text values, so explicit
URL/title pairs provide the required behavior without a second input language.

**Mount the complete PR list or reveal more rows cumulatively.** A valid byte-limited
request can carry tens of thousands of short records. The
[initial renderer](https://github.com/codetreker/daynight/blob/4758842d37707a620d76622dc4ead3f4614f9bef/packages/daynight-web/src/features/task-detail/TaskPullRequests.tsx)
created a DOM/accessibility representation proportional to the complete array;
progressive append eventually reaches the same size. Fixed local pages bound the
mounted representation while keeping every record reachable. CSS-only display
optimizations would retain the full React/DOM allocation.

**Virtualize a continuous variable-height list.** This could also bound mounted
rows, but raw titles and URLs have variable height and keyboard focus requires
explicit handling of unmounted rows. Native page selection provides direct
access and predictable focus without a new measurement framework or dependency.

## Consequences

The design retains the existing status, dependency, cancellation and optimistic
concurrency guarantees. It adds no remote service or background lifecycle.
Opaque JSON text needs strict application decoding; corruption must fail reads
instead of appearing as empty properties. Native Windows CMD forwarding has a
separate argument representation boundary: installed-launcher checks cover its
representable arguments and opaque response values, while the same installed
Node entry verifies literal multiline input. The server content contract stays
unchanged. Future stored property additions need
migrations, with no read-time old-format fallback.

Property filtering, reverse PR lookup and sorting would require explicit value
comparison and query/index design. PR synchronization would introduce credential,
network and ownership decisions. Web editing and per-item updates can reuse the
task version but need conflict behavior; they are separate work. The current
full-list replacement contract and graph projection isolation remain constraints
on those additions. Runtime acceptance belongs to the implementation tasks and
their corresponding source-bound results.
