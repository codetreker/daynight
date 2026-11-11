# Agent Note: Windows Controller Job Ownership and Stop Receipts

Status: implemented

## Problem

A Windows Controller and an unregistered descendant can survive after the last
handle to their named Job is closed. The Job body and its temporary namespace
name have different lifetimes; a missing name therefore cannot prove that the
original execution stopped. Worker restart, lost IPC replies and Controller exit
must not turn this absence into capacity release, archive, deletion or a new
native writer. The same Controller boundary serves Task, Bot and independent
Session executions.

## Decision

A separate guardian owns the original Job handle and stays outside the Job.
Before provider startup it creates the Job, establishes kill-on-close and binds
the original Controller process instance. Versioned journal evidence records
both preparation and confirmed assignment, the exact guardian and Controller
birth identities, the guardian's original handle and the immutable ticket fence.
The Controller starts the provider only after the assigned evidence is present.

An independent stop owner verifies the original guardian process and duplicates
its original handle before asking the Controller to stop. It seals admissions,
terminates if needed, observes the same Job empty, and verifies the Controller
and the final journal's native process identities. A SQLite transaction commits
the stopped snapshot and an immutable versioned receipt against the exact
source, ticket and observed snapshot. The duplicated handle stays owned through
that commit or remains retained if safe release cannot be established. The
guardian releases its handle only after reading its matching receipt and
confirming the original Job is sealed and empty.

A receipt is checked against its original source, ticket, generation and
process evidence before recovery or archive. Legacy `nativeStopped` state,
missing names, missing guardians, identity mismatches and unconfirmed native
operations are not receipts. Losing all handles before a committed receipt
remains unknown even when kill-on-close may have terminated the members. The
journal preserves Windows provenance across platform changes. POSIX process
proof retains its own process-group contract.

The earlier [native Job API decision](../testing/2026-11-05-native-controller-job-api.md)
retains the Koffi performance rationale. This decision replaces its per-operation
handle lifetime and interpretation of a missing Job name.

## Alternatives

**Open the Job by name on each stop.** A temporary name disappears when its last
handle closes while member processes may still survive. Reusing the name also
does not identify the original object.

**Keep a handle only in the Controller or Worker.** The Controller can exit
before the Worker obtains the handle, and Worker restart can lose its handle
while the Controller or its descendants remain. An independent guardian and
exact process-bound duplication preserve ownership across either failure.

**Treat kill-on-close or missing known PIDs as a stop receipt.** Termination is
asynchronous and an unregistered descendant may still be alive. These observations
cannot replace an empty sealed original Job and completed original-process joins.

## Consequences

The guardian and source/receipt journal records add process, handle and storage
responsibility to each Windows Controller generation. Errors, cancellation and
ambiguous writes preserve the original responsibility and may prevent recovery
or cleanup until it can be reconciled. A previously recorded stop without the new
receipt is readable but does not authorize a replacement writer. Native Windows
checks must exercise the production guardian, handle duplication and actual
process termination; controlled native boundaries and other platforms cannot
establish those OS guarantees.
