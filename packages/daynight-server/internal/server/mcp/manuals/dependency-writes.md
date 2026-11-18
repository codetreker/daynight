# Create and replace dependencies

Read [Overview](daynight://manuals/overview.md) first. Read this topic with [Dependency graphs](daynight://manuals/dependencies.md) and [Write safety](daynight://manuals/write-safety.md) before supplying dependency fields to `task_create` or `task_update`. These guides cover dependency-only updates; Task creation or changes beyond dependency fields also require [Task writes](daynight://manuals/task-writes.md).

## Write the complete partition

Mutation `dependsOn` contains **ordinary-only** prerequisites; `externalDependsOn` contains **external-only** prerequisites. The sets must be disjoint, with each normalized UUID appearing once across both. Returned collections differ: `dependsOn` contains all prerequisites, with `externalDependsOn` as its subset. For ordinary A and external X, read D={A,X}, E={X}; write ordinary={A}, external={X}.

Prerequisites must exist in the same Project; Goals and self dependencies are invalid. The full directed graph must remain acyclic. The combined direct-prerequisite limit is 15 across both classifications.

| `task_update` fields | Result |
| --- | --- |
| Omit both arrays | Preserve all relationships and classifications |
| Supply only `dependsOn` | Replace all with that ordinary set; remove existing external edges |
| Supply only `externalDependsOn` | Replace all with that external set; remove existing ordinary edges |
| Supply both | Replace all with exactly those sets |
| Supply either `[]` with the other omitted, or both `[]` | Clear all prerequisites |

Null is invalid. Creation omission means no prerequisites. Successive updates replace the entire set; they do not accumulate portions or bypass the limit. To change one ordinary edge while retaining external edges, submit both complete intended sets.

All direct prerequisites must be done/cancelled before starting or completing a Task. Adding unfinished prerequisites to in-progress/done work is refused. Unfinished prerequisites can block a newly registered Task without preventing its registration. Cancellation has no terminal-prerequisite gate and preserves relationships; terminal status still does not establish delivery of required inputs.

## Observe, replace and verify

Read relevant prerequisite material and paths before creating or changing relationships. For an existing Task, read its complete definition, state and exact decision version. Graph nodes have no mutation version; obtain it from Task show.

This schematic example uses observed Project/Task UUIDs P, C, B, X and C's exact decimal-string version v. C replaces ordinary A with B while retaining external X:

```text
task_update({projectId: P, taskId: C, ifVersion: v,
             dependsOn: [B], externalDependsOn: [X], returnView: "full"})
```

The returned Task has D={B,X}, E={X}; X correctly appears in both returned arrays. Verify the complete sets, classification and paths with `task_graph`, using `dependsOnly: true` when only relationships matter. Verify after creation, replacement or clearing. Retain a confirmed new Task ID and verify its graph; uncertain creation does not justify another Task based on a matching title.

If the change splits an ordinary chain, inspect every affected component through a surviving Task in each. Graph reads have bounded external context and retain references outside returned rows; inspect additional Tasks/graphs before relying on an alternative path.

## Reduce valid shortcuts

Reduce only relationships within the authorized change, preserving necessary paths and surviving classifications:

- An ordinary A→C shortcut is removable only if an **all-ordinary** alternative path remains, such as ordinary A→B→C. A mixed path may preserve scheduling reachability while the direct ordinary edge still supplies chain membership.
- An external A→C shortcut can use an alternative path containing either or both edge kinds.

Compute the full desired sets, submit one replacement and verify the resulting graphs. Display placement cannot reclassify edges; discovering an unrelated shortcut does not authorize changing it.

## Refusals and uncertain outcomes

| Failure | Required response |
| --- | --- |
| Invalid/duplicate/self/out-of-Project identity | Reassess actual UUIDs and complete sets; do not identify a Task by title similarity. |
| More than 15 direct prerequisites | Reconsider direct relationships and valid reduction. |
| `dependency_cycle` | Reassess complete directed paths; external classification does not bypass cycle checks. |
| `dependency_unsatisfied` | Read unmet IDs/statuses and separately verify required material. |
| `version_conflict` | Re-read current content, state and relationships before making a new decision. |
| Permission/visibility failure | Preserve the access failure; it does not establish absence. |
| Unknown write/transport outcome | Retain original scope, decision version and proposed sets; inspect current facts without automatic replay or attributing matching arrays to that operation. |

Deletion differs from cancellation. Removing incoming references changes dependent versions and possibly readiness, and needs scope covering those effects; follow [Task writes](daynight://manuals/task-writes.md).
