# Agent Note: Node Signal Intent Diagnostics

Status: implemented

## Problem

A repeated macOS Vitest SIGKILL remained unattributed after successful process,
memory and unified-log probes. Periodic PID/PGID/RSS snapshots could not identify
a signal caller, and low free memory did not establish OOM. A bounded local
probe of the adjacent suites passed, leaving the CI failure unexplained.
The next ordinary validation needs evidence from signal callers before the
target disappears, without changing validation conditions or treating a passing
retry as an explanation.

## Decision

The macOS ordinary validation observer enables a Node preload for its existing
command subtree. This partially supersedes the earlier decision to defer
JavaScript instrumentation in
[native test termination diagnostics](2026-11-05-native-test-termination-diagnostics.md).
Passive collection remains useful and retains its existing scheduling, cleanup
and outcome propagation. Linux and Windows do not enable the preload by default.

The preload records a bootstrap for each covered Node process or thread and
wraps only the public `process.kill` and `ChildProcess.prototype.kill` APIs.
Before forwarding, it synchronously records a bounded request, sender identity
and call sites. It invokes the original function once with the original receiver
and arguments and preserves the return or thrown value. It installs no signal
handlers, guards, spawn wrappers or process-group changes. A request is not proof
of delivery or termination; no after-call record is required for self-SIGKILL.

Its require option precedes the existing `NODE_OPTIONS`, preserving the existing
options and their relative preload order. Diagnostic I/O is captured before test
isolation wraps filesystem operations. It writes only the observer's evidence
directory; test operations retain their isolation wrappers and environment rules.
The captured UTF-8 `writeFileSync` path avoids `appendFileSync`'s delegation
through the mutable exported filesystem object. The main process and inherited
Vitest fork workers load the same preload without replacing their configuration
or reporters.

Argument selection never stringifies arbitrary objects or invokes getters for
the child target. Proxy receivers and accessor properties have an explicit
unavailable target. Native argument coercion remains the original API's work.
Records have no inherited serialization hooks, and public `util.getCallSites`
with source maps disabled avoids invoking a custom `Error.prepareStackTrace`.
Missing call-site support remains visible rather than falling back to an unsafe
stack formatter. The [development guide](../../../../docs/development.md#cli-development)
owns the schema fields, encoded size limits and failure behavior.

## Alternatives

**Repeat the unchanged validation or tune concurrency and timeouts.** Neither
would establish a sender. The observed failure preceded the job deadline, and
the memory samples did not prove a resource bottleneck. Validation conditions
remain unchanged while caller evidence is added.

**Require DTrace or Endpoint Security collection.** Hosted-runner sudo access
does not establish the necessary SIP or TCC permissions. These mechanisms also
have coverage limits, so they are not prerequisites for ordinary CI and no
shared security setting changes are made.

**Record every subprocess, test lifecycle or private Vitest worker event.**
This would expand the instrumentation and depend on unrelated runner internals.
Bootstrap identity and the outgoing request's call sites provide the directly
needed evidence. Module activity is not inferred from the preload alone.

**Install a signal safety guard.** Blocking or rewriting a suspicious target
would alter the failure being investigated. This observer preserves every
original request, including an invalid one, and owns no termination policy.

**Enforce a shared global byte budget.** Cross-process reservation or locking
would introduce coordination and failure modes into the signal path. Each
process/thread file instead has its own explicit limits; the aggregate artifact
grows with the number of covered processes and threads.

## Consequences

A recorded intent can identify an API caller and its requested target. Bootstrap
tokens distinguish instrumented lifetimes; they do not prove an executable's
content or exact group membership at the time of a signal. Signals from native
code, shell commands, external processes, the kernel, replaced hooks or
descendants that remove the preload remain unobserved. Missing, truncated or
failed records cannot establish an alternative sender or OOM.

Synchronous writes and call-site capture add bounded record size and execution
overhead, not identical timing. Files are readable after a process is killed,
but there is no machine-crash durability guarantee. Logging failure never
replaces the command result. If no output sink works, the original signal still
executes and evidence can be absent. A successful subsequent CI run validates
that candidate only; the earlier SIGKILL remains unexplained without affirmative
attribution evidence.
