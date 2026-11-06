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

The historical [external-dependency write fixture](https://github.com/codetreker/daynight/blob/32e218a1014c2824c4a5fb0e9f345c66707b294b/packages/daynight-server/cmd/e2e_tests/acceptance_external_dependency_write_cli_test.go)
waited for `external-flags-only` and `external-flags-noop` before taking the stale
CLI refusal baseline. Its [acceptance owner](https://github.com/codetreker/daynight/blob/32e218a1014c2824c4a5fb0e9f345c66707b294b/packages/daynight-server/cmd/e2e_tests/acceptance_cli_test.go)
composed the existing eventual/log matching functions: each named ID needed a
parsed `http_request` record with method PATCH and status 200. The existing
eight-second wait budget, cancellation and deadline failures remained visible.

After CLI exit, the fixture waited for an additional mutation log, then required
exactly one new request with status 409 and a nonempty ID present in stderr.
Exit status, empty stdout, error code, task identity and unchanged material were
independent assertions. Correlation failures reported count, status and identity
separately so a later failure could be diagnosed without guessing which predicate
failed.

The [Go module validation boundary](2026-11-06-go-module-validation-boundary.md)
removes that cross-product package and preserves this record's historical source
links. The synchronization principle remains: an HTTP response does not imply a
separate log reader has consumed the corresponding complete record. Current Go
commands belong to the [server guide](../../../../packages/daynight-server/README.md#go-module-validation-and-ci-evidence).
The immutable [installation decision](../../archived/testing/2026-10-20-installed-project-task-acceptance.md)
records the original installed-package and real-service proof boundaries.

## Alternatives

**Wait only for two more records.** Unrelated or repeated preparation records
can satisfy a count without establishing that both named PATCHes were consumed.
Exact identity, type, method and status matching supplies the needed baseline.

**Make every raw HTTP request wait for its log.** That changes completion timing
for cancellation, deadline and concurrent scenarios with different observation
contracts. This gap belongs to the preparation pair before refusal accounting,
so the wait remains at that boundary.

## Consequences

The fix made both preparation records observable before refusal accounting.
Strict checks exposed retries, duplicate writes, wrong status and absent response
identity without changing production HTTP/CLI behavior or wait budgets.

Historical focused regression cases covered unrelated counts, missing/repeated
IDs, wrong fields and a withheld final newline, paired with a complete valid set.
The original real-process scenario also checked rejection, material preservation
and restart persistence. Those results remain source-bound; they do not
reconstruct the unretained predicate values from the original CI failure or
claim that the removed scenario executes in current module validation.
