# Agent Note: Claude Lifecycle Fixture Cleanup

Status: implemented

## Problem

The Claude lifecycle integration fixture owns a helper, native process proofs,
and a provider event pump. On Darwin, a native process can be exiting while its
command identity is incomplete. A single proof inspection then refuses the
observation, even though the process may subsequently stop. An early cleanup
failure can also skip the remaining fixture resources.

## Decision

The fixture treats an exiting observation as a reason to wait for the original
process to stop, never as authority to signal or as proof of completion. It
observes the helper's close, the recorded native processes and the provider
pump within bounded cleanup. Cleanup failures are retained while other owned
resources are settled. The original admission and version-probe assertions and
the production process identity rules remain in force.

A token-authenticated fixture control connection addresses the original native
process without signaling a reusable PID. The fixture's ordinary query with the
pinned Claude SDK uses one native transport; a second proof is an explicit
failure and is still observed. The helper closes its IPC end during fixture
shutdown so Node can report the actual ChildProcess close.

## Alternatives

**Treat exiting as stopped.** The process has not completed and its incomplete
identity cannot establish a safe stop or authorize a signal.

**Signal the numeric PID after an uncertain observation.** The PID can be reused;
an incomplete identity cannot authorize a signal to its current occupant.

**Stop at the first join failure.** A native proof can arrive after that failure,
so the fixture must continue observing and settling its owned processes.

**Ignore cleanup errors after the test assertion.** A passing admission assertion
does not prove that the helper, native process, pump and fixture were released.

## Consequences

Controlled observations exercise the intermediate state, late proof and
replacement refusal without changing production process proof behavior or CI
deadlines. The one-transport observation depends on the pinned SDK and fixture
options; SDK changes require reevaluating it. Cleanup reports unconfirmed
completion and other failures instead of inferring success from an unavailable
identity. The delayed admission case observes a generic provider pump failure
whose cause is not available in the provider's error.
