# Agent Note: Project and Task CLI Design

Status: implemented

## Problem

Developers need terminal access to the service's projects and dependency-gated
tasks. Repeated explicit project IDs interrupt repository work, while Git
transport addresses can spell the same hosted repository in different ways. A
remembered project ID alone cannot distinguish different servers or a changed
repository origin. When this design was adopted, the service already exposed
these APIs and the client had no project or task commands.

## Decision

The adopted [requirements](../../../../docs/spec/daynight-project-task.md) and
[design](../../../../docs/design/daynight-project-task.md) define independent
`project` and `task` command modules in the existing client package. Shared
configuration, bounded HTTP, repository bindings, `project create/list/show`,
task create/list/show/update/graph and shared syntax integration were delivered
through [PR #55](https://github.com/codetreker/daynight/pull/55), including local
and hosted installed CLI acceptance against the Go service and default
production-budget probes. The
[CI efficiency decision](../testing/2026-10-21-ci-validation-efficiency.md)
subsequently replaces real wall-clock deadline waits with short test-only
budgets while preserving production defaults and full byte-limit probes. The
[bounded ready selection decision](../feature/2026-10-21-bounded-ready-task-selection.md)
extends the original complete-list operations with `task ready` single-page
candidate selection while preserving `task list --ready` traversal.

The global YAML has an additive `serverUrl` origin and an optional `serverToken`
under the [credential decision](../../implemented/architecture/2026-10-22-cli-server-credentials.md). Shared
document reading and command-specific validation preserve the existing review
fields and state locations. A URL-only configuration remains valid; a configured
token is validated with its transport and attached to existing API requests.
Help, update and review retain their independent execution requirements. The
[command composition decision](2026-10-20-client-command-composition.md) remains
the owner of lazy command dispatch. Its original source reorganization preserved
the existing YAML; this design adopts additional configuration without moving
those fields or introducing a review-data migration. The original client design
required global configuration to exist before execution. The
[guided setup decision](../feature/2026-10-21-guided-configuration-setup.md) first
replaced that prerequisite with interactive service/review guidance. The
[device-login decision](../../implemented/architecture/2026-10-25-cli-device-login.md) now defaults an absent
service origin to `https://daynight.cc` and uses explicit login/logout for ordinary
access. Service calls without a local credential fail before dispatch with login
guidance. The later
[top-level setup removal decision](../../implemented/simplification/2026-10-25-remove-top-level-setup.md)
uses existing YAML fields for external test-service and automation provisioning.
Invalid configured values remain errors. Login/logout share one origin/token
concurrency observation; external provisioners must pair credentials with the
intended origin and remove or replace old tokens when changing services. Credential-bearing configuration uses POSIX `0600`, while the prior
file-mode behavior remains for files without a token. Project definitions share
parameter syntax with help and shell completion. Help and argument validation
finish before the shared server runtime is loaded. Project creation takes one
required positional name and an optional `--repo` option. The
[repository-discovery correction](../bug-fix/2026-10-21-project-create-repository-discovery.md)
partially supersedes the original requirement to supply `--repo` and immediately
register the requested project. That original contract kept project operations
independent of working-directory discovery. Creation now infers the current
worktree's effective origin only when the option is omitted, and both forms
compare canonical repository identities across the complete project list before
creating. Zero matches sends the original name and address; one match returns
the unchanged existing project; multiple matches fail with their IDs. Its
definition permits `--` to end option
parsing, preserving leading-dash names as `project create --repo <repo> -- -name`.
Names containing spaces remain one quoted argument. The syntax parser checks
positional presence, empty strings and declared choices; command-owned text
validation retains the Unicode rules without trimming the name. Listing reads all projects, and details
use an explicit UUID. List, show and explicit-repository creation do not inspect
the working directory. Project operations do not read or change repository
bindings or ignore rules.

The repository foundation resolves explicit project selection for one invocation,
including outside Git. Otherwise it reads the current worktree's effective
origin, compares normalized identities, and discovers a project through the existing paginated
API. Zero matches is an error; multiple matches require an explicit selection.
The selected project is saved in ignored `.daynight/project.yml` at the current
worktree root, together with server origin and repository identity. A validated
existing binding remains selected if another project later shares the repo.
Server or repository changes require discovery again. Local persistence and the
root ignore rule must succeed before a task mutation. Metadata uses an exclusive
PID/token lock and verifies its owned file before release. Existing locks fail
without waiting; stale files require manual removal only after confirming that
the writer has stopped. A PID check followed by unlink is not an atomic
compare-delete operation, so it cannot safely reclaim a replaced lock. Shared
atomic file replacement serves configuration, ignore and metadata writes.

One client normalization function processes both Git origin and server URLs.
Conventional HTTPS, default-user Git SSH and SCP addresses share a hosted repo
identity. Path case, unusual SSH contexts, aliases and nondefault ports retain
meaningful distinctions. The service keeps its raw registered address and its
existing API, schema, duplicate-project allowance and transaction policies.

The adopted task composition uses the shared command schema and server runtime.
Description values declare `allowEmpty`, list and setter status values declare three fixed
`choices`, and dependency options declare `repeatable`. Generic update no longer
declares status. The [status assignment decision](../../implemented/architecture/2026-10-24-task-status-assignment.md)
owns todo creation and the dedicated set-status command, shared exact versions,
same-state +0 and actual-change +1. Repeatable values form an ordered
array from the first occurrence, retaining duplicate IDs for server validation.
Text options accept inline assignment split at the first equals sign, preserving
leading dashes and later equals signs. Separated dash-prefixed values remain
invalid; directory, switch and help options reject inline assignment. These
syntax facts belong to the definition consumed by parsing and static shell
completion. Help uses the declared names, value names, required markers and
option descriptions; it does not enumerate `value.choices`. Existing review directory syntax remains unchanged.

Task metadata updates retain expected-version checks, atomic field/dependency
updates and server-side state gates. Lifecycle actions use the same shared
configuration, repository resolution, int64 version handling and mutation output;
explicit versions skip a pre-read, and omission performs one immediate read. Local binding checks
cannot replace remote resource validation. Request cancellation and failures remain visible; failed
writes are not automatically retried. Project and task `list` JSON is emitted
only after every matching page has succeeded. `task ready` returns up
to its requested limit, defaulting to 10, after one validated task response; it
accepts decimal limits from 1 through 100 and does not follow a valid cursor.
The ready operation preserves full task resources and the service
`createdAt ASC, id ASC` order, validating count, eligibility and distinct IDs
before output. Whole-command deadlines and response-byte budgets bound complete
scans; reaching a limit fails without partial output,
while an already-sent write can still have an unconfirmed outcome. The HTTP
foundation uses one disposable operation for shared deadlines and byte counters,
strict response DTOs, complete opaque-cursor traversal for list operations and
an explicit `listReadyTasks` operation for bounded selection. Task versions use
`bigint` internally and retain JSON numeric int64 precision on the wire. Bounded
response cleanup preserves both the original failure and cleanup errors.

The shared server runtime starts that operation before home/configuration I/O
and passes its cancellation signal into configuration reading. It supplies one
API client and operation to a callback. Metadata callbacks return a fully
rendered string, written once after the final cancellation/deadline check. The
[attachment CLI decision](../feature/2026-10-21-task-attachment-cli.md) extends that
original text-output contract with streamed bytes and a void callback result.
SIGINT, SIGTERM and Windows SIGBREAK cancel the same lifetime. Completion first
closes any owned binary output helper, then removes owned signal listeners and
disposes timers without removing other consumers' listeners. The JSON metadata
budgets, exact task versions and refusal of partial metadata output remain unchanged.

The original design used complete labeled resource blocks for all project and
task human output. This kept every resource field available in the terminal
without column-width assumptions, with space proportional to total field content.
The [task-list defaults decision](../../implemented/feature/2026-10-22-task-list-defaults.md)
partially supersedes that output choice: task list presents operational fields
and defaults to unfinished work in a stable activity/readiness order. Task show,
ready, create and update still use complete resource blocks. The
[JSON description decision](../../implemented/simplification/2026-10-22-task-list-json-description.md)
partially supersedes the original full-resource list JSON choice: task-list JSON
omits only description, while the API DTO and show/ready JSON remain complete.
The original choice gave scripts every field without a detail query; inventory
now preserves all other fields and retrieves descriptions through task details.
A shared terminal helper escapes controls and
line separators while preserving ordinary Unicode. JSON uses the original API
values. Shared text predicates match the Go Unicode White_Space
rule rather than JavaScript trimming, so FEFF-only names remain valid and
NEL-only names remain invalid; validation never rewrites the supplied text.

## Alternatives

**Add a separate positional text kind to bypass trimming for names.** Named text
values already preserve their characters before domain validation. Giving only
some positional arguments that treatment creates two validation policies for
the same raw input. The syntax layer checks presence and choices; each command
owns its semantic validation before I/O, including review's whitespace-only
remote refusal. Explicit per-command terminator metadata preserves review's
existing syntax while allowing project names to begin with a dash.

**Require explicit project selection for every task command.** This avoids local
state and discovery but repeats server identifiers during ordinary repository
work. Explicit selection remains available as the per-invocation override.

**Keep a manually configured project ID as the normal repository binding.**
This can choose among duplicate projects, but creates an extra setup step even
when the remote repository identifies one project. Successful automatic
discovery records the association instead.

**Compare raw repository URL strings.** This keeps parsing small but makes the
confirmed HTTPS and SSH spellings fail to match. A shared identity function
provides a precise equality rule without changing the stored server address.

**Put the server address in separate URL and port fields.** This creates two
sources for the port and requires precedence or conflict rules. A single full
HTTP(S) origin expresses the endpoint and is stored with the local binding.

**Add a server repository lookup endpoint and persisted canonical identity.**
This can avoid a first-discovery scan but changes the server API and stored data
for a client capability already supported by complete project pagination. The
client owns one comparison function and preserves explicit ambiguity handling;
a future server lookup must retain those equality and duplicate semantics.

**Automatically reclaim metadata locks using PID or age checks.** A read/check
followed by unlink can delete a new writer's replacement lock. A separate
reclamation guard would itself need manual crash recovery. Retaining existing
locks matches the configuration writer's fail-fast model and keeps ownership
errors explicit without loading SQLite or the review runtime.

**Pad every project into aligned columns.** A single long name can multiply the
maximum width across every result row, producing output much larger than the
resource content. Complete labeled blocks preserve all fields with linear
rendering space and do not depend on terminal display-width assumptions.

## Consequences

The confirmed design remains distinct from complete feature delivery. Project
commands join review, update and shell completion. Their compiled entry point
is verified against controlled HTTP responses and the delivered Project command
passed native CI. That evidence does not establish real Go/PostgreSQL CLI
integration. Task composition and the shared syntax pass local module, compiled
entrypoint, real-shell and native CI checks, with exact-head review. Installed
service acceptance follows the
[acceptance decision](../testing/2026-10-20-installed-project-task-acceptance.md);
its native and Go/budget paths preserve all existing suites and production limits.
Shared configuration, HTTP, repository and server-runtime modules support that
remaining
work. Package versions follow the existing release rules.

Project creation uses `project create <name> [--repo <repo>]` in help, examples and
generated completion. The removed `--name` option is an argument error. Existing
shells must reload generated completion after installing the new package to use
the same grammar as execution. Repository inference reuses the Git discovery
mechanism without task binding persistence. Creation preflight costs a complete
project scan and preserves lookup errors; it does not provide atomic uniqueness
against concurrent creators or change the service's duplicate-project allowance.

The implemented repository resolver can infer a repository's project after one
complete discovery and then validate it by ID. The cache remains disposable and
scoped to server, repository and worktree. Automatic resolution can create the
ignored local binding even when preparing a query; remote project/task data
remains in the service. Task command composition finishes that preparation
before mutation. Cache and ignore failures remain errors, and corrupt records
are reported rather than silently discarded.

Discovery costs a complete project scan, and pagination is not one cross-request
snapshot. Cached selection intentionally remains stable after later duplicate
projects appear. Additional lookup capabilities can be introduced later without
replacing the cache format if they preserve the same identity and ambiguity
rules. Arbitrary SSH alias equivalence needs a separate mapping decision;
transport context must not be erased to infer it. Remote authentication, deletion
and task ownership were outside the original design and required their own
service contracts. [Retained task deletion](../../implemented/feature/2026-10-25-task-soft-deletion.md)
now extends the same exact-version command pattern; project deletion remains
unavailable.
