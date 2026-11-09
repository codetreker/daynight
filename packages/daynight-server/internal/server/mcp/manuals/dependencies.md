# Dependency management

A Task dependency says that one Task is a prerequisite of another. Use dependencies for real work prerequisites. A reference to a document or another Task identifies an input; it does not, by itself, require an execution dependency.

This manual explains dependency meaning, the MCP read and write formats, and how to verify changes. See [Queries and lifecycle](daynight://manuals/queries-and-lifecycle.md) for Task discovery and statuses, [Write safety](daynight://manuals/write-safety.md) for decision versions and uncertain writes, and [Materials](daynight://manuals/materials.md) for input ownership.

## Prerequisites, dependents and arrow direction

If B depends on A, A is B's prerequisite and B is A's dependent. In diagrams in this manual, an arrow points from prerequisite to dependent:

```text
A → B → C
```

B declares A as a direct prerequisite. C declares B. C does not need another direct declaration of A merely to retain the same scheduling path.

Tasks and dependencies are identified by canonical UUIDs. Display names, title similarity and the order of dependency IDs do not determine their meaning. Dependency collections are unordered sets; reads normalize their identifiers and order.

## Ordinary and external dependencies

Both kinds are prerequisites within the same Project:

| Kind | Scheduling effect | Task-chain effect |
| --- | --- | --- |
| Ordinary | Blocks starting or completing the dependent until the prerequisite is terminal | Connects the Tasks into the same ordinary task chain |
| External | Has the same blocking effect | Refers to a prerequisite outside the dependent's ordinary chain without joining the two chains |

An external dependency is not a cross-Project dependency. Choose its classification from the actual responsibility and input relationship. A prerequisite being done, a convenient graph layout, or the Tasks having similar titles does not determine the classification.

An ordinary task chain is the connected component formed by treating ordinary dependency edges as undirected. It can contain branches, joins and Tasks in any status. A standalone Task is its own chain. There is no ordering significance to the first dependency in an array.

### Scheduling and content are separate

`done` and `cancelled` satisfy dependency scheduling. `todo` and `in_progress` do not. Both ordinary and external prerequisites participate in blocking and cycle checks.

Entering `in_progress` or `done` requires every direct prerequisite to be `done` or `cancelled`. A dependency update must also satisfy the existing Task's state constraints: adding an unfinished prerequisite to an `in_progress` or `done` Task is refused. Cancellation itself does not require the unfinished prerequisites to become terminal first, although cancellation and active Worker execution have their own rules.

Terminal status does not establish that a prerequisite's required document or implementation exists. In particular, `cancelled` does not mean that its planned output was delivered. Read and assess the actual required materials before proceeding. A dependency becoming terminal can change a dependent's readiness without changing the dependent's Task version.

`ready` is a scheduling fact, not authorization to choose, execute or hand off work. See [Operation boundaries](daynight://manuals/operation-boundaries.md).

## Read format: the complete set and its external subset

A Task read returns two related collections:

- `dependsOn`, denoted D, contains **all** direct prerequisites.
- `externalDependsOn`, denoted E, contains the external subset of D.
- The ordinary prerequisites are D minus E.

For example, the following excerpt describes C with ordinary prerequisite A and external prerequisite X:

```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "version": "12",
  "dependsOn": [
    "22222222-2222-4222-8222-222222222222",
    "55555555-5555-4555-8555-555555555555"
  ],
  "externalDependsOn": [
    "55555555-5555-4555-8555-555555555555"
  ]
}
```

Here D is `{A, X}`, E is `{X}`, and the ordinary set is `{A}`. Do not copy both returned arrays directly into an MCP dependency update: MCP writes use a different partition.

## MCP write format: two disjoint complete collections

For `task_create` and `task_update`, the input arrays mean:

- `dependsOn`: ordinary prerequisites only.
- `externalDependsOn`: external prerequisites only.

The arrays must be disjoint. A UUID may occur once across both arrays, including after UUID normalization. Each prerequisite must identify an existing Task in the same Project. A Task cannot depend on itself, and the complete dependency graph must remain acyclic. The current limit is 15 direct prerequisites in total, shared by ordinary and external prerequisites.

### Replacement, omission and empty arrays

Dependency input is a replacement, not an append operation:

| Input to `task_update` | Resulting relationship set |
| --- | --- |
| Omit both arrays | Preserve every existing dependency and classification |
| Supply only `dependsOn` | Replace all dependencies with that ordinary set; remove existing external dependencies |
| Supply only `externalDependsOn` | Replace all dependencies with that external set; remove existing ordinary dependencies |
| Supply both arrays | Replace all dependencies with exactly those ordinary and external sets |
| Supply either array as `[]`, with the other omitted | Clear all dependencies |
| Supply both arrays as `[]` | Clear all dependencies |

`null` is not a dependency-clearing value. Use arrays. On creation, omitting both arrays creates a Task with no prerequisites.

To remove one ordinary prerequisite while retaining an external prerequisite, send the complete remaining ordinary set **and** the complete external set. Sending only the changed ordinary collection would also remove the external relationships.

The precise parameter schema for the connected service is discoverable through `tools/list`. Do not substitute REST patches or CLI flags for the MCP input contract.

## Read, decide, replace and verify

The JSON examples below are the `params` passed to MCP `tools/call`, not complete JSON-RPC requests. The Project and Task UUIDs are fictional. Use the actual IDs and the exact version returned by the reads on which the decision is based.

Suppose the Project is P, the dependent is C, and the decision is to replace C's ordinary prerequisite A with B while retaining external prerequisite X:

| Label | Example UUID |
| --- | --- |
| P | `11111111-1111-4111-8111-111111111111` |
| A | `22222222-2222-4222-8222-222222222222` |
| B | `33333333-3333-4333-8333-333333333333` |
| C | `44444444-4444-4444-8444-444444444444` |
| X | `55555555-5555-4555-8555-555555555555` |

### 1. Read the dependent and its relevant inputs

Read C's complete definition, current version, status and D/E collections:

```json
{
  "name": "task_show",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "44444444-4444-4444-8444-444444444444",
    "view": "full"
  }
}
```

Read A, B, X and their materials or dependency paths as needed to establish that the proposed relationships have the intended meaning. Checking Task IDs alone does not establish that their required outputs are sufficient.

Keep the version used for the decision as an exact decimal string. Graph nodes do not provide a Task mutation version; use a Task detail read for that purpose. A later automatic version read cannot protect an earlier decision.

### 2. Submit the full replacement

If the preceding observation returned C at version `"12"`, use that exact version:

```json
{
  "name": "task_update",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "44444444-4444-4444-8444-444444444444",
    "ifVersion": "12",
    "dependsOn": [
      "33333333-3333-4333-8333-333333333333"
    ],
    "externalDependsOn": [
      "55555555-5555-4555-8555-555555555555"
    ],
    "returnView": "full"
  }
}
```

A successful resulting Task has D `{B, X}` and E `{X}`. Its read representation therefore includes X in both returned collections, even though X occurred only in `externalDependsOn` in the write input.

Inspect the structured result and its write outcome. Do not infer completion from the text `Completed.` alone. Version conflict, failed validation and unknown submission results require different responses; see [Write safety](daynight://manuals/write-safety.md).

### 3. Read the actual graph

After creating, replacing or clearing dependencies, read the graph for the affected Task:

```json
{
  "name": "task_graph",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "44444444-4444-4444-8444-444444444444",
    "dependsOnly": true
  }
}
```

The result is a structured object, not a bare node array. Its `structuredContent.data.tasks` contains nodes such as this excerpt:

```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "dependsOn": [
    "33333333-3333-4333-8333-333333333333",
    "55555555-5555-4555-8555-555555555555"
  ],
  "externalDependsOn": [
    "55555555-5555-4555-8555-555555555555"
  ]
}
```

Compare the complete D/E sets with the decision. Verify required paths, classification and removable shortcuts. If a change splits one ordinary chain into multiple components, read each affected component, using a surviving Task in that component as the root. One graph read cannot verify disconnected components.

Read any additional paths needed beyond the graph's direct external context. A successful write response or an expected Task field is not a substitute for checking the resulting relationships.

## Creating a Task with prerequisites

Creation uses the same disjoint input partition. For example, a new Task with ordinary prerequisite B and external prerequisite X can be submitted as follows:

```json
{
  "name": "task_create",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "title": "Verify the assembled result",
    "description": "Verify the result supplied by B against the required input supplied by X.",
    "dependsOn": [
      "33333333-3333-4333-8333-333333333333"
    ],
    "externalDependsOn": [
      "55555555-5555-4555-8555-555555555555"
    ],
    "returnView": "full"
  }
}
```

A new Task begins in `todo` with automatic execution disabled. Its prerequisite Tasks can still be unfinished: the relationships block starting and completion, not registration. Preserve the returned new Task ID and read its actual graph. If the creation result is unknown, reconcile the original operation before deciding on another creation; a matching title alone cannot identify the original result.

## Reducing redundant direct dependencies

Keep the necessary prerequisite paths while avoiding duplicate direct edges. Perform reduction only within the relationships being created or changed; discovering an unrelated shortcut does not authorize editing it.

### Ordinary shortcuts require an all-ordinary alternative

For an all-ordinary chain:

```text
A ─ordinary→ B ─ordinary→ C
└────────ordinary────────→ C
```

The direct A-to-C edge is redundant. C needs only B as its ordinary prerequisite because the retained all-ordinary path already provides A.

Do not remove an ordinary edge using an alternative path that contains an external edge:

```text
A ─external→ B ─ordinary→ C
└────────ordinary────────→ C
```

The direct ordinary A-to-C edge also contributes ordinary-chain membership. Removing it merely because A still precedes C through an external edge would change that membership. The scheduling reachability alone does not justify the removal.

### External shortcuts may use either kind of alternative edge

For an external shortcut, a retained alternative prerequisite path may contain ordinary edges, external edges, or both:

```text
A ─external→ B ─ordinary→ C
└────────external────────→ C
```

The direct external A-to-C edge is redundant if the retained path already supplies that prerequisite. Removing the external shortcut does not remove an ordinary-chain connection.

In every case, compute the complete desired direct collections, retain each surviving edge's classification, submit one replacement and verify the actual graph. Do not use a graph's visual placement to reclassify an edge.

## What the graph contains

`task_graph` is scoped to the selected Task, not to the whole Project. It returns:

1. The selected Task's entire ordinary connected component, including branches, joins and all undeleted Task statuses.
2. Each external prerequisite directly declared by any member of that component.

The external prerequisites in the second group are context nodes. Their own prerequisites and ordinary chains are not recursively expanded. Tasks in other chains that externally depend on a member are not selected. A standalone Task produces its own component plus any directly declared external prerequisites.

Every returned node retains its actual full `dependsOn`, `externalDependsOn` and, when requested in the normal graph view, `blockedBy` references. Some IDs can refer to Tasks whose rows are intentionally absent from this projection. Preserve those IDs. Absence of a row does not establish that a prerequisite is missing, deleted, terminal, unnecessary or part of no alternative path.

`dependsOnly: true` restricts each node to its ID and dependency collections. Without it, graph nodes include compact title previews, status, readiness and other graph metadata; they do not contain descriptions or full Task content. The graph result includes `projection`, `project`, `observedAt`, `summary`, `tasks`, `returnedNodes` and `totalNodes`. The node counts describe this selected projection, not the Project's Task count or a recursive dependency closure. Graph reads have no continuation cursor.

The graph is read within one observation. `observedAt` is its UTC observation timestamp, not a content hash, Task version or lock. Separate Task, graph and material reads are not a shared cross-request snapshot. Other operations can change prerequisites or inputs between reads; the service rechecks the applicable constraints when a mutation is submitted.

## Refusals and uncertain results

| Condition | Required response |
| --- | --- |
| Malformed, duplicate, self or out-of-Project prerequisite | Correct the proposed identities and full collections after reading the relevant facts. Do not guess another Task from a matching title. |
| More than 15 total direct prerequisites | Reconsider the actual direct relationships and apply valid reduction. Do not split one intended dependency set across successive updates: each update replaces it. |
| `dependency_cycle` | Reassess the complete directed paths and remove the proposed cycle from the authorized change. External classification does not bypass cycle checking. |
| `dependency_unsatisfied` | Read the unmet prerequisite IDs and current statuses. Satisfying the scheduling gate and obtaining required outputs are separate conditions. |
| `version_conflict` | Read the current Task again and reconsider the decision, content, status and authorization. Do not merely substitute the new version and replay the old replacement. |
| Permission or visibility failure | Report the actual access failure. Do not reinterpret it as evidence that a Task does not exist. |
| Lost or malformed response, cancellation or another unknown write outcome | Preserve the original Project, Task, request context and proposed collections. Read current facts before deciding again, without automatically replaying the mutation or claiming that current matching fields prove the original write succeeded. |

Deleting a prerequisite is different from canceling it. Cancellation preserves a readable Task and its relationships while satisfying scheduling. Deletion is refused while undeleted Tasks still depend on the target unless removal of those references is explicitly requested and authorized. Such removal can change dependent Task versions and make work ready. See [Queries and lifecycle](daynight://manuals/queries-and-lifecycle.md) and [Operation boundaries](daynight://manuals/operation-boundaries.md) before choosing either action.
