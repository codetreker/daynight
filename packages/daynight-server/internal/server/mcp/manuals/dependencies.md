# Dependency graphs

Read [Overview](daynight://manuals/overview.md) first. Use this topic to interpret `task_graph` and returned dependency collections. Read [Dependency writes](daynight://manuals/dependency-writes.md) before creating, replacing or reducing relationships. Read [Tasks](daynight://manuals/tasks.md) when a decision needs complete Task definitions, and [Session reads](daynight://manuals/session-reads.md) when interpreting graph Session observations.

## Direction, membership and scheduling

In `A → B → C`, arrows run from prerequisite to dependent: B depends on A.

Ordinary dependencies join work into an ordinary chain: the connected component of ordinary edges treated as undirected, including branches, joins and all statuses. A standalone Task is its own chain. External dependencies supply prerequisites without joining chains. Both kinds stay within one Project, affect blocking and participate in cycle checks. Goals are neither owners nor targets of ordinary Task dependencies; moving an ordinary Task between Goals does not change its edges.

Classify edges from responsibility and input relationships. Status, display placement and similar titles do not determine classification. UUIDs identify Tasks; dependency collections are unordered sets with normalized identities/order. A source citation alone creates no scheduling edge.

Only done/cancelled prerequisites satisfy scheduling. A prerequisite becoming terminal can change a dependent's readiness without changing its version. Scheduling satisfaction does not prove that required material exists; a cancelled prerequisite may supply no output.

## Ordinary Task returned collections

Returned Task and graph nodes use `dependsOn` (D) for **all** direct prerequisites and `externalDependsOn` (E) for its external subset. Ordinary prerequisites are D minus E. For ordinary A and external X, D={A,X}, E={X}.

Mutation inputs use a different partition: ordinary-only `dependsOn` and external-only `externalDependsOn`. Do not copy returned D/E directly into a write; follow [Dependency writes](daynight://manuals/dependency-writes.md).

## Graph scope and projections

`task_graph` returns the selected Task's entire ordinary component, plus one layer of external prerequisites declared directly by component members. It includes every undeleted status. It does not recursively expand context Tasks' chains/prerequisites or include another chain merely because that chain depends externally on a member. There is no continuation cursor.

The result contains `project`, UTC `observedAt`, `summary`, `projection`, `tasks`, `returnedNodes` and `totalNodes`. Counts describe this selected scope, not Project size or recursive closure.

| Projection | Node content |
| --- | --- |
| `dependsOnly: true` | ID, full D and E; no Session observations |
| Normal | Also type=task, nullable Goal `parentId`, marked title previews, status, blocking/readiness, assignment, platform, permission and times; Session observations follow [Session reads](daynight://manuals/session-reads.md) |

Neither projection supplies Task version, description or properties; read Task show for them. Nodes preserve complete dependency/blocking references even when referenced IDs have no returned row. Such absence proves neither missing/deleted/terminal state nor lack of an alternative path. Read additional relevant Tasks/graphs when those facts matter.

Each graph is one observation. `observedAt` is neither hash, Task version nor lock. Separate graph, Task and material reads share no snapshot; mutations recheck their current constraints. After an edge change, one graph cannot verify disconnected components or paths beyond its direct external context.

## Goal acceptance relationships

`goal_dependencies_show` takes the source `projectId` and `goalId`, plus optional `limit` and `cursor`. A single call returns all direct prerequisites (at most 30), `completionBlocked`, and a page of direct successors. Successor `limit` defaults to 20 and ranges from 1 to 50. Continue `nextCursor` with the same caller, Project, Goal and limit; each page is reauthorized. A null cursor ends the traversal.

Visible endpoints include their Project, Goal, title, status and `internal` or `external` kind. A hidden prerequisite has `target: null`; an editor also receives its opaque `edgeId`, without the endpoint identity. Hidden successors are excluded from the result and pagination. Only editors receive edge IDs and the exact decimal-string `revision`. A blocked completion includes hidden unfinished prerequisites; the status write checks current facts again.

Acceptance relationships are independent of ordinary Task scheduling and Parent membership. A Goal can start while its prerequisites are unfinished, but completion requires all direct prerequisites to be `done`. A cancelled prerequisite remains blocking. Same-Team cross-Project relationships are allowed; separate access to another Team does not permit a cross-Team edge. Use [Dependency writes](daynight://manuals/dependency-writes.md) to edit them.
