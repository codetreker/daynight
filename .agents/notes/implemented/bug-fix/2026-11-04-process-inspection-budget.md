# Agent Note: Separate process inspection from termination grace

Status: implemented

## Problem

The process supervisor originally reused termination grace as the native `ps`
command timeout. The default five-second value served both roles, but shorter
grace configurations also reduced the time available to launch and inspect the
host process table. A status query could therefore fail before the supervisor
had established whether a managed group was executing, even though its signal
and closure policy was otherwise valid.

## Decision

POSIX process-table queries have a private fixed 5000ms command budget, matching
the existing production default. Termination grace continues to govern the
TERM/KILL polling thresholds and direct-child closure wait. Its configured value
and the Windows taskkill path are unchanged. No public timeout option is added.
Inspection or parsing errors still retain unsafe state and their original causes.

A native regression delays the first inspection before TERM and then forwards
the exact arguments to the real `ps`. The delay exceeds the fixture's short grace
but stays within the inspection budget. Native process-group termination,
descendant heartbeat, stream closure and exclusion remain part of the proof.
An inspection-failure regression retains the cause and prevents safe exclusion.
Fixture cleanup independently terminates only its recorded native group and
awaits a pre-registered close promise; retrying a memoized failed stop cannot
serve as cleanup.

The [review design](../../../../docs/design/daynight-review.md) owns the process
and lock lifecycle. Production runtime factories retain their existing defaults.

## Alternatives

**Use termination grace for every native command.** That couples host observation
latency to the signal-wait policy. The two values happen to share the default
number, but reducing one should not make inspection invalid.

**Increase the fixture's termination grace.** This avoids the short query budget
by changing the behavior under test. Keeping short grace and testing a slower
first observation directly distinguishes the two phases.

**Use production defaults with a test-only wall-clock offset.** That can shorten
native grace waits, but adds clock orchestration and does not guard the semantics
of a shorter configured grace. A separate inspection budget fixes the coupling.

**Expose a configurable inspection timeout.** There is no second production
policy requiring an operator setting. A private constant preserves the established
default without expanding the interface.

## Consequences

Default production timing values are unchanged. Short-grace callers no longer
also receive an incidental short inspection timeout. Grace is a signal-wait
threshold, not a hard total stop deadline: an in-flight bounded query can run
past the threshold before escalation is considered. This was already possible
under the default budget and remains explicit.

Real native fixtures verify slower observation and failed inspection without
substituting fake process tables. Failed tests must still kill and join only
their owned processes. A strict overall stop deadline would need a separate
lifecycle design and is outside this repair.
