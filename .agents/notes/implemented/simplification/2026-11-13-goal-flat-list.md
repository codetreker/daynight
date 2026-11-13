# Agent Note: Flat Goal member list

Status: implemented

## Problem

Goal ownership and dependency chains describe different relationships. Grouping
direct members by chain requires multiple disclosures to read all Goal work and
makes the same Task appear with different row presentations depending on its
dependencies.

## Decision

The project Goal list renders every directly owned ordinary Task once in a single
list. It sorts members from the complete snapshot order with the shared member
comparator and displays their actual total, including cancelled Tasks. Shared
member rows retain their Task and Session actions and information. Goal summary,
progress, details and the complete Goal graph keep their own responsibilities;
Goal detail statistics retain chain classification. The [Goal browsing
decision](../feature/2026-11-11-goal-browsing.md) owns scope and navigation.

The mounted member list registers visibility with the existing Session store,
without additional reads. Its rows restore focus to the Task control when a
focused Session control disappears and focus otherwise falls to the document
body; other valid focus remains untouched. The [Web design](../../../../docs/design/daynight-web.md)
describes the assembly and lifecycle.

## Alternatives

**Keep chain and standalone groups.** Their separate presentations and nested
disclosures make the complete Goal membership harder to scan.

**Extract a shared member list controller.** Chain and Goal lists have different
representative, disclosure and visibility owners. A generic controller would
need additional configuration without establishing a separate responsibility.

**Build a separate flat Goal model.** The existing scope and member comparator
already define membership and ordering; another model would duplicate those rules.

## Consequences

Readers reach all direct members with one disclosure and consistent actions;
dependency structure remains available in the Goal graph. A large Goal mounts
all members at once. Stable Task keys and existing visibility registration keep
updates and Session observations tied to the actual member identities.
