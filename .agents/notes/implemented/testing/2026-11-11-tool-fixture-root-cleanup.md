# Agent Note: Bounded tool fixture root cleanup

Status: implemented

## Problem

A Windows tool-selection test can finish its selected executable and file reads,
then fail while removing the fixture's copied executable with `EBUSY`. The
reported deletion failure does not identify the holder. Immediate rejection
makes a short-lived sharing denial fail the fixture, while ignoring deletion
errors would hide a persistent holder and abandon owned resources.

## Decision

`test/helpers/tool-fixture-cleanup.ts` owns the root-removal function shared by
`tool-executables.test.ts` and `tool-launchers.test.ts`. Both suites execute
copied native tools and await this cleanup after disposing their operations.
Each attempt calls `rm` with `recursive: true`, `force: true`, and `maxRetries: 0`. Only `EBUSY`
permits another attempt: at most three retries wait 100, 200, and 300 milliseconds.
Other failures and the last exhausted error are thrown unchanged. The 600
milliseconds bounds scheduled waiting per root, not filesystem execution or
wall-clock time. Existing operation disposal and awaited fixture cleanup remain
in the same order. Test, hook, process, and CI job deadlines are unchanged.

The retry follows existing resource completion; it does not replace it. The
successful promisified `execFile` callback follows the child's `close` event in
[Node 24.22.2](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/lib/child_process.js#L378-L436).
A rejected execution can follow an earlier error event, so rejection alone is
not a general process-stop witness. Resolver prefix reads and streaming hashes
await their file-handle closes before a successful result. Cancellation can
return before pending filesystem cleanup completes and remains a failure.
The [tool-resolution decision](../architecture/2026-11-11-worker-tool-path-resolution.md)
owns the production selection and identity rules.

The cleanup tests in `tool-executables.test.ts` exercise the shared helper.
Controlled filesystem failures verify the root retry limit, delay sequence,
unchanged final error, and immediate propagation of other errors. Windows-only
controls copy the current Node executable into an isolated fixture and use a
separate Node process to hold that file without delete sharing. A real `EBUSY`
from unlinking that exact file triggers release; readiness or elapsed time alone
does not establish a sharing refusal. A second control keeps the native handle
through all four attempts and requires the last error to escape while the
holder is still alive. Both controls release the handle and join child `close`
before final directory cleanup, with independent parent and child deadlines.

## Alternatives

**Enable Node's recursive `maxRetries`.** Node's
[recursive remover](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/lib/internal/fs/rimraf.js#L37-L54)
allocates a retry counter for each path. A child failure can exhaust its counter
and then cause a parent to traverse it again. For a persistently busy file under
one child directory, three retries with a 100 millisecond step can accumulate
12.6 seconds of scheduled waiting across the root, directory, and file. This
would exceed the ordinary hook budget before reporting the deletion error.

**Ignore cleanup errors or increase a global timeout.** Ignoring failures loses
resource ownership; a larger timeout does not release a sharing denial. Neither
preserves a bounded, observable fixture outcome.

**Change production process or resolver lifecycles.** Successful execution and
file-reading paths already await their owners. No observed handle identity
connects the refusal to a production leak, so these changes would exceed the
evidence and the fixture's responsibility.

## Consequences

Temporary `EBUSY` failures can recover without a directory-depth multiplier.
Persistent locks still fail and retain the original filesystem error; no retry
can establish who held a historical file. The native controls prove only their
explicitly owned sharing handles. Non-Windows controlled errors do not prove
Windows file locking. Total CLI job duration and unrelated fixture cleanup
remain separate concerns.
