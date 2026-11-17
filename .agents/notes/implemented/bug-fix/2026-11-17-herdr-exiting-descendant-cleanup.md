# Agent Note: Herdr Exiting Descendant Cleanup

Status: implemented

## Problem

An unregistered POSIX descendant can enter an exiting state between cleanup's
inventory and identity capture. It cannot provide a running proof, but failing
immediately prevents workspace closure even when the remaining owned tree can
still be established. A vanished parent alone does not establish that its
children have stopped.

## Decision

Cleanup recognizes a typed `Z` or Darwin `E` acquisition and discards that
inventory pass. It rebuilds ownership from live original proofs within the same
operation deadline. It durably retains unresolved candidate responsibility
across calls; stopping cannot be confirmed while that responsibility is pending.
Previously observed related processes still present need an original birth proof;
the exiting candidate is never a proof or anchor. Its PID appearing again is
ambiguous and fails. Required receipt proofs, freeze and stop gates remain in
force. Re-observation failures retain the exiting observation and their cause.

## Alternatives

**Skip the exiting PID and continue the old inventory.** Its descendants could
be enrolled through an unverified parent or missed after reparenting.

**Treat a later matching PID as the same process.** POSIX `lstart` has only
second precision and cannot exclude reuse in that interval.

## Consequences

Cleanup can proceed when a fresh inventory closes the remaining ownership chain.
It still fails closed for ambiguous descendants and PID reuse. Inventory cannot
establish ownership of descendants never observed before their parent exits.
