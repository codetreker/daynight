# Agent Note: Session Command Rule Isolation

Status: implemented

## Problem

A sequential command-admission test used a connected PostgreSQL Session to
exercise initial-input gates, current-turn checks and interaction replies.
Those decisions need record, Task and command facts, plus specific DAO query
results. The same test also uniquely linked a timeline event to persisted
interaction-ID data and SQL duplicate detection, so replacing its whole path
with a mock would remove an integration oracle.

## Decision

Named command-admission cases invoke `authorizeCommand` with valid ordinary
Task facts. They preserve the original initialization, steering, cancellation,
interaction revision, advertised action, duplicate callback and unsupported-kind
checks, with positive admission cases establishing fixture validity.

Narrow `store.SessionDAO` mocks control `HasInteractionResponse` results and
errors while checking context, Session ID, operation ID, interaction ID and
expected calls. Unconfigured calls fail immediately. Independent Test Session
first-input cases separately exercise `HasOtherFirstInput`; ordinary Task cases
do not acquire the special lazy-session allowance. Query errors preserve their
original cause rather than becoming a refusal or an empty result.

A focused real-PostgreSQL test retains the unique timeline-upsert to Submit,
operation readback and duplicate-callback path. Readback confirms the accepted
operation, and SQL-backed rejection of a different operation/submission protects
the interaction-ID mapping stored by Submit. Existing durable dispatch,
receipt, expiry, reconciliation and transaction tests remain unchanged.

The [test guide](../../../../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns usage and the shared mock policy. Rule selections can run without a database
URL; the preserved integration witness still owns a real fixture.

## Alternatives

**Keep one sequential integration matrix.** It mixes unrelated rule states and
query outcomes, requires PostgreSQL for every rule edit, and makes DAO argument
or error behavior harder to inspect independently.

**Replace the entire original test with DAO mocks.** Direct DAO tests insert
valid summaries themselves. They cannot detect a caller that stops copying the
interaction ID from the timeline/command into persisted operation data. The
focused integration witness retains that mapping proof.

**Implement an in-memory Session database.** The rules need only two query
contracts, so a full persistence simulator adds ownership and behavior that
would itself need validation. Narrow expected-call mocks expose the required
facts and unexpected access directly.

## Consequences

Rule matrices execute without PostgreSQL and can verify exact query calls and
error chains. The complete proof scope still includes one real database setup;
this split alone does not establish a fixture-count or whole-job reduction.
The focused witness and ordinary rule facts prevent SQL mapping or Session-kind
shortcuts from being hidden by mocks.

Source-bound fault probes compare the original and isolated rule behavior.
Validation records distinguish pure-rule feedback from the retained integration
cost and the full module gate.
