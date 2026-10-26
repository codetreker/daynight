# Agent Note: Complete GitHub Observations

Status: implemented

## Problem

A PR list can span several responses and can move while those responses are
being read. Treating a failed page as an empty result can permanently exclude PRs
at initialization or incorrectly close tracked work. Persisting half a pass also
gives later scheduling an inconsistent observation of the repository.

## Decision

The review GitHub adapter performs authenticated read-only queries through `gh api`.
The review polling module composes those queries into one repository observation
pass, registers local repository state and owns poll-result commits and failure
recording. The adapter does not depend on SQLite or receive the store.
It resolves a host-qualified repository identity from the REST numeric ID,
validates safe integer representation, and keeps that identity independent of
remote-address spelling. The existing store remains the owner of review triggers
and revision transitions.

Each REST page is read with an explicit GET and captured HTTP headers. HTTP framing
and status are processed before body decoding, including nonzero CLI exits for
HTTP errors. Successful responses require valid JSON. Error status and waiting
headers remain authoritative when the body is HTML or empty; JSON error messages
are optional metadata. Aborted execution, timeout, overflow, or incomplete
capture cannot establish a successful response. Calls use argument arrays with
bounded capture and request time, preserving the prepared authentication
environment.

Pagination follows validated next-page links. Accepted links have the expected
HTTPS API origin, repository path, and scan parameters. Both owner/name and
numeric repository pull-list routes are recognized because GitHub can emit the
latter in its Link header. Relation parameters accept permitted whitespace and
quoted values; malformed syntax cannot establish that pagination ended.
Requests use relative endpoints or internally reconstructed, validated absolute
URLs for configured API ports. Unchecked Link URLs are never passed to `gh`.
Repeated pages are errors; repeated PR numbers are coalesced so that only the last
retrieved occurrence is applied.

`gh` rejects ports in `--hostname`. A port request therefore uses a validated
absolute API URL and the bare hostname flag. Existing enterprise-token
environment values keep their precedence. Otherwise, the adapter privately
captures the prepared bare-host credential with `gh auth token` and supplies it
only as the API child's `GH_ENTERPRISE_TOKEN`. Credential capture and command
failures expose sanitized diagnostics; token output and environment values never
enter public errors, logs, configuration, or database records. No global login or
credential storage is changed. The inspected
[hostname validation](https://github.com/cli/cli/blob/37800dd56a536e69b20d682b770e983c3829c164/internal/ghinstance/host.go#L35-L42)
and [request authentication](https://github.com/cli/cli/blob/37800dd56a536e69b20d682b770e983c3829c164/api/http_client.go#L92-L110)
explain the bridge.

An initial pass reads all states and all pages and commits their maximum PR
number. A successful empty pass commits zero. Later passes read all open PRs,
including Draft, without a high-water cursor. Tracked open PRs missing from a
complete list are fetched individually. A successful direct response determines
their actual state; a 404 or failed confirmation is an error, not closure proof.

Repository observation responses are collected and validated before writes.
The store's `applyRepositoryPoll` commits initialization or a deduplicated
snapshot together with the successful-poll timestamp in one short transaction.
An API or database failure preserves the previous cutoff, PR observations, and
success time. Error metadata is recorded separately. No transaction spans a
network request. The [state decision](2026-10-17-durable-review-state.md) owns the
underlying revision and execution rules.

Rate-limit failures retain HTTP status and an absolute retry deadline. Retry-After
delay/date and primary-reset headers are honored; multiple constraints use the
latest deadline. A recognized secondary limit without an explicit deadline uses
GitHub's minimum wait. The client keeps a host-level deadline and rejects further
same-host API calls until it expires, including later repositories in the same
batch. Other hosts can continue. The adapter does not sleep or retry internally;
the foreground coordinator reuses this client and schedules another pass. One repository's
failure remains visible without discarding another repository's result.

The inspected CLI is gh 2.88.1. Its
[response framing](https://github.com/cli/cli/blob/37800dd56a536e69b20d682b770e983c3829c164/pkg/cmd/api/api.go#L461-L465),
[HTTP error behavior](https://github.com/cli/cli/blob/37800dd56a536e69b20d682b770e983c3829c164/pkg/cmd/api/api.go#L510-L535),
and [API host mapping](https://github.com/cli/cli/blob/37800dd56a536e69b20d682b770e983c3829c164/internal/ghinstance/host.go#L59-L69)
define the adapter assumptions. GitHub's
[API practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
describe pagination movement, private-resource 404s, and rate-limit waiting.

CI readiness is a separate read-only GraphQL query bound to the PR head and
base branch. HEAD and available test-merge rollups cover Check Runs and legacy
Status Contexts. Paginated Check Suite summaries additionally capture registered
workflows awaiting approval or jobs. Each scan freezes the target and suite
counts, collects unique suite identities, and requires complete pagination.
Observable count or membership changes invalidate the result instead of allowing
an unseen page to authorize review. Latest workflow/event run and attempt
numbers replace older runs; suites without a provable replacement keep their
blocking result. `SUCCESS`, `SKIPPED` and `NEUTRAL` pass only after completion.
An empty CI result is permitted; incomplete data or API errors are not empty CI.
This evidence remains separate from durable review triggers.

The [GraphQL rollup schema](https://docs.github.com/en/graphql/reference/objects#statuscheckrollup)
defines the combined state. Rollup success alone is insufficient: the official
CLI repository's [approval-blocked workflow](https://github.com/cli/cli/actions/runs/39044725737)
has no jobs while other checks on its commit produce a successful rollup.
Suite summaries retain that known blocker. GitHub documents
[approval for fork workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks)
and [run/attempt numbering](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context).

GraphQL uses a POST containing only a fixed query. Normal endpoints use flat
CLI variables; ported absolute URLs need explicit nested variables because
[the CLI groups them only for the literal graphql endpoint](https://github.com/cli/cli/blob/fa92838bef95fe4a29c1587693885d5e9bdb6cf1/pkg/cmd/api/http.go#L16-L55).
The same bounded capture, private authentication bridge and host cooldown apply.
HTTP 200 with GraphQL errors still fails, including partial data. Application
rate-limit errors honor the response deadlines and block later same-host calls.

## Alternatives

**Let `gh --paginate --slurp` collect everything.** This hides individual page
status and timing, accumulates response data, and follows Link URLs before the
module can validate their destination. Explicit page reads preserve transport
failure and pagination boundaries.

**Use PR number or updated_at as a progress cursor.** Existing in-range PRs can
change indefinitely, while updated_at also changes for events unrelated to
review. Complete recurring scans preserve old PR eligibility.

**Decode every response as JSON before checking status.** Successful API bodies
use JSON, but HTTP error bodies need not. The
[HTTP 429 specification](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)
explicitly includes an HTML example with Retry-After. Requiring JSON first loses
the known status and waiting deadline, allowing a later request to violate the
server's limit.

**Apply each successful page immediately.** A later response or SQLite failure
would leave a partial repository pass. Gathering responses first and committing
one batch preserves the previous state when any confirmation or write fails.

**Use GraphQL node_id as an interchangeable identity fallback.** Global node-ID
representations have required migrations. Mixing them with REST IDs can create a
second initialization identity. Unsafe numeric IDs fail explicitly rather than
round or switch representation. See GitHub's
[node-ID migration](https://github.blog/news-insights/product-news/graphql-global-id-migration-update/).

**Use only a combined status or rollup.** Legacy combined status omits Check
Runs. A GraphQL rollup includes both, but can omit a registered workflow with no
jobs and an action-required conclusion. Suite summaries close that observed
admission gap without enumerating every job context.

## Consequences

Controlled HTTP/process fixtures and real SQLite databases verify pagination,
initialization, triggers, failure isolation, closure evidence, rate limits, and
transaction rollback without live review credentials. The
[Git manager](2026-10-17-owned-review-worktrees.md) reuses the authenticated
command helpers. The [foreground coordinator](2026-10-17-foreground-review-coordination.md)
wires recurring passes and retained-session execution into the CLI.

Pagination is not an atomic remote snapshot. Repeated complete scans converge on
persistent states, but cannot recover a state transition that begins and ends
between observations. Failing one confirmation preserves the entire prior
repository observation until a later successful pass.
