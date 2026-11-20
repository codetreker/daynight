# Agent Note: Worker review polling

Status: implemented

## Problem

A Worker needs to discover its assigned, currently eligible pull requests without
reading every Project PR and requesting each assignment individually. Durable
assignments can outlive the eligibility and access that made them useful.

## Decision

The server exposes a paginated, account-scoped Worker list using the existing
assignments. Each read uses one snapshot for participation, selected Projects,
current access, repository and PR eligibility. Stable keyset pagination bounds
results, and two indexes support the Worker scan and Open PR identity join. The
[assignment design](../../../../docs/design/pr-review-assignment.md) owns the
HTTP and data contracts.

## Alternatives

**Enumerate Project PRs and read each assignment.** This transfers unrelated
PRs and multiplies requests on every poll; the server already owns the facts
needed to filter the collection.

**Delete ineligible assignments.** Retargeting or revoking access would then
change durable ownership; filtering each read preserves that ownership when
eligibility returns.

## Consequences

Each page is consistent but a traversal is not a single snapshot, so changes
between pages may appear on a later poll. Indexes add storage and write cost,
and their transactional creation can block writes during migration. The existing
single-PR assignment and Worker protocols remain available.
