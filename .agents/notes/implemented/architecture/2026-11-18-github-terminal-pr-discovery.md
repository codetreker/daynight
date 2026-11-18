# Agent Note: Discover Terminal GitHub Pull Requests

Status: implemented

## Problem

A pull request can open and close between complete open-list polls while both webhook deliveries are missed. Its current terminal state is then absent from the Project's retained list, even though synchronization was enabled when it ended. Backfilling all historical pull requests would also publish facts from periods when the Project had not requested synchronization.

## Decision

Track second-aligned coverage intervals per Project and stable repository identity. An unknown terminal pull request is first published only when its current terminal time belongs to a retained interval; an already saved record remains eligible for updates. Polling and webhook hints share this rule under the existing authorization and lease fence. A disable immediately invalidates old claims independently of the timestamp boundary.

Each full poll reads at most ten 20-item pages of the all-state list from its head, aggregates duplicate numbers, and confirms applicable unknown candidates by current detail. It still traverses the complete open list and confirms absent active entries. The [executor](../../../../docs/design/github-sync-executor.md), [storage](../../../../docs/design/github-pr-storage.md), and [remote](../../../../docs/design/github-app-remote.md) designs own the operation and deployment contracts. This extends the [executor decision](2026-11-13-github-sync-executor.md), [storage decision](2026-11-13-project-github-pr-storage.md), and [synchronization setting decision](2026-11-14-project-github-sync-setting.md).

## Alternatives

**Persist a discovery checkpoint and resume from it.** GitHub's changing pagination can move records around the checkpoint. Repeated bounded scans from the head can discover a late-visible record in a subsequent round without treating a saved position as a complete history.

**Publish every discovered terminal PR.** That would import old history from outside synchronization intent. Coverage intervals retain the periods for which first publication is allowed.

## Consequences

The scan has a predictable list-request bound, but cannot guarantee discovery of records not returned in its first 200 results or skipped by changing pages. Details, open traversal, hints, authentication and retries consume additional requests. Coverage follows the last switch in a UTC second; its classification is separate from the immediate lease fence. Same-second state changes rely on repeated current detail reads and a publication fence against changes during those reads. Identical stale responses from GitHub cannot be distinguished from a stable current state using the available fields. Deployments must drain older writers before the coverage migration.
