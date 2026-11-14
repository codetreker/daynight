# Agent Note: Personal In-Progress Task Projection

Status: implemented

## Problem

An account overview needs complete counts and bounded pages of the caller's in-progress Tasks across authorized projects, with Goal context and Session observations. Project Task pages include descriptions and dependencies and do not provide one consistent account-wide traversal.

## Decision

The server provides an account-scoped lightweight projection with database filtering, project aggregation and keyset pagination. It reuses the project authorization relation and effective deletion rules. Session sources are selected within the initial snapshot and sampled after it closes; the active Worker summary comes from the same selected source and is checked against the task identity, version and status. A fresh credential and inventory revision check fences publication. The [contract](../../../../docs/spec/daynight-personal-in-progress-tasks.md) and [design](../../../../docs/design/daynight-server.md#账号进行中任务读取) own the observable behavior and data flow.

The Web overview traverses the projection once per refresh, checks cross-page consistency, and fences every publication against account and project access changes. It keeps permitted prior results on ordinary refresh failure and withdraws completeness claims when access events remove projects. The [Web design](../../../../docs/design/daynight-web.md#我的进行中任务) owns its presentation and lifecycle.

The revision hashes canonical facts for each matching project, including its full Task epoch, count and version sum. It excludes Session and clock observations.

## Alternatives

**Enumerate projects and use existing Task pages.** This sends requests for projects without matches, transfers full descriptions and needs additional Goal reads; independent project pages also do not establish one account-wide inventory revision.

**Maintain a separate active-project directory and reuse Task pages.** This reduces empty project requests but retains the full Task payload and Goal lookups, and adds a separately maintained directory.

**Look up Worker directory entries for each task.** Live directory observations can be absent or stale independently of an active claim and add reads; the captured claim already contains the authoritative machine name for this projection.

## Consequences

Each selection and publication check aggregates all Task history in active projects. Unrelated Task or Goal updates can reset a traversal, and sustained changes can prevent it from completing. Clients avoid immediate retry loops and expose stale or incomplete results. Claim changes detected before publication also reset the traversal; changes after that check appear on a later refresh rather than through a new live subscription. The partial matching index also costs storage and writes; no performance gain is assumed without measurements.
