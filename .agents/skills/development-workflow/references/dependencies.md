# Dependency strategy

Use the [manual](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/manual.md#state-and-dependencies) for relationship semantics and CLI replacement.

## Dependency reduction

Before creating tasks, registering a Goal breakdown, or changing dependencies, read the relevant dependency paths and retain only necessary direct prerequisites.
In `A -> B -> C`, arrows point from prerequisites to successors; C declares only B, not A again.

An ordinary edge is redundant only when another path consisting entirely of ordinary edges supplies the same prerequisite; an external edge may be supplied by an alternative path containing either kind of edge.
Preserve classification and check that all necessary paths still exist after reduction.
Source references do not require extra execution dependencies; this rule does not authorize cleaning up unrelated existing relationships.

## Verify dependency changes

After creating, replacing, or clearing dependencies, you must call `task graph` to read back the actual dependency graphs of the tasks involved, for example:

```bash
daynight task graph <task-id> --depends-only --json
```

Compare the D/E sets and classification with expectations, check that required prerequisite paths are complete, and check for direct edges removable under the reduction rules.
Disconnecting relationships may split the graph into multiple components; read each component starting from the tasks involved, not just the portion still connected to one starting task after the change.
Also read any paths outside the graph that require verification; an absent node does not prove that a dependency is missing or that no redundancy exists.

Do not report dependency checks as passed if graph reads fail or required paths remain unverified.
If missing or redundant relationships are found, reread task details, decide on changes, and verify again only within the authorized scope.
Consult `daynight task graph --help` for command arguments.
