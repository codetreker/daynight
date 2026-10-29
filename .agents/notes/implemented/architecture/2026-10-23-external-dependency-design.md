# Agent Note: External Dependency Architecture

Status: implemented

## Problem

A dependency can express a genuine prerequisite without making its two tasks
members of the same delivery chain. The original root-reachability model gave
both relationships the same meaning: shared descendants entered several chains
and made completed prerequisite work appear unfinished. Persisting a separate group
identity would also require creation, reassignment and representative rules that
are unnecessary for distinguishing these edges.

## Decision

The delivered [design](../../../../docs/design/daynight-external-dependencies.md)
and [requirements](../../../../docs/spec/daynight-external-dependencies.md)
specify an explicit boolean classification on each existing dependency row.
Classification storage and the service, CLI and Web read contract are
implemented. Web consumes ordinary-edge components, relationship labels and
explicit edge styling. Public create/PATCH inputs and CLI declarations also
accept classification.

The complete `dependsOn` set continues to own scheduling, blocking, readiness,
cycle detection and capacity. A required `externalDependsOn` subset communicates
the classification in full task and graph resources. Partial API updates retain
the nature of surviving edges when only references change. All candidates,
metadata writes, status assignment and store replacement writes
carry both sets under the existing project transaction. New unspecified edges
are ordinary. An explicitly supplied external subset replaces classification
without changing omitted references; both fields together replace both sets.
CLI dependency declarations always send both full sets, so ordinary-only
options explicitly clear external classification and external-only options
replace the entire set with external relationships.

Ordinary-edge weak components define exclusive chain membership. Web's complete
all-edge ancestor closure supplies its browsing context. The
[chain-scoped task-graph query](2026-10-29-chain-scoped-task-graph.md) uses the
same members with only their directly declared external prerequisites for CLI
inspection; it preserves raw dependency sets across that output boundary.
Dashed edges encode explicit external prerequisites; dashed cards encode tasks
outside the selected
component. Earlier [projection](../../archived/feature/2026-10-20-task-graph-projection.md),
[complete context](../feature/2026-10-22-complete-prerequisite-context.md) and
[progressive overview](../feature/2026-10-22-progressive-task-graph.md) decisions
retain their original rationale. The current model preserves snapshot, layout,
closure and progressive guarantees while replacing per-root membership and
context-derived edge dashes.

The representative is the earliest ordinary root in exact service order.
Saved expansion records retain a task witness, resolving it to the current
component after an ordinary-edge merge or split. No persistent group identity
is published. Ordinary components and their ancestor closure are connected, so
the existing 50-node/100-edge overview and 20-neighbor expansion remain enough
to reach every projected task. Same-representative member changes reset only
topology state and InitialViewport framing; the fullscreen canvas and active
Details remain mounted with their inert/scroll locks. A changed representative
replaces the row and graph as a chain switch. ChainList holds focus continuity outside keyed
representative rows: only a recorded detached control with focus on BODY causes
restoration to the expanded/first surviving heading, existing filter control,
or finally the labeled focusable list section when no chain remains.
Same-row graph restoration takes precedence; active Details and outside controls
retain focus.

Public classification writes require every supported reader to understand the
distinction, including the Web chain model and presentation. Deployable states
without those consumers only establish ordinary edges. Readers do not fabricate
missing classification.

CLI output preserves the required external subset and labels it in its shared
dependency block. Web retains the subset in graph/detail resources and includes
it in graph equality and detail freshness. Components provide exclusive members;
Web retains full prerequisite closure as its context. External edges stay
dashed even when
an alternate ordinary path connects their endpoints, and ordinary context edges
stay solid. The former shared-membership badge is removed.

Migration `012_external_dependencies.sql` adds the non-null boolean with the
ordinary default after agent-permission migration 011, preserving prior schema
checksums, automation permission and other task data. Historical external
classification is not inferred. The original worker regression remains
useful even though a later read found its two cross-chain edges already removed.
Current-data audits may identify existing edges for review, but neither the
schema migration nor acceptance recreates deleted prerequisites.

## Alternatives

**Persist `groupId` and independent membership.** This can represent unrelated
members and stable group identity through dependency edits. It adds membership,
anchor or representative, and migration rules. The confirmed outcome uses an
edge distinction; the design deliberately accepts derived chain identity and
keeps unconnected tasks independent. A later membership feature would need its
own stored model and migration, while preserving prerequisite classification.

**Replace dependency IDs with structured edge objects.** Objects naturally
carry metadata per edge, but replace the public `dependsOn` element type in
every caller. One binary property is represented exactly by a subset while the
complete scheduling set remains stable. The cost is an explicit subset invariant
and well-defined partial update rules. Richer edge metadata would justify
reconsidering the wire representation.

**Filter external edges but keep one chain per root.** This still duplicates C
for ordinary `A → C ← B`. Weak components express one connected chain with
multiple starting tasks and give each member one progress owner.

**Infer old external classifications.** Root order, titles and timestamps do not
record whether a prerequisite is external. Such inference would persist unknown
intent. A false migration default preserves every existing relationship; explicit
classification is a reviewed versioned operation on current data.

**Expose writes before updating readers.** This creates a release where valid
external markers still produce ordinary membership in Web. Reader-first tasks
avoid that inconsistency without a feature flag or another compatibility path.

## Consequences

All-edge execution integrity, classification preservation, strict read contracts
and reader-before-writer delivery are structural guarantees included in every
affected layer. Existing project locks, fault codes, sanitized errors, request
correlation and graph budgets suffice; no FK, scheduler or logging framework is
introduced.

Derived chains can merge or split when ordinary edges change. Their heading and
ordering can change with the representative. Disconnected UX members remain
independent, and no artificial prerequisite is added to make them appear
together. Stable names, empty-group lifecycle and explicit independent members
are outside this outcome. Keeping computed representatives out of the public
resource model leaves those future choices separate from prerequisite semantics.

Changing all-normal multi-root projection to weak components can merge formerly
overlapping entries even though migration changes no endpoints. The design and
prototype expose that behavior for review. Production results remain source-bound
acceptance artifacts, not claims established by the design or prototype.
