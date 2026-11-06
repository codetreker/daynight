# Agent Note: Task Write Exclusion Proof

Status: implemented

## Problem

Status, automatic-execution permission and required-platform writes share task
ownership. Repeating the status-pending scenario across field-specific suites
makes its proof harder to maintain, but removing a scenario must retain its
independent execution-state and reverse-direction guarantees.

## Decision

The status session test owns the status-pending proof: both other entry points
are attempted, the status operation retains ownership, no other request is sent,
and all three gates remain closed. After confirmation it checks that the
in-progress task still closes the permission gate. The permission suite retains
its independent stale, same-value and executing checks; the platform suite keeps
permission-pending blocking a platform write, as well as its own boundaries.

## Alternatives

**Keep each status-pending scenario.** The same ownership transition would
continue to be maintained in three places, while its distinct post-confirmation
permission assertion could be maintained in the canonical scenario.

**Delete duplicate scenarios without transferring assertions.** That would lose
the permission gate proof after the status write completes. The reverse
permission-pending direction also exercises a different owner and remains.

## Consequences

The suite has one fewer test and one fewer iteration in the platform test. The
ownership assertion detects an overwritten pending operation even before the
asynchronous request admission completes. This is a maintenance change; fewer
cases alone do not establish an improvement in CI completion time.
