# Agent Note: User-owned assistant task persistence

Status: implemented

## Problem

Assistants need to share responsibility, procedures, observations and unanswered
questions without starting another project execution. A responsibility change
must preserve existing work while fencing the previous holder. Independent
resource writes cannot preserve a proposal decision and its manual version, or
a transfer and every unfinished item's follower, through concurrent deletion,
pausing, expiry or lost commit confirmation.

## Decision

The [assistant task service](../../../../docs/design/assistant-task.md) owns a
separate user-scoped model, DAO contract, PostgreSQL implementation and REST
module. Core owns decisions and application rule validation. Service binds all
participants to one transaction and interprets its explicit completion outcome.
The [credential ownership decision](2026-11-12-assistant-task-claim-contract.md)
continues to own token preparation, pending transfer and immutable receipts.

Credential and Bot shared locks preserve authorization and deletion barriers.
The task row protects decisions combining claim state, pause/delete state,
manual versions and related materials. Actual writes still carry their expected
version and claim predicates. Creation uses a task-ID advisory lock because no
row exists yet to serialize the first definition, its fingerprint and manual.
These short transactions do not include Session sends or other network work.

Database time is observed after waits and checked again before the callback
allows completion. Receipt admission time describes that transaction's decision,
not the exact commit instant. Record ordering uses the database clock under a
task-owned head, without synthesizing future timestamps.

Application rules enter through a registry; an unregistered application accepts
only empty rules. Question deadlines are evaluated lazily by reads and event
pulls. The module exposes persistent facts without adding a scheduler, invoking
a native Provider or implementing Watchdog policy.

Open inquiries retain their original target when responsibility changes. The
current holder may answer them, with a separate `answerBotId` identifying the
actual author. This preserves the question's history without presenting the
receiving assistant's answer as a statement by the previous target.

## Alternatives

**Reuse project Tasks, claims and Threads.** Those resources represent project
execution and Worker scheduling. Their lifecycle and authorization would couple
continuing assistant responsibility to execution slots and unrelated completion
states. Independent resources preserve the assistant task's user ownership.

**Only compare a child row's version.** A proposal or record version does not
protect its parent's pause, deletion, manual basis or lease. A task-row barrier
protects the shared mutable facts and the multi-table write, while SQL conditions
retain explicit expected-value admission.

**Run a new server scheduler for question expiry.** The required timeout can be
derived from a stored deadline during the reads consumers already perform.
Lazy completion avoids adding leader election and service lifetime work, while
database state filters and conditional transitions prevent repeated notices.

## Consequences

Ownership changes preserve item and external operation identities. Historical
claim receipts remain readable independently from current responsibility until
task deletion. Unknown completion can stop a client pending readback; it cannot
be converted into a guessed rollback or a replacement request.

Writes to one assistant task serialize across its materials and claim. This
keeps compound authorization and deletion atomic, at the cost of contention
within a busy task. Queries stay bounded and ordinary reads do not take the
task's exclusive write lock. Expiry notifications require a subsequent read or
pull and are not a proactive server push.

HTTP and service tests establish protocol and coordination behavior. Real
PostgreSQL tests own locks, time and persistence, and API integration owns the
normally assembled request chain. These do not establish cross-Worker token
files, native assistant execution or the Watchdog evaluator.
