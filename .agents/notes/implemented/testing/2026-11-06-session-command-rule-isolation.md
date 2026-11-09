# Agent Note: Session Command Rule Isolation

Status: implemented

## Problem

A sequential command-admission test used a connected PostgreSQL Session to
exercise initial-input gates, current-turn checks and interaction replies.
Those decisions need record, Task and command facts, plus specific DAO query
results. The same test uniquely linked a timeline event to persisted
interaction-ID data and SQL duplicate detection, so its initial conversion had
to preserve both caller-owned propagation and database observations.

## Decision

Named command-admission cases invoke `authorizeCommand` with valid ordinary
Task facts. They preserve initialization, steering, cancellation, interaction
revision, advertised action, duplicate callback and unsupported-kind checks,
with positive admission cases establishing fixture validity.

Narrow `store.SessionDAO` mocks control `HasInteractionResponse` results and
errors while checking context, Session ID, operation ID, interaction ID and
expected calls. Unconfigured calls fail immediately. Independent Test Session
first-input cases separately exercise `HasOtherFirstInput`; ordinary Task cases
do not acquire the special lazy-session allowance. Query errors preserve their
original cause rather than becoming a refusal or an empty result.

The initial split kept a focused PostgreSQL timeline-upsert, Submit,
operation-readback and duplicate-callback witness. It protected interaction-ID
propagation and real duplicate detection while the admission rules were
converted independently.

The [complete Session isolation decision](2026-11-08-session-test-dao-mocks.md)
replaces that allocation: Session mocks inspect the interaction ID and other
proposed operation arguments, and Store witnesses own SQL mapping and duplicate
queries. Durable dispatch, receipts, expiry, reconciliation and transaction
outcomes retain their upper-layer scenarios with configured DAO dependencies.
The [test guide](../../../../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns usage and the complete database-independent Session command.

## Alternatives

**Keep one sequential integration matrix.** It mixed unrelated rule states and
query outcomes, required PostgreSQL for every rule edit, and made DAO argument
or error behavior harder to inspect independently.

**Replace the entire original test with DAO mocks.** Direct DAO tests inserted
valid summaries themselves and could not detect a caller that stopped copying
the interaction ID from the timeline or command into persisted operation data.
The initial focused integration witness retained this oracle; complete isolation
uses an explicit write-argument check alongside Store's SQL witness.

**Implement an in-memory Session database.** The admission rules need only two
query contracts, so a persistence simulator would add behavior needing its own
validation. Narrow expected-call mocks expose facts and unexpected access.

## Consequences

Rule matrices execute without PostgreSQL and verify exact query calls and error
chains. Their ordinary Task and independent Test Session fixtures prevent
Session-kind shortcuts from hiding admission errors. The complete proof scope
initially retained one database setup; its historical cost does not describe
the current Session suite.

Source-bound fault probes compare original and isolated rule behavior.
Validation distinguishes pure-rule feedback, Store-owned database observations
and the full module gate; a local rule timing does not establish whole-job
savings.
