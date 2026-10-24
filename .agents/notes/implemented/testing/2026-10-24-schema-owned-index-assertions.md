# Agent Note: Resolve schema-owned indexes before deparsing

Status: implemented

## Problem

Database packages share one PostgreSQL instance while creating and removing
independent test schemas. An index assertion must inspect its fixture's object
without opening objects owned by concurrent tests. A predicate against
`pg_indexes.indexdef` invokes PostgreSQL's index deparser; filtering the view by
schema does not establish when that function is evaluated.

## Decision

The task-sync migration assertion resolves the schema-qualified
`tasks_project_updated_id` through `regclass` before calling `pg_get_indexdef`.
The schema comes from the pinned fixture connection's `current_schema()`, and
`format('%I.%I', ...)` quotes both identifiers. The assertion retains the required
`(project_id, updated_at, id)` column order. A missing fixture index remains a
database error; another schema's same-named index cannot satisfy the check.

Real PostgreSQL cases retain a valid same-named index in a second search-path
schema. They verify a correct local definition, a wrong local order, and an
absent local index. The last case requires `42P01`, including when an unqualified
lookup could find the fallback index. The connection remains pinned while its
search path is set and queried, then releases before schema cleanup.

An isolated PostgreSQL 18.6 probe of the original query produced a plan that
evaluated `pg_get_indexdef` for matching index names before joining the fixture
namespace. Other catalog statistics produced namespace-first plans. Concurrent
schema removal can therefore affect the original assertion's deparser inputs.
The failed hosted run did not record its plan or the disappearing OID's owner;
the correction removes the demonstrated cross-schema access without claiming a
complete reconstruction of that run's scheduling.
PostgreSQL 18.6 defines the [catalog view](https://github.com/postgres/postgres/blob/724edf9bde9d356724ad384a2e196edc3c9f80f7/src/backend/catalog/system_views.sql#L154)
through its [index deparser](https://github.com/postgres/postgres/blob/724edf9bde9d356724ad384a2e196edc3c9f80f7/src/backend/utils/adt/ruleutils.c#L1272),
which opens the indexed relation while reconstructing its definition.

## Alternatives

**Filter the catalog view by schema and index definition.** This expresses the
desired result but leaves the deparser in a reorderable predicate. The observed
namespace-last plan opens other tests' same-named objects before deciding whether
their rows belong to the fixture.

**Resolve an unqualified index name.** This avoids the catalog predicate but uses
the entire search path. A correct fallback index can hide an absent fixture
index. The assertion needs the fixture's object identity, so both schema and
index name are explicit.

## Consequences

Parallel package validation and its coverage, race and cleanup requirements stay
intact. The assertion validates the same migration requirement while depending
only on its fixture's index. No production query, migration or service behavior
changes. Full-system catalog predicates should not be used to deparse objects
whose ownership is intended to be narrower than that catalog scan.

The positive and negative cases establish lookup and failure behavior. Stress
observations alone cannot prove freedom from a planner-dependent race; a
non-reproduction is retained as a limitation of the investigation, not evidence
that the original expression is isolated.
