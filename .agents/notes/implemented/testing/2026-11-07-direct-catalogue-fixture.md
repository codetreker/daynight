# Agent Note: Direct catalogue fixture

Status: implemented

## Problem

Catalogue qualification tests exercise direct task history, request admission
and cache verification, but rendering the complete task detail surface for each
case also starts unrelated relations and UI work. Shared cache verification makes
an interception based only on request counts ambiguous about its owner.

## Decision

Catalogue-only cases mount `useTaskDetail` with a direct observation and the real
account, task session and cache providers. The hook retains opening, polling,
subscription and release behavior. Catalogue verification instrumentation wraps
the real session method and matches its request signal at the cache verification
boundary. The pause fixture holds the actual database opening in that verification.
Menu, relation, focus and confirmation scenarios continue to mount the complete
surface. The [Web validation guide](../../../../packages/daynight-web/README.md#development)
owns the test commands and coverage gate.

## Alternatives

**Keep the complete surface in every case.** It supplies the real lifecycle but
adds unrelated UI and relationship requests to tests of the catalogue alone.

**Stub the session qualification result.** This avoids storage work but cannot
detect a failure to propagate a rejected cache verification through the session.

## Consequences

Catalogue cases retain real asynchronous storage and qualification while avoiding
unrelated surface rendering. They do not prove menu or relation behavior; those
remain covered by the complete surface cases. A faster case does not establish a
whole-job improvement under parallel execution.
