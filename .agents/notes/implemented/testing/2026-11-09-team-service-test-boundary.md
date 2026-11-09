# Agent Note: Team Service Test Boundary

Status: implemented

## Problem

Team service tests opened PostgreSQL and prepared identities and domain data to
observe service orchestration. The same scenarios also exercised core lifecycle,
member and invitation decisions, SQL lock waits and persisted rollback. Removing
database preparation alone would still execute lower rules in service tests;
removing those assertions would lose the independent rule and storage proofs.

Read and write completion have different public result contracts. A generic
suppression rule could erase an allocated creation identifier or change the
result/error pair returned by invitation inspection and listing.

## Decision

`Teams` holds private, instance-owned `teamOperations` functions for directly
invoked Team admission, business and Webhook eligibility operations. `NewTeams`
binds them to the production core implementations and retains `time.Now` as its
default clock. Unit fixtures supply independent typed domain results, errors and exact call
plans. Shared models, core result types, canonical-ID
and query helpers, `completion.Capture`, `completed` and `core.WriteFault` remain
real mechanisms; the fixture does not simulate core state or a Store.

The service still executes its actual snapshot, creation and Team write
callbacks. Tests observe principal, raw metadata, canonical IDs, context, clock
capabilities, transaction-bound DAOs, required order and call counts. Operation
results, callback errors, completion outcomes and cleanup failures are separate
facts. Unexpected calls fail, and the ordinary test binary clears database and
UniAuth fixture variables. A supplied committed outcome or a recorded operation
call does not establish persistence.

`completion.Capture` stages domain refusals until scope completion. Completion
errors and unconfirmed write outcomes take precedence over those refusals.
`Create` returns a zero Team on failure and retains only a nonempty allocated
identifier in `CreationError`, preserving the original cause chain. The
identifier does not establish that creation committed or that the Team exists.

`List`, `Get`, `Members`, `MembersPage` and `Member` suppress their returned data
when the snapshot fails. The latter four stage core domain refusals until the
snapshot completes. `InspectInvitation`, `ListInvitations` and
`ListInvitationPage` instead preserve their produced result alongside a later
snapshot error; successful lower work can therefore leave a nonzero result with
an error. Missing-refusal paths produce zero data because the inspection did not
succeed, not because every invitation read suppresses data after completion
failure. These existing method contracts remain distinct.

Invitation acceptance validates the actor, completes a read snapshot to obtain
the Team ID, then independently enters that Team's write scope. The write
callback calls core acceptance against its current Team DAO and refreshes
eligibility only after success. It does not reuse the read invitation as a
locked write-phase fact. Delete and member changes follow the same mutation-then-
refresh order, using the write scope's eligibility capability. Filters remain
Team owner for deletion, target user for member changes, and current user for
acceptance. Lower failures prevent refresh, and completion/cleanup retain their
error precedence and chains.

Each independent proof remains with its implementation owner:

| Owner | Retained proof |
|---|---|
| [Team service](../../../../packages/daynight-server/internal/service/team/) | Admission/scope order, exact operation inputs and capabilities, snapshot/write completion, result contracts and eligibility orchestration |
| [Core Team lifecycle](../../../../packages/daynight-server/internal/core/team/lifecycle_test.go), [read pages](../../../../packages/daynight-server/internal/core/team/read_page_test.go) and [invitation pages](../../../../packages/daynight-server/internal/core/team/invitation_page_test.go) | Permission, personal/nonempty deletion, version/name priority, complete no-op results and int64 limits, last-admin removal, page scope, invitation state and clock sampling after the invitation lock; forbidden downstream calls fail |
| [Identity personal-Team lookup](../../../../packages/daynight-server/internal/service/identity/personal_team_id_test.go) and [core personal Team](../../../../packages/daynight-server/internal/core/team/personal_test.go) | `PersonalTeamID` ownership facts and personal-Team bootstrap/integrity, separate from Team service orchestration |
| [Core Webhook eligibility](../../../../packages/daynight-server/internal/core/webhook/eligibility_test.go) | Orphaned subscribed-Project eligibility errors abort refresh, preserve the cause and do not revoke authorization |
| [PostgreSQL Team scopes](../../../../packages/daynight-server/internal/core/store/postgres/team_test.go), [members](../../../../packages/daynight-server/internal/core/store/postgres/team_members_test.go) and [invitations](../../../../packages/daynight-server/internal/core/store/postgres/team_invitations_test.go) | Actual waiting transactions read current actor/AdminCount and invitation consume/revoke facts; member addition and failed consume roll back together, with a subsequent same-token write and fresh readback; orphan eligibility failure rolls back Team-member removal with fresh membership and subscription state/epoch readback |
| [PostgreSQL Team query contracts](../../../../packages/daynight-server/internal/core/store/postgres/team/query_contract_test.go), [invitation contracts](../../../../packages/daynight-server/internal/core/store/postgres/team/invitation_contract_test.go) and [eligibility](../../../../packages/daynight-server/internal/core/store/postgres/eligibility/eligibility_test.go) | Exact raw Unicode metadata and joined page facts, invitation metadata and the current expiry field after an invitation lock wait, orphan selection and real SQL error causes |
| [PostgreSQL Team query failures](../../../../packages/daynight-server/internal/core/store/postgres/team_query_test.go) | The six existing DAO query trace targets retain cancellation/error propagation; actual missing-table reads retain PostgreSQL `42P01` and reject an empty successful page |

Store receivers call the actual DAO and transaction mechanisms; they do not
reconstruct last-admin or invitation acceptance algorithms. Core receivers
execute those decisions over controlled DAO facts. Normal assembled Team flows
remain in API integration, with abnormal rule and storage matrices at their
module owners. Public behavior, supported inputs, production time defaults and
validation gates retain their existing contracts.

The [Go dependency decision](2026-11-08-go-test-dependency-boundaries.md) owns the
common direct-operation policy. The [service guide](../../../../packages/daynight-server/README.md#team-service-tests)
owns the focused command and environment requirements.

## Alternatives

**Retain PostgreSQL fixtures for service orchestration.** They supply stored
facts but repeat identity, schema and core preparation for callback/completion
behavior. Actual SQL, locking and rollback remain necessary in their Store
owners.

**Use DAO mocks beneath the real core operations.** This removes the database
but leaves core rule execution in service feedback and makes an orchestration
failure depend on lower business decisions. Direct operation bindings expose the
service's actual inputs and supplied lower outcomes.

**Apply one result-suppression policy to all reads.** This would change
invitation inspection/listing results after a successful lower operation and a
later snapshot error. Method-specific completion assertions preserve the
existing public contracts without a uniform read wrapper.

## Consequences

Team service feedback runs without database or authentication preparation.
Private operation slots need default constructor coverage and strict argument,
identity and unexpected-call assertions. Core/Store tests still execute the
lower rules and physical work; that work remains part of complete validation.

The orphan eligibility receiver observes a read-only integrity error after an
actual Team-member mutation and verifies rollback. It does not alone distinguish
an eligibility DAO bound to a different transaction. Service capability-identity
assertions separately verify the scope passed to the lower operation. Query
trace cancellation proves the targeted DAO call and retained failure; it does
not assert that an already-running SQL query was cancelled.

Source-bound evidence owns runtime measurements, matched fault comparisons and
any stronger assertions that did not exist in the original tests. Package speed,
test counts and coverage alone do not prove preserved detection or an equal
reduction in complete-command or hosted CI time.
