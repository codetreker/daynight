# Agent Note: Controller Test Session Ownership

Status: implemented

## Problem

Repeated Session View testing needs a real local Agent and a reachable browser
view without preparing a scheduled task. A separate demo UI would not exercise
the product's interaction, receipt and recovery behavior. Existing session
identity and authorization assume a task claim, so bypassing that assumption
would weaken task isolation or invent ownership that does not exist. A temporary
grant-renewal or local IPC transport failure also says nothing about the health
of the native process; unwinding supervision on that failure can stop an
otherwise valid loop. Losing an input response cannot distinguish a request that
never arrived from an input already accepted by the provider.

## Decision

The public `daynight controller <provider> [options] [prompt]` command owns a
foreground test execution in the current directory and prints an authenticated
Daynight Test Session URL. Worker-issued `--launch-id` execution remains a
separate, mutually exclusive entry path. Test execution does not select or alter
worker configuration and is not a third task control mode.

Task and Test use one session data plane and one UI. Their bindings are explicit
and mutually exclusive: a task claim or a test execution identity. Task access
continues to require the project and current claim; Test access requires its
creator and a valid credential. History, resources, operations and subscriptions
apply the same scope checks. A URL does not grant access, and Controller grants
never appear in it.

A no-prompt Test session records `not_required`, rather than a fabricated
successful initial send. Claude does not expose a verified native identity before
its first real message, so this Test branch can accept that first message only
after the provider handle is ready and the relay synchronized. Task input gates
remain intact. Native evidence establishes the identity; unknown operations do
not authorize replacement sends.

The foreground launcher owns registration intent, grant renewal and bounded
shutdown with process proof. Closing the browser does not stop the native loop.
The user owns the current directory, which the launcher never removes. Test
execution does not add a background daemon, automatic recovery scheduler or
arbitrary native-session adoption.

After native startup, transient renewal failures remain within supervision and
retry with exponential delay capped at 30 seconds. HTTP 408, 429 and 5xx or a
transport failure retain the execution, initial operation and current credential;
a successful renewal replaces only that credential. Explicit shutdown and
definitive authorization or protocol failures retain the bounded stop path. The
relay requires a current connection grant before native dispatch, so expiration
does not authorize further native calls while renewal is unavailable.

Local IPC distinguishes transport uncertainty from explicit rejection or invalid
response identity. After an uncertain initial-input response, supervision keeps
the original operation identity and observes the Controller without resubmitting
that input, even if a later snapshot says `not_submitted`. Transient observation
failures after startup do not prevent credential renewal. Actual child exit,
definitive rejection and user cancellation still follow the bounded stop path.
Frame admission ends after a complete authenticated request; native acceptance
uses a separate bounded response wait. Releasing that waiter cannot cancel the
already-dispatched native operation.

An unstarted registration can be archived with `never_started` only before any
spawn attempt. The service also requires an unused grant and no connection or
native identity evidence. Failed process ownership cannot be replaced with this
claim; uncertain stopping remains explicit.

Shared provider failures close the Controller so its owner can perform the
appropriate stop or recovery. Task cleanup admits only newly recorded cleanup
interactions after the service's freeze boundary. This preserves the ability to
approve cleanup without reopening ordinary task input. Timeline truncation
preserves Unicode scalar boundaries, and collapsed tool details are mounted only
when opened so receipt updates do not repeatedly render hidden output.

The public behavior is defined in the [Test Session requirements](../../../../docs/spec/controller-test-sessions.md).
The shared [session design](../../../../docs/design/task-session-protocol.md)
owns protocol and lifecycle mechanisms. This extends the independent
[task mode decision](2026-10-27-task-session-mode-contract.md) without changing
why Herdr and Web are selected before task execution.

## Alternatives

**Expose a worker test command.** Worker denotes task discovery, claim ownership
and workspace preparation. The user chose Controller to make direct session
ownership explicit and avoid implying those scheduling responsibilities.

**Create placeholder tasks or fake claim identifiers.** This would make a test
look like a scheduled execution while requiring task setup or weakening its
claim checks. Explicit Test ownership avoids that mismatch.

**Build a separate test relay and copied UI.** It could start quickly, but each
fix would need two implementations and test results would not establish product
behavior. The independent page therefore adapts identity and API binding only.

**Require a native ID before the first no-prompt input.** That would deadlock an
empty Claude session. The limited Test initialization rule keeps native identity
honest without pretending that initialization accepted a prompt.

**Let every renewal error unwind supervision.** A temporary service failure
then executes local stopping even while the original grant and native process
remain healthy. Retrying credential acquisition under the same identity avoids
that interruption without adding process replacement or input replay.

**Retry an initial input after its IPC response is lost.** The original request
may already be dispatching. Even a subsequent snapshot cannot establish that the
request never arrived, so retransmission could repeat native work. Observation
preserves the uncertainty without inventing another operation.

## Consequences

The service and wire codecs must reject mixed bindings, and every event, receipt,
grant and browser cache must retain its scope. The historical database table name
does not change those explicit ownership rules. Older Task clients retain their
existing wire contract; Test support has a separate capability preflight.

Shared rendering and transport make the test entry useful for continuous manual
iteration and real application work. They do not prove worker claim selection,
managed prompts, task completion or worktree cleanup; those retain their own
acceptance scenarios.

Deferring a standalone recovery scheduler is additive only while registration,
execution identity, native profile and stopping evidence remain durable. A later
resume command must prove the old writer stopped and use the exact native
identity; it cannot infer safety from a disconnected browser or expired lease.
