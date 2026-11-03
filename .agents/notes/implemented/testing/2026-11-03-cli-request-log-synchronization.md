# Agent Note: CLI request log synchronization

Status: implemented

## Problem

An HTTP response and the acceptance process's parsed service logs are separate
observations. The installed external-dependency write scenario performs two raw
successful PATCHes before taking the mutation-count baseline for a stale CLI
write. If a preparation log is still in the process pipe, its later 200 record
can occupy the slot attributed to the CLI's 409 or increase the observed count.

A [CI failure](https://github.com/codetreker/daynight/actions/runs/41636355942/job/125918576365)
reached the combined request-count, status and identity assertion. The retained
failure did not identify which predicate disagreed. That limits attribution of
the individual run; it does not remove the independently visible ordering gap.
At the captured source, the [preparation pair](https://github.com/codetreker/daynight/blob/dd55c26098acc90ea48d5ad3ab431e68e43a1cae/packages/daynight-server/cmd/daynight-server/acceptance_external_dependency_write_cli_test.go#L67-L77)
is followed directly by refusal accounting, while [request logging](https://github.com/codetreker/daynight/blob/dd55c26098acc90ea48d5ad3ab431e68e43a1cae/packages/daynight-server/internal/server/logging.go#L188-L195)
occurs after the handler returns and the [collector](https://github.com/codetreker/daynight/blob/dd55c26098acc90ea48d5ad3ab431e68e43a1cae/packages/daynight-server/cmd/daynight-server/acceptance_process_test.go#L374-L405)
adds an event only after parsing its complete newline-terminated JSON record.

## Decision

The [external-dependency write fixture](../../../../packages/daynight-server/cmd/e2e_tests/acceptance_external_dependency_write_cli_test.go)
waits for both `external-flags-only` and `external-flags-noop` before invoking the
stale CLI refusal. A small `acceptanceCLIWaitSuccessfulPatchLogs` helper in the
[existing CLI acceptance owner](../../../../packages/daynight-server/cmd/e2e_tests/acceptance_cli_test.go)
composes the existing `acceptanceEventually` and `acceptanceLogs.matches`
functions. All specified IDs must have parsed `http_request` records with method
PATCH and status 200. The caller supplies the existing eight-second log-wait
budget; context cancellation and deadline errors remain visible.

Preparation identity and refusal count remain separate guarantees. After the
CLI process exits, `cli.refuse` still uses `acceptanceCLIWaitMutations` to wait
for the additional write log, then requires exactly one new request with status
409 and a nonempty request ID present in stderr. Exit status, empty stdout,
error code, applicable task ID and unchanged task material remain independent
checks. Correlation failures report the count, status and identity conditions
needed to distinguish a later failure's cause.

The [server validation guide](../../../../packages/daynight-server/README.md#built-process-acceptance-and-ci-evidence)
owns the current acceptance inventory. The original installed-package and real
service evidence responsibilities remain recorded by the immutable
[installation decision](../../archived/testing/2026-10-20-installed-project-task-acceptance.md).

## Alternatives

**Wait only for two more records.** Unrelated or repeated preparation records
can satisfy a count without establishing that both named PATCHes were consumed.
Exact identity, type, method and status matching supplies the needed baseline.

**Make every raw HTTP request wait for its log.** That changes completion timing
for cancellation, deadline and concurrent scenarios with different observation
contracts. This gap belongs to the preparation pair before refusal accounting,
so the wait remains at that boundary.

## Consequences

The preparation pair is observable before the refusal snapshots its count.
Strict refusal checks continue to expose actual retries, duplicate writes,
wrong statuses and missing response identity. Production HTTP and CLI behavior,
coverage gates and existing wait budgets retain their original contracts.

Focused regression cases exercise the helper with unrelated counts, missing or
repeated IDs, wrong fields and a withheld final newline, paired with the complete
valid set under the existing condition-first polling semantics. The real
installed CLI scenario still exercises the built service and isolated
PostgreSQL, including rejection, material preservation and restart persistence.
These checks constrain the synchronization mechanism; they do not reconstruct
the unretained predicate values from the original CI failure.
