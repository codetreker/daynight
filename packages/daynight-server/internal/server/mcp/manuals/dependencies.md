# Dependencies and graph reads

Read this topic to interpret a selected graph or create/replace prerequisites. Writes also require [Write safety](daynight://manuals/write-safety.md); [Tasks](daynight://manuals/tasks.md) owns creation/lifecycle/projections and [Materials](daynight://manuals/materials.md) owns shared input references. Examples are MCP `tools/call` parameters with fictional IDs/versions. Use actual observations and current `tools/list` schemas.

## Meaning and direction

If B depends on A, A is the prerequisite and B the dependent. Diagrams point prerequisite → dependent:

```text
A → B → C
```

Ordinary dependencies connect work in one ordinary chain; external dependencies provide prerequisites without joining chains. Both are within the **same Project**, affect blocking and participate in cycle checks. An ordinary chain is the connected component of ordinary edges treated as undirected, including branches/joins and all statuses; a standalone Task forms its own chain. Goal parent ownership is a different relationship.

Classify from responsibility/input relationships, not terminal status, display layout or similar titles. UUIDs identify tasks; dependency collections are unordered sets with normalized identities/order. A source citation alone is not a scheduling edge.

Done/cancelled prerequisites satisfy scheduling; proposed/todo/in-progress do not. Starting/completing requires all direct prerequisites terminal; adding unfinished prerequisites to in-progress/done work is refused. Cancellation needs no terminal-prerequisite gate. Terminal state can alter a dependent's readiness without changing its version or proving required material was delivered; cancelled inputs in particular may have no output. Read actual needed sources before proceeding.

## Different read and write partitions

In returned Task/graph nodes, `dependsOn` (D) contains **all** direct prerequisites; `externalDependsOn` (E) is its external subset. Ordinary prerequisites are D minus E.

In `task_create` and `task_update` inputs, `dependsOn` is the **ordinary-only** collection and `externalDependsOn` the **external-only** collection. They must be disjoint, with each normalized UUID occurring once across both. Copying the returned D/E arrays directly into a mutation duplicates external IDs.

For C with ordinary A and external X, read D={A,X}, E={X}; write ordinary={A}, external={X}. Each prerequisite must exist in the same Project, no self dependency is allowed, and the full directed graph must stay acyclic. The shared direct-prerequisite limit is 15 across both classifications.

| `task_update` input | Result |
| --- | --- |
| Omit both arrays | Preserve all existing relationships/classifications |
| Supply only dependsOn | Replace all with that ordinary set; remove existing external relationships |
| Supply only externalDependsOn | Replace all with that external set; remove existing ordinary relationships |
| Supply both | Replace all with exactly those two sets |
| Either `[]` with other omitted, or both `[]` | Clear all prerequisites |

Null is not a clearing value. Creation omission yields no prerequisites. To change one ordinary edge while keeping external edges, submit both complete desired sets. Successive updates do not accumulate portions of a large set; each replaces the whole relationship set.

## Observe, replace and verify

Suppose C replaces ordinary A with B while retaining external X. Read C's full definition/version/state and relevant A/B/X material or paths. Graph nodes provide no mutation version; use Task show for the exact decision version.

```json
{"name":"task_show","arguments":{"projectId":"11111111-1111-4111-8111-111111111111","taskId":"44444444-4444-4444-8444-444444444444","view":"full"}}
```

If the observation yields `"12"`, the complete replacement is:

```json
{"name":"task_update","arguments":{"projectId":"11111111-1111-4111-8111-111111111111","taskId":"44444444-4444-4444-8444-444444444444","ifVersion":"12","dependsOn":["33333333-3333-4333-8333-333333333333"],"externalDependsOn":["55555555-5555-4555-8555-555555555555"],"returnView":"full"}}
```

The returned Task has D={B,X}, E={X}; X appears in both **returned** arrays. Inspect structured business/completion facts rather than the short Completed text. Re-read the resulting graph after creating/replacing/clearing relationships:

```json
{"name":"task_graph","arguments":{"projectId":"11111111-1111-4111-8111-111111111111","taskId":"44444444-4444-4444-8444-444444444444","dependsOnly":true}}
```

Compare complete D/E sets, paths and classification. If a change splits an ordinary chain, read every affected component using a surviving Task in it. One graph cannot verify disconnected components or paths beyond its direct external context.

Creation uses the same disjoint partition. This registers confirmed work explicitly:

```json
{"name":"task_create","arguments":{"projectId":"11111111-1111-4111-8111-111111111111","title":"Verify the assembled result","description":"Verify B's supplied result against X's required input.","status":"todo","dependsOn":["33333333-3333-4333-8333-333333333333"],"externalDependsOn":["55555555-5555-4555-8555-555555555555"],"returnView":"full"}}
```

Automatic execution remains disabled; unfinished prerequisites block execution/completion rather than registration. [Tasks](daynight://manuals/tasks.md) owns creation defaults. Preserve the confirmed new ID and verify its graph. Unknown creation requires original-context reconciliation, not a duplicate based on title matching.

## Reduce only valid shortcuts

Reduce within the authorized relationships being created/changed, preserving necessary paths and surviving classifications. Discovering an unrelated shortcut does not authorize editing it.

An ordinary shortcut may be removed only when an **all-ordinary** alternative path remains:

```text
A ─ordinary→ B ─ordinary→ C
└────────ordinary────────→ C
```

The direct A→C ordinary edge is redundant. If A→B is external, however, the direct ordinary A→C still contributes ordinary-chain membership; scheduling reachability through that mixed path does not justify removal.

An external shortcut may use an alternative path containing either/both edge kinds:

```text
A ─external→ B ─ordinary→ C
└────────external────────→ C
```

The external A→C can be removed while the path remains. Compute the complete intended collections, submit one replacement and verify actual graphs; visual placement cannot reclassify an edge.

## Graph scope and projections

`task_graph` returns the selected Task's entire bidirectionally connected ordinary component, plus one layer of external prerequisites directly declared by its members. It includes all undeleted statuses. It does not expand context Tasks' own chains/prerequisites recursively, or include another chain merely because it depends externally on a member. There is no continuation cursor.

The result is an object at `structuredContent.data`, not a bare node array. It includes `project`, `observedAt`, `summary`, `projection`, `tasks`, `returnedNodes` and `totalNodes`. Counts describe this selected scope, not Project size or recursive closure.

`dependsOnly: true` restricts nodes to ID, full D and E. Normal nodes add type=task, nullable Goal parentId, marked title previews, status, blocking/readiness, assignment, platform, permission and times; they still omit Task version, description and properties. Read Task show separately for those. [Session reads](daynight://manuals/session-reads.md) owns normal graph Session projections; dependency-only has none.

Nodes retain their actual full dependency/blocking references even when an ID points outside returned rows. Preserve those IDs: absence of a row proves neither missing/deleted/terminal state nor lack of an alternative path. Query additional relevant Tasks/graphs to verify paths.

One graph is read within one observation. UTC observedAt is not a hash, Task version or lock. Separate graph, Task and material reads do not share a snapshot; submitted mutations recheck their applicable current constraints.

## Refusals and uncertain results

| Failure | Required response |
| --- | --- |
| Invalid/duplicate/self/out-of-Project identity | Reassess actual IDs and full sets; do not guess a Task from title similarity. |
| Over 15 total direct prerequisites | Reconsider direct relationships and valid reduction; successive replacement calls cannot bypass the limit. |
| dependency_cycle | Reassess complete directed paths; external classification does not bypass cycle checking. |
| dependency_unsatisfied | Read unmet IDs/statuses; scheduling and required deliverables are separate. |
| version_conflict | Reread current content/state/relationships and make a new decision, not a latest-version replay. |
| Permission/visibility failure | Preserve actual access failure rather than infer absence. |
| Unknown write/transport outcome | Retain original scope, decision version and proposed sets; inspect current facts without automatic replay or historical attribution from matching arrays. |

Cancellation preserves readable relationships and satisfies scheduling. Deletion is distinct; removing incoming references is an additional consequential change, affecting versions/readiness, that needs its own covered scope. [Tasks](daynight://manuals/tasks.md) owns cancellation/deletion boundaries and [Write safety](daynight://manuals/write-safety.md) owns completion attribution.
