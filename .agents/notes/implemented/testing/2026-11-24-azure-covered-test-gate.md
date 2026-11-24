# Agent Note: Verify Azure Tests in the Covered Module Run

Status: implemented

## Problem

PR CI runs real Azure storage and startup tests in the complete covered module
invocation, then repeats the same tests in separate Go commands. Recompilation
and the repeated real storage operations extend the critical path. A successful
module result alone does not prove that these environment-dependent tests ran:
Go can report success when tests or their subtests skip.

## Decision

The PR Go module job checks the completed raw JSON capture from its one covered
invocation for the actual Azure package and test identities. It requires one
successful package execution and one passing execution of each required test,
including the image integrity subtests. A skip or failure under a required test,
conflicting or missing events, an ambiguous run directory, or incomplete capture
fails the gate. The job starts with an empty module evidence directory so the
gate cannot use a previous invocation. The existing Azurite service and module
coverage, discovery and validation remain in place. The
[raw capture decision](2026-11-11-go-test-failure-evidence.md) owns the marker
and stream contract.

Main CI retains its separate Azure commands, and local restart verification
retains its preserve and reopen environment. The
[server validation guide](../../../../packages/daynight-server/README.md#validate)
describes these entry points.

## Alternatives

**Keep all separate PR commands.** They exercise the same tests and environment
again, but retain the extra time on the module job's critical path.

**Trust the module job's success alone.** It does not distinguish a real Azure
execution from a skipped test, and a passing parent can contain skipped subtests.
Checking explicit test identities and descendants preserves this distinction.

## Consequences

The PR gate relies on the test identities and capture protocol; an intentional
rename or additional image subtest requires reviewing the gate. The gate rejects
skipped descendants and requires the existing image subtests explicitly. The
separate main and local restart checks continue to cover their own contracts.
Hosted job duration varies with runner conditions, so a single timing does not
establish a fixed saving.
