# Agent Note: Contain Windows review registration fixtures

Status: implemented

## Problem

The process-supervisor registration test launches two long-running children to
prove that an attempt cannot replace its registered handle before exclusion.
On Windows, bare children select the legacy process-tree stop path. An unrelated
process can retain a parent PID from an older incarnation of the test root,
making the machine-wide inventory ambiguous and causing safe refusal. That
ambiguity is independent of the registration behavior being tested.

## Decision

The registration test launches each Windows child through the existing
`spawnWindowsReviewPhase` guardian and Job boundary, following the
[review Job ownership decision](../bug-fix/2026-11-09-windows-review-job-ownership.md).
Each phase uses the test directory, drains its output, closes input and completes
admission before registration. POSIX children retain detached process groups.

Both children remain real processes. The test retains duplicate-registration
refusal, both stop/exclude sequences, successful registration after exclusion,
and the unsafe lock state caused by the earlier conflicting registration.
Fixtures are retained before asynchronous startup so failures still reach
cleanup. Cleanup attempts every fixture, always stops each Windows phase even
after guardian exit, and joins its phase completion. Cleanup failures remain
visible after all cleanup attempts settle.

## Alternatives

**Relax the legacy ancestry or cycle checks.** An ambiguous parent PID does not
establish ownership. Ignoring that evidence would weaken production refusal
without proving which processes tree-wide termination can target.

**Use the native descendant-heartbeat fixture.** Its extra descendants, identity
files and observer prove tree termination. They add unrelated resources to a
test whose subject is registration and exclusion of two handles.

## Consequences

Windows registration coverage uses the same ownership boundary as production
review phases and requires native Job support. Production termination code and
the separate legacy refusal tests retain their existing behavior. Successful
registration coverage does not explain every earlier inventory failure or prove
that arbitrary machine-wide ancestry can be classified safely.
