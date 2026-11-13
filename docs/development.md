# Development and release guide

This guide covers source builds, package releases, CI selection and validation
evidence. Start with the [project introduction](../README.md) for capabilities
and first-use setup, or the [CLI manual](../packages/daynight/README.md) for
installed commands. Commands below run from the repository root unless a module
working directory is specified.

- [CLI development](#cli-development)
- [Local development CLI channel](#local-development-cli-channel)
- [Local server deployment](#local-server-deployment)
- [Server development](#server-development)
- [Web development](#web-development)
- [Public Markdown image integration](#public-markdown-image-integration)
- [Product E2E](#product-e2e)
- [Package versions](#package-versions)
- [npm publication](#npm-publication)
- [CI selection](#ci-selection)
- [Validation and evidence](#validation)

## CLI development

The published CLI supports Node.js 22 or newer (`engines.node: >=22`) without an
upper major-version limit. Use the latest patch of the selected Node.js major.
The SQLite dependency requires Node-API 10, available from Node.js 22.14.0;
earlier Node.js 22 patches cannot load its native binary. Source development and
publication use Node.js 24 LTS and pnpm 11.28.6: development dependencies and directly executed TypeScript
scripts have their own runtime requirements. pnpm settings, including
`engineStrict`, `storeDir` and dependency build permissions, belong in
`pnpm-workspace.yaml`. Its exact `minimumReleaseAgeExclude` entry for
`better-sqlite3@13.1.1` admits the inspected Windows WAL recovery fix before the
ordinary release-age threshold; the Controller launch decision below owns the
rationale. Runtime review also requires
Git, authenticated GitHub CLI and Copilot CLI on PATH. The inspected
`better-sqlite3` 13.1.1 Linux x64 prebuild requires `GLIBC_2.34` and
`GLIBCXX_3.4.29`; these observed symbol requirements constrain older distributions
and do not establish compatibility for other distributions, architectures or
musl. The dependency bundles SQLite 3.54.1, including Windows WAL recovery when
an exited writer's shared-memory view remains mapped; the
[Controller launch decision](../.agents/notes/implemented/bug-fix/2026-11-12-submitted-controller-launch.md)
records the required native behavior. Native validation must identify its actual
operating system and architecture.
From the repository root:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm acceptance
pnpm daynight --help
pnpm daynight --version
```

`pnpm check` runs type checking and tests. Standalone `pnpm test` and
`pnpm acceptance` build the package before exercising the compiled CLI. Native CI
runs ordinary tests and installed acceptance in independent jobs on Linux,
Windows and macOS ARM64. Each job prepares its own dependencies, builds the CLI
and records its own outcome. The ordinary jobs also typecheck and test the local
development installer. Both native matrices include `ubuntu-latest`,
`windows-latest` and `macos-15`. Ordinary macOS has a 15-minute job limit;
the other jobs have 10 minutes. Windows
ordinary tests use two independent runners with Vitest's built-in `--shard=1/2`
and `--shard=2/2`; their execution sets together cover the complete ordinary
collection. Each Windows runner retains the same preparation and source checks.
Ordinary suites exclude `.stress.ts` files; explicit local stress commands select those
workloads separately, as described in
[local stress validation](#local-stress-validation). `pnpm build` clears the
package's `dist/`, compiles
`packages/daynight/dist/main.js`, then runs `scripts/copy-resources.ts`. That step
copies the explicit review and public skill bundles, plus the five SQLite owner
resource directories, into matching dist paths. Skill bundles retain their full
relative resources. SQL directories recursively copy files whose names end in
`.sql` case-insensitively, preserving their names and bytes, including uppercase
`.SQL` candidates. The copy step neither chooses migration order nor silently
omits a candidate that violates runtime naming rules. Resources are allowlisted
at the bundle/directory boundary rather than discovered from the repository.
Within each owner SQL directory, the runtime validates top-level SQL candidates
against strict lowercase regular-file naming and derives migration order from
valid numbered filenames. Auxiliary subdirectories are copied but excluded from
that normal chain. The package's existing `files: ["dist"]` rule publishes these resources, while
`daynight` and `dn` keep the same stable JavaScript entry. The
[SQLite design](design/cli-sqlite-migrations.md#sql-资源与参考结构) owns SQL loading,
reference metadata and execution ordering.

### CLI test isolation

The ordinary, installed-acceptance and stress Vitest configurations load
`packages/daynight/scripts/test-bootstrap.ts` before test modules. The shared
CommonJS preload is `packages/daynight/scripts/test-isolation.cts`.
`pnpm dev:test` first runs a standalone sentinel regression, then runs the
development-installer tests with that preload. `pnpm completion:acceptance`
starts a preloaded Node runner, which passes the test environment to Python and
its shell/CLI children.

The bootstrap records the original homes' `~/.daynight` directories and inherited
`DN_CONFIG_DIR` before changing the test environment. It clears that inherited
override and creates a private baseline home and temporary directories under the
checkout's `.tmp/cli-tests-*`. Individual tests retain their fixture homes and
explicit configuration overrides; unrelated provider, cache and application
settings remain available. Child-process and native-PTY launches propagate the
isolation metadata and append the preload to `NODE_OPTIONS`, including when a
fixture constructs a restricted environment. A child with an explicit safe
`DN_CONFIG_DIR` retains its supplied home. If its default `.daynight` path would
reach protected state, the launcher supplies the isolated baseline home.

Before a mutation or cleanup, the guard protects both the selected Daynight
root entries and their physical targets. POSIX paths retain their string or
`Buffer` components and are traversed in filesystem order: existing prefixes and
symbolic-link targets are resolved before subsequent `..` components. Missing directories retain virtual
components so recursive creation receives the same protection. Cleanup preserves
trailing separators, `.` and `..`, which can require following a link before
removing a directory. A destructive operation that would remove an ancestor of
protected state is also refused.

The checks cover mutating Node filesystem calls, writable opens, tracked
descriptors and `FileHandle` mutations, recursive-copy destinations, and native
SQLite constructors and backup destinations. Windows disk paths undergo Node's
namespace preparation before physical inspection and protected-root comparison.
Local `\\.\pipe\` addresses identify IPC objects, so they skip disk-path
inspection. Other filesystem paths remain available to tests. The standalone
regression checks its scratch path against protected state before creating
sentinels and launching guarded probes.

Fixtures capture owned cleanup paths before changing or restoring their
environment. Global test teardown and the standalone owning process's exit
cleanup remove the run's private baseline directory. The protection applies only
to test execution; the installed CLI's configuration precedence and filesystem
behavior remain unchanged. The
[test-state isolation decision](../.agents/notes/implemented/testing/2026-11-06-cli-test-state-isolation.md)
owns the mechanism's alternatives and limits.

### CLI test fixtures

Source tests mirror `cli/`, `config/`, `api/`, `commands/` and `platform/`
ownership, with build and version-policy tests in `test/tooling/`. Large binary
payload and copied-resource assertions use `Buffer.equals` to check every byte
and the total length.

API deadline fixtures control both deadline timers and the `node:perf_hooks`
monotonic clock when setup or pagination must complete before expiry. The
continuous-cursor fixture advances time by 10 ms per response: three pages fit
within its original 35 ms total limit, and the fourth response crosses that
shared deadline. Exact cursor progression and a bounded response fixture expose
incorrectly renewed budgets without relying on runner scheduling. The
[API cursor deadline decision](../.agents/notes/implemented/testing/2026-11-10-api-cursor-deadline.md)
records this pagination proof.

The blocked-sink attachment fixture observes entry into its consumer before
advancing to the request deadline, then checks the timeout, sink abort and
response cancellation. This keeps setup time from exercising an earlier timeout
stage. The
[attachment deadline decision](../.agents/notes/implemented/testing/2026-11-07-attachment-sink-deadline.md)
records the assertion and clock boundaries.

Controller IPC admission tests keep real sockets, assert the production timeout
and its cancellation, and accelerate the incomplete socket's native expiry;
virtual time separately exercises the authenticated response wait. The
[test timing decision](../.agents/notes/archived/testing/2026-11-04-cli-test-time-and-bytes.md)
explains the distinction between Node socket timers and global fake timers.
Controller startup timeout tests keep real SDKs, native fixture processes and
request logs. A test-only deadline controller waits for the stalled initialization
request before expiring its captured 30-second callback. The socket-close case
also awaits the real SDK client socket close event before expiry. Other timers
and real I/O continue normally; separate virtual-time assertions check the default deadline
boundary. The strict compiled fixture retains unhandled-rejection, teardown-RPC
and owned-process-exit checks. The
[startup deadline decision](../.agents/notes/implemented/testing/2026-11-05-native-startup-test-deadlines.md)
owns this timing boundary.
Controller and Worker lifecycle fixtures record production poll requests while
using short native promise-timer ticks for their controlled resource states.
Their tests retain exact cadence, deadline clipping and cancellation assertions;
the [coordinator polling decision](../.agents/notes/archived/testing/2026-11-04-coordinator-test-polling.md) records the rationale for that test boundary.
Worker reconciliation deadline fixtures observe the stalled GET before advancing
the controlled timer and monotonic clock. Startup inventory publication can
trigger reporting before the periodic interval, so elapsed time is measured
from that request's observed start. The
[reporter deadline decision](../.agents/notes/implemented/testing/2026-11-10-worker-reconciliation-deadline.md)
records the trigger, single-flight and cancellation checks.
Native supervisor fixtures use production observation budgets and a controlled
parent clock only after a real TERM receipt and native signal-observation window.
The [native fixture decision](../.agents/notes/archived/testing/2026-11-04-native-supervisor-fixture-clock.md)
records the real-process proof and cleanup requirements.
Real Bot integration owns a 180-second teardown hook because original process
proof, IPC stop, Windows Job termination and diagnostics can outlast the ordinary
hook limit. Each process confirmation probe is joined before another round or
escalation; only complete teardown restores mocks and environment variables.
Failed startup records the controlled child's logs, journal and parent/child
ticket paths while retaining original errors and unknown process ownership. The
[Bot fixture decision](../.agents/notes/implemented/testing/2026-11-05-bot-fixture-teardown.md)
owns this isolation and budget rationale. Windows process-proof acquisition
uses the existing Koffi dependency to query birth, parent identity and the full
command line through one retained process handle. It retains the proof's field
shape and birth precision, and hashes full Unicode text without PowerShell
console encoding loss. Historical hashes of lossy command text are not
byte-equivalent and are not accepted through a legacy fallback. Windows
inspection throws identity uncertainty when birth still matches but command
hash or process group differs; stop confirmation retains resources and rejects
before querying the Job inventory. A different birth still establishes process
replacement. Production capture starts no PowerShell/CIM query. Startup retains
fifteen seconds on Windows and five seconds on POSIX; recurring identity
inspection retains five seconds. Windows checks that budget between native calls
and joins a call already in progress, so the budget cannot preempt a kernel
call. Focused regressions cover full command-line identity, birth formatting,
query failures, malformed native output and original-error preservation. The
[Windows native identity regression](../packages/daynight/test/commands/controller/process-proof-native-windows.test.ts)
requires a controlled child's self-proof and parent capture to agree, then
compares birth and the complete command hash with one isolated CIM format
oracle. The oracle transports explicit UTF-8 JSON in an ASCII Base64 envelope
and validates canonical Base64 plus strict UTF-8 decoding, preserving Unicode
independently of the console code page. Its sixty-second allowance belongs to a
ninety-second test; production capture and inspection do not use it as a
fallback. Mismatch diagnostics retain hashes, lengths and qualification flags
without raw command text. The child is stopped and its close joined even when
an assertion fails. The
[native Windows proof decision](../.agents/notes/implemented/bug-fix/2026-11-05-windows-native-process-proof.md)
owns the implementation and its dependency limits; the
[startup budget decision](../.agents/notes/implemented/bug-fix/2026-11-05-windows-startup-process-proof-budget.md)
preserves the acquisition policy's rationale.
Controller Job Object creation, membership queries and termination use the existing
Koffi dependency in the calling process. Each operation retains its fifteen-second
budget, checked between native calls and after handle release; an in-progress
kernel call is joined. Native regressions cover access failures, malformed process
inventories and handle release, while Windows CI keeps real Bot generation,
recovery and deletion scenarios. A test-owned handle keeps a controlled Job name
available for direct membership and termination checks. The
[native Job API decision](../.agents/notes/implemented/testing/2026-11-05-native-controller-job-api.md)
owns the preserved handle lifetime and measurement boundaries.
The native fsmonitor regression uses a real hook's invocation marker to qualify
ordinary Git and verify protected-query suppression. Its
[fixture decision](../.agents/notes/archived/testing/2026-11-04-fsmonitor-fixture-marker.md)
records why no idle delay is required after that marker is written.
The pnpm dependency store is local to `.tmp/pnpm-store`. `pnpm acceptance`
packs and installs the CLI in a local consumer and requires package-registry
access. It checks the package, its launchers and shipped resources, including
SQL and skill bundles, and exercises npm installation and update in an isolated
global prefix. Ordinary CLI tests own command behavior and its error and
concurrency cases. The installed suite does not modify the operator's installed
CLI or require live review credentials.

The update supervisor confirms POSIX cleanup only after its invocation's anchor
has exited, the inherited process group no longer exists, and captured output
pipes have closed. The 10-second cleanup deadline includes all three checks;
an unconfirmed cleanup retains the original command error. Descendants that
leave the inherited process group are outside this guarantee. Windows retains
attached console handles and uses `taskkill` for tree termination. The
[cleanup decision](../.agents/notes/implemented/bug-fix/2026-11-13-update-process-group-cleanup.md)
records the ownership and observation limits.

Ordinary CLI tests retain completion unit tests without launching a real shell
editor. Real-shell validation has two explicit entries: the complete behavior
matrix in `shell-module.py`, and the artifact acceptance command
`pnpm completion:acceptance`. Both require Python 3 on a POSIX host, Bash 4.2,
a modern Bash and zsh. Linux hosts can prepare isolated shell executables and
run both suites from the repository root:

```bash
bash packages/daynight/scripts/prepare-completion-shells.sh
source .tmp/shell-completion/environment.sh
pnpm build
python3 -u packages/daynight/test/commands/completion/shell-module.py --shell all
pnpm completion:acceptance
```

The preparation helper builds the SHA-256-pinned GNU Bash 4.2 release in
`.tmp/shell-completion/`. It tries GNU's archive and independent GNU mirrors,
verifies each download before caching it, and fails if none matches the pinned
digest. It requires standard build tools,
`curl`, `sha256sum`, `tar` and `timeout`. It uses an existing zsh when available;
otherwise it downloads Debian packages with `apt-get download` and extracts them
locally with `dpkg-deb`. It installs no global packages. First-time preparation
requires network access; subsequent runs reuse the local toolchains.

On other POSIX hosts, or to select existing executables, set `DAYNIGHT_TEST_BASH42`
to the Bash 4.2 executable before running `pnpm completion:acceptance`.
`DAYNIGHT_TEST_BASH` and `DAYNIGHT_TEST_ZSH` select the other executables and default
to `bash` and `zsh`. `DAYNIGHT_TEST_ZSH_ROOT` optionally selects an extracted zsh
toolchain root. `DAYNIGHT_COMPLETION_EVIDENCE` optionally selects the JSON receipt
path. The artifact command builds the client and runs a Python PTY harness
against actual Tab insertion in all three shells. It also installs setup into isolated startup
files and checks interactive shell loading and completion registration. The
module harness additionally owns the complete command, option, directory,
refusal and setup-error matrix; the artifact suite does not replace it. Both
use task-local fixtures, with no user configuration, review credentials or
installed CLI changes. They write `.tmp/completion-module-evidence.json` and
`.tmp/completion-evidence.json`, respectively, unless the receipt path is overridden.
The dedicated Ubuntu 24.04 job in the
[`shell and browser acceptance` workflow](../.github/workflows/shell-browser.yml)
runs both suites on every `main` push and through `workflow_dispatch`.
Its result belongs to that workflow's checked-out revision and does not gate
ordinary PR `checks`. The `daynight-completion-acceptance` artifact contains
both available JSON receipts. Upload runs after the module harness starts,
including when its failure prevents the later artifact suite from running. The
[completion design](../docs/design/daynight-completion.md) owns its coverage and
loading guarantees.

Native development and validation support Linux, Windows and Apple Silicon
(ARM64) macOS. Intel macOS is unsupported. GitHub Actions runs type checking,
build and tests on native Linux, macOS 15 ARM64 and Windows runners. The
ordinary `verify` and installed `verify-installed` matrices both include the
standard `macos-15` label. Their macOS entries assert Darwin ARM64 and execute
their complete phase workload. The [platform decision](../.agents/notes/archived/testing/2026-11-04-macos-arm64-support.md) records the rationale for the support boundary; the [image availability decision](../.agents/notes/implemented/testing/2026-11-05-macos-ci-image-availability.md)
records the explicit image selection and its limits. Hosted capacity failures
require diagnosis within this ARM64 runner policy, and a supported label still
requires real allocation and complete native test results.
Each native job resolves the latest available Node.js 24 patch.
The ordinary Ubuntu job builds and packs the Node.js 24 artifact consumed by the
separate runtime matrix. Runtime jobs depend on module detection and the
ordinary `verify` matrix, so they wait for ordinary verification on Linux,
Windows and macOS. They do not depend on installed acceptance and check the
Ubuntu-produced packed artifact with Node.js
`22.14.0`, the latest `22` and `24` releases, and current
`node`. Each runtime installs it in a fresh npm consumer with `--engine-strict`
and exercises CLI commands, interactive prompt dependencies and SQLite. These
checks cover the published package and its production dependency graph without
requiring the source-development toolchain on each supported runtime.
PRs select complete module jobs from their changed paths; the
[CI selection rules](#ci-selection) define shared inputs and exclusions for
documentation and repository metadata. A selected CLI runs both phases on every
native platform and the runtime compatibility matrix. Both native matrices need
only module detection, so ordinary validation does not gate installed validation.
Each job owns its checkout,
toolchain, dependencies, environment recorder, build, fixtures, cleanup and
artifacts. The Windows ordinary phase has two independent matrix entries; the
other native phases each have one. Final `checks` requires actual success from
all selected ordinary, installed and runtime jobs, including both
Windows ordinary shards. The two macOS jobs use separate workspaces, so their fixed
receipt paths need no phase handoff or clearing. A failure or cancellation in
either job fails the final gate. The [phase ownership decision](../.agents/notes/archived/testing/2026-11-04-parallel-native-cli-validation.md)
records the original parallel model; the [independent macOS validation decision](../.agents/notes/implemented/testing/2026-11-07-independent-macos-cli-validation.md)
owns the current macOS topology and its allocation trade-off. The
[Windows shard decision](../.agents/notes/implemented/testing/2026-11-11-windows-cli-verified-shards.md)
owns the Windows ordinary allocation and completeness checks.
Main pushes run every module. The checkout includes the required history.
Native tool discovery records command resolution, launcher, PID, timing, status
and bounded output in `.tmp/validation-probes.json`. Before executing `gh`, it
reads the selected file sequentially and records its byte count, SHA-256 and
preparation duration. The gh preparation has a separate 20-second deadline; an
expired or failed preparation stops the probe before launch. The version command
then receives its own full 10-second execution budget. Its child uses isolated
project-local configuration/state and disabled telemetry. A separate diagnostic
artifact uploads after validation even when environment discovery fails. Ordinary environment and diagnostic artifacts
use `daynight-cli-tests-*` and `daynight-cli-tests-probes-*` names; installed
receipts and diagnostics use `daynight-cli-installed-*` and
`daynight-cli-installed-probes-*`. The installed receipts include the environment,
curated acceptance outputs and canonical preparation/cleanup result. Every
native version and both complete phase workloads remain required whenever CLI
validation is selected. Every ordinary and installed matrix job has a 600-second
limit, including setup, validation and uploads. The
[cold-start decision](../.agents/notes/archived/bug-fix/2026-10-20-gh-cold-start-preparation.md)
records the measurements, deadline semantics and remaining limits.

The macOS ordinary test command runs under
`packages/daynight/scripts/observe-native-validation.mjs`. It preserves the
complete Vitest command, default concurrency and test deadlines, and propagates
the command's exit result. Incremental process/resource samples and a bounded
post-exit macOS termination-log query are uploaded from `.tmp/native-validation/`
as `daynight-cli-tests-termination-macos-15`, including after test failure.
Unavailable probes are recorded as diagnostic errors; sampling cannot prove the
absence of a short-lived process or identify a signal sender by itself. The
[termination diagnostics decision](../.agents/notes/implemented/testing/2026-11-05-native-test-termination-diagnostics.md)
describes the evidence limits and collection cost.

The macOS observer enables `--signal-intents` for its command subtree. This
prepends `scripts/signal-intents.cjs` to `NODE_OPTIONS`, retaining the existing
options and their preload order. Loading first captures native diagnostic I/O
before test isolation or other preloads wrap it; test code continues to use the
normal isolation guards. The observer and its native probes are not instrumented.
Each Node process or worker thread that loads the preload writes a separate
JSONL file under `signals/` in the same artifact. A bootstrap records PID, PPID,
thread ID, a random startup token, executable basename, Node version and installed
hooks. These records establish coverage; absence of a bootstrap does not prove
that a process made no signal requests.

Before `process.kill` or `ChildProcess.prototype.kill` executes, the preload
synchronously records its API, sender identity, target, supplied signal and bounded
call sites. The original receiver and arguments are forwarded exactly once, with
the original return or exception. Numeric targets and signals and recognized
signal names retain their values; other argument values retain only their type.
Child targets are read only from a non-Proxy receiver's own data property.
Call sites use Node's public `util.getCallSites` with source maps disabled,
without invoking `Error.prepareStackTrace`. No signal handlers, process-group
changes, retries or termination guards are installed. An intent records a request,
not delivery or target termination; self-SIGKILL can prevent any later output.

Each process/thread file admits at most 1,024 normal events and 256 KiB including
one reserved truncation event. An event is at most 16 KiB; each encoded call-site
file or function field is at most 512 bytes, with a visible truncation suffix.
Up to ten call sites remain after removing two instrumentation frames; a full
capture marks its frame limit. Budget exhaustion explicitly stops further
diagnostic records while signal calls continue. A file-write failure emits one
bounded stderr notice and disables that file; if stderr is also unavailable,
no diagnostic sink remains. Total artifact size depends on the number of covered
processes and threads, rather than a shared cross-process byte quota.

Explicitly removed preload/environment, replaced hooks, non-Node programs,
native signal calls, external processes and kernel termination remain outside
this coverage. The absence of a matching intent cannot establish an external
sender or OOM.
Synchronous recording adds execution time and does not preserve exact scheduling.
The [signal intent decision](../.agents/notes/implemented/testing/2026-11-11-node-signal-intents.md)
owns these trade-offs. A later successful CI run does not explain an earlier
unattributed SIGKILL.

Ordinary CLI Vitest runs retain Vitest's default reporter selection, including
GitHub Actions annotations, and add `scripts/vitest-failure-reporter.ts`.
Failed tests, suite hooks and module
initialization errors are written when Vitest supplies their public result;
the public `onUnhandledError` callback records unhandled errors without
suppressing Vitest's failure decision. Readable console diagnostics and
incremental JSONL files in `.tmp/cli-test-failures/` preserve those observations
before the final summary. The ordinary CI matrix always attempts to upload the
available files as `daynight-cli-tests-failures-<os>`. Windows ordinary
environment, probe and failure artifacts append `-shard-1` or `-shard-2` to the
platform name. A runner stopped before
delivering an event, or before artifact upload executes, may leave no such
evidence; these diagnostics do not identify the cause of process termination.

Windows ordinary execution uses `vitest.windows-shards.config.ts`, which inherits
the ordinary configuration and adds Vitest's JSON reporter. Each Windows runner
first executes `vitest list --config vitest.windows-shards.config.ts --filesOnly`
with JSON output to save the complete unsharded discovery, then executes
`vitest run --config vitest.windows-shards.config.ts --shard=1/2` or `2/2`.
The discovery command does not establish a shard's execution. The actual run's
JSON, full discovery and source metadata are uploaded as
`daynight-cli-tests-results-windows-latest-shard-1` and `-shard-2` from
`.tmp/windows-cli-shard/`.

After all selected CLI jobs succeed, final `checks` downloads both artifacts and
runs `.github/scripts/windows-cli-shards.mts verify`. It checks clean source SHA
and tree against its own checkout, the pinned Vitest version, native Windows
platform and the actual GitHub test-step outcome. File paths are normalized
relative to each runner's package root; invalid or escaping paths are rejected.
Both full discoveries must agree. Each actual execution set must be nonempty and
free of duplicates, and the two sets must be disjoint with a union exactly equal
to the full discovery. Missing evidence, failed or incomplete results, or a
mismatch fails the gate. Existing intentional skips and todos remain represented;
JSON success never replaces the native command and job results.

The reporter records only the framework's file, full test or suite name, and
error name, message and stack. Field limits include JSON escaping: file 2 KiB,
test name 4 KiB, error name 256 bytes, message 8 KiB and stack 16 KiB. Each event
contains at most two errors and is capped at 64 KiB in each output. A run allows
1,024 normal events and 4 MiB across JSONL and console, including reserved
truncation and writer-failure notices. Truncation is explicit. Diagnostic write
failures are reported through the remaining output, without changing the test
result. No environment values, command arguments or additional process contents
are collected; assertion messages and stacks retain the content supplied by
Vitest. Existing test selection, concurrency, deadlines and the macOS observer
remain unchanged.

Explicit `pnpm test:apfs` diagnostics on macOS mount temporary case-sensitive and
case-insensitive APFS images to check path identity against both behaviors.
Routine `pnpm test` and the CLI CI matrix leave this image suite unselected;
non-mounting path and cleanup tests still run. Setup positively verifies
whole-image ownership before the eight original filesystem cases. One additional
same-user read-only file-holder case requires actual Busy, known-PID diagnostics,
acknowledged release after at least six seconds and exact image absence. That
controlled case restricts its volume `lsof` query to the acknowledged child PID
AND the mounted filesystem; generic fixture diagnostics retain their existing
filesystem query. Every diagnostic keeps its two-second limit. All finalization
shares one 30-second budget and at most three ordinary detach calls; unresolved
cleanup fails the job. The
[finalization decision](../.agents/notes/archived/bug-fix/2026-10-20-apfs-finalization-window.md)
records the ownership and observation guarantees, and the
[controlled-holder decision](../.agents/notes/archived/bug-fix/2026-10-21-apfs-controlled-holder-observation.md)
records the limited process selection and required native evidence. No live GitHub or Copilot
credentials are required by these checks.
SQLite business-state unit tests use private native `:memory:` connections,
including real constraints, migrations, transaction rollback and revision/retry
transitions. Stores receive these connections explicitly; fixture cleanup closes
them. Cases proving file persistence after reopen, WAL snapshots, separate live
connections, filesystem errors, instance locking or cross-process recovery use
real file databases in `*.integration.test.ts` suites. Ordinary `pnpm test` and
the CLI CI matrix run both kinds with the existing platform and failure checks.
Git repositories, IPC, Controller resource files and historical body migration
sources retain their own private filesystem fixtures. Current timeline bodies use
the same SQL owner in memory and file cases; capacity stress probes run separately
from ordinary test selection. The
[memory SQLite decision](../.agents/notes/implemented/testing/2026-11-06-cli-memory-sqlite-tests.md)
owns storage selection and connection ownership.
GitHub tests use controlled API responses and subprocess fixtures to verify
complete scans, HTTP failures, and atomic observation commits.
Git lifecycle tests use local origin/clone fixtures and real worktrees to check
captured targets, disposable review artifacts, shared refs, and isolation between
PR worktrees. Ownership lifecycle cases use an explicit 60-second outer test
limit, including cleanup diagnostics that first clone and prepare a real
worktree. This limit includes native setup, ownership inspection, fault injection
and assertions; the runner's five-second default does not cover that complete
workflow on Windows. The
[cleanup diagnostic budget decision](../.agents/notes/implemented/testing/2026-11-09-review-cleanup-diagnostic-budget.md)
records its scope and evidence limits. Independent Git suites run in separate
Vitest workers. Review suites copy immutable bare-origin seeds into private test directories; refs,
SQLite databases, clones and worktrees remain separate for every case. Sparse
suites prepare their shared source graph before copying; scenario observations
and mutations remain private. Source snapshots are prepared through batched
native Git imports, while real clone/fetch/worktree operations remain the test
subjects. Worker worktree cases separately copy file-owned starting repositories
for the files and reftable backends. The concurrent fetched-commit case keeps
both real preparations within its fetch barriers and uses a case-local 30-second
watchdog for native Git execution. Its commit, shared-ref and private-ref cleanup
assertions remain in that workflow; discovery-only cases retain their separate
preparation hooks and default behavior budget. The
[concurrent fetch budget decision](../.agents/notes/implemented/testing/2026-11-09-worker-concurrent-fetch-budget.md)
records why that interleaving needs its own bound. The foreign-claim, nonempty
reservation and mismatched-project case also owns a local 30-second watchdog:
it creates and removes a real managed worktree while checking every refusal and
the retained foreign content. The
[ownership refusal budget decision](../.agents/notes/implemented/testing/2026-11-10-worker-ownership-refusal-budget.md)
records its measured command sequence. The lost administrative-removal response
and changed task-local origin cases each use a local 30-second watchdog. Their
real preparation, recovery or refusal, and cleanup assertions stay inside the
case budget. The
[recovery and origin budget decision](../.agents/notes/implemented/testing/2026-11-10-worker-recovery-origin-budget.md)
records these two workflows. Other cases without an explicit budget retain the
runner's five-second default. Direct mutation checks verify
independent tracked bytes, refs and Git objects in each copy. The
[Worker seed decision](../.agents/notes/archived/testing/2026-11-04-worker-git-fixture-seeds.md) records the rationale for that fixture lifetime. Tests within a file stay sequential so environment
changes and cleanup have one owner.
The [Git test decision](../.agents/notes/archived/testing/2026-10-18-parallel-git-validation.md)
records the isolation rules, and the
[CI timing report](../docs/research/windows-ci-performance.md) records native
before/after measurements. The repository-discovery submodule case prepares its
real Git fixture in a case-scoped hook before exercising discovery, retaining
separate setup and behavior limits and the existing private-directory cleanup.
The [fixture lifecycle decision](../.agents/notes/archived/testing/2026-10-22-submodule-discovery-fixture-lifecycle.md)
records that separation. The installed suite's Vitest setup packs and installs
the production package once per platform invocation. Consumers own private
runtime directories and writable package views where needed. Global teardown
checks the canonical package and removes its installation after consumers
finish. The canonical preparation and cleanup result is recorded in
`.tmp/installed-cli-preparation.json`; npm global-prefix validation owns its
separate fixture. The [shared preparation decision](../.agents/notes/archived/testing/2026-11-04-shared-installed-cli-preparation.md)
records the fixture ownership rationale.

## Local development CLI channel

The repository's [prepare-daynight-local skill](../.agents/skills/prepare-daynight-local/SKILL.md)
guides GitHub test-repository preparation and environment refresh across the local
site, development CLI and Worker. It covers isolated state, directory command
routing, automatic test identities, a CLI/website/Agent test loop using only
localhost fixtures, and controller Test Sessions with native Providers. Its
runtime checks include WebSocket Upgrade forwarding and the native Provider
environment; normal Worker recovery preserves the original claim and Session
without replaying confirmed input. Browser testing uses an isolated headless Edge
instance by default. Real OAuth and device consent remain separate optional
checks. Other agents can use a retained environment under the skill's shared-use
rules.

Investigations that use this environment start from the
[discover-daynight-improvements skill](../.agents/skills/discover-daynight-improvements/SKILL.md).
It defines the investigation boundaries, coverage records, the evidence standard
with freshness checks and private-data screening, the finding package and its
validator, and individual production handoff; topic skills supply the judgment
for one kind of investigation. The [audit-daynight-ui skill](../.agents/skills/audit-daynight-ui/SKILL.md)
guides user-path exploration on desktop and phone widths, the Session View
checklist and designed solutions with interactive prototypes. Evidence capture
binds selected page state to its artifact. Each confirmed improvement has its own
task, evidence and acceptance criteria. Retesting merged fixes and correcting
demonstrated false positives improve the reusable guidance while local fixtures
remain separate from delivery work.

On macOS and Linux, install a development build alongside the npm installation:

```bash
pnpm dev:install
daynight-dev --build-info
```

The installer requires Node.js 24 and uses the current Node executable's bin
folder by default. `pnpm dev:install --bin-dir "$HOME/.local/bin"` selects another
folder already on your PATH. Only `daynight-dev` is installed; `daynight` and `dn`
remain owned by npm. An unrelated existing `daynight-dev` entry is not overwritten.
Windows development installation and nonempty Agent CLI alias mappings currently
fail explicitly; ordinary Windows CLI operation and `DN_CONFIG_DIR` remain supported.

Each installation builds the CLI and copies its production dependencies into an
independent `.tmp/dev-builds/build-*/` snapshot. The installed symlink changes
atomically after verifying the snapshot's version. `--build-info` reports the
source checkout, commit, dirty state, version, build time and snapshot directory.
Running processes and resolved Agent aliases keep their original snapshot when
the entry is reinstalled. Keep its snapshot and fixed Node executable available
while any execution can use them. Removing a worktree also removes its snapshots;
install from a retained checkout for longer-lived use. There is no automatic
snapshot garbage collection. Remove an obsolete snapshot only after its executions
have stopped. Removing the installed `daynight-dev` symlink does not delete state.

`daynight-dev update` refuses npm updates and points to `pnpm dev:install`.
The development installer is repository tooling, excluded from the published
package. The npm package continues to expose only `daynight` and `dn`.

### Independent configuration and local state

The development launcher defaults `DN_CONFIG_DIR` to `~/.daynight-dev`, unless
an explicit environment value is already present. Configure its service in
`~/.daynight-dev/config.yml`, then run `daynight-dev login`. No stable credentials,
worker identity or configuration are copied, and installation does not log in or
start a Worker. For example, a local test service can use:

```yaml
serverUrl: http://127.0.0.1:5173
```

The [configuration contract](../packages/daynight/README.md#configuration-root)
defines the paths and isolation limits. Neither the launcher nor `DN_CONFIG_DIR`
changes `HOME`, Git, SSH or native Provider credentials. Two state roots pointing
to the same server still see the same server data, and they must not independently
manage the same task worktree. SQLite migrations run through the existing startup
paths within the selected root; installing a build does not open or migrate them.

### Keep the skill's command spelling

Agent command redirection is opt-in. Add this to the selected configuration when
new Worker or Controller Agents should execute the development build through the
skill's existing command names:

```yaml
agentCliAliases:
  daynight: daynight-dev
  dn: daynight-dev
```

The left side is the command the Agent uses; the right side is a command found
on the launcher's PATH or an absolute executable path. Omit the field or use `{}`
to preserve the original Agent PATH. Installation never adds these settings.
The selected Daynight configuration root is preserved when a mapped target runs,
so choosing a different executable does not silently choose another account.

Only `daynight` and `dn` can be mapped. New Controller processes and new Herdr
workspaces receive private executable shims, with targets resolved before PATH
injection. Herdr's daemon environment is not redirected. Already-running Agent processes keep their mapping. New or resumed Controller
processes read the current configuration; new Herdr workspaces receive the current
mapping. Retained Herdr workspaces keep their environment, while a newly started
Codex process receives the current launch policy. Editing configuration alone does
not rewrite an already-running process. Ordinary terminals and the separate PR reviewer do
not receive these aliases. Provider settings or shell startup files can override
PATH. For Codex, Daynight reads the native effective configuration for the Agent's
working directory before starting or resuming it. An explicit native
`shell_environment_policy.set.PATH` keeps its complete value with the private
alias directory prepended; without that override, the prepared launch PATH is
retained. Daynight supplies this PATH and DN_CONFIG_DIR as explicit policy values
so restoring a login-shell snapshot preserves the mapping. Other policy fields,
including inheritance and include/exclude filters, are unchanged; include-only
filters can still exclude these variables. The Web Controller reuses its native
app-server connection. Herdr uses a bounded, session-free app-server inspection
with the same environment and ordered configuration flags after native
preflight. Unsupported profile inspection, failed configuration reads or
unconfirmed probe cleanup stop that launch instead of selecting a default PATH.
No inspection is added when aliases are absent. Verify
`command -v daynight` and `daynight --build-info` from the actual
Agent when customizing those environments. No claim is made about arbitrary
shell startup overrides.

Aliases require a state directory without `:` on POSIX because the private bin
path must be one PATH entry. Missing or invalid targets fail before an Agent
starts. Successful shim directories under `agent-cli-aliases/` are retained while
process descendants may use them; clean them only after those executions stop.
Use `pnpm dev:test` for the maintained installer regression tests; `pnpm test`
also runs them.

## Local server deployment

Run the dashboard, project/task API and PostgreSQL with Docker Engine 28+ and Docker
Compose 2.20+ using Linux containers on Linux or macOS (Docker Desktop):

```bash
cp deployment/localhost/.env.example deployment/localhost/.env
# Configure the private .env using the deployment guide before starting.
bash deployment/localhost/up.sh
```

The command uses the public base YAML mounted read-only under the selected
server root and requires the five authentication settings in that private file.
Explicit server environment variables override YAML. It builds the UI and server inside Docker, initializes or upgrades PostgreSQL and waits for
`/readyz`. Open the configured public origin and log in through UniAuth. APIs and
trusted attachment previews share that origin. For CLI access to this local test
deployment, set `serverUrl` to its public origin in `~/.daynight/config.yml`,
remove any credential belonging to another origin, then run `daynight login`.
Production CLI access defaults to `https://daynight.cc`; automation can provision
an origin and its matching PAT through the same configuration file.
PostgreSQL data persists across container recreation. The
[localhost deployment guide](../deployment/localhost/README.md) owns port and npm build-registry selection,
API examples, logs, updates and volume removal.

## Server development

Read [server organization rules](daynight-server.md) before adding to, modifying
or reviewing daynight-server. Use Go 1.27.2, PostgreSQL 18.6, Node.js 24 LTS
and pnpm 11.28.6. From `packages/daynight-server/`, set
`DAYNIGHT_TEST_DATABASE_URL` to an isolated database and run:

```bash
bash scripts/check.sh
bash scripts/startup-shutdown.sh
```

The module check builds and vets with a unit-test Web resource overlay, prepares
the pinned UniAuth fixture, clears cached Go test results, and runs module tests
and coverage. The startup/shutdown check owns the explicitly tagged command
tests and the focused Webhook Runner abrupt-recovery witness. It vets the tagged
command tests and measures only the command package's production statements.
The module check measures all other production packages, including cross-package
calls within that partition. Every production package belongs to one coverage
partition; both independently retain the configured package and function
thresholds of 85% and 80% and raw statement coverage strictly greater than 90%.
Their combined production statement coverage therefore also exceeds 90%.
Ordinary Node.js tool tests remain portable; production builds use real Web
assets. Critical-block failure is disabled; race is enabled locally and for main
pushes, while PR CI disables it explicitly. The
[server guide](../packages/daynight-server/README.md#race-instrumentation)
describes the actual check. The complete module check requires an isolated
PostgreSQL instance and fails if it is unavailable. The [server guide](../packages/daynight-server/README.md#validate)
owns prerequisites and focused commands.

The root application service suite and its tagged partial-start witness execute
without database or UniAuth fixtures. They use the production assembly path with
instance-owned resource openers and the shared transaction/readiness/close
binding, retaining actual Engine, file, permit and worker lifetimes. Native
open-error paths still use the public entries; successful native composition is
covered by the startup/shutdown check. The
[application service guide](../packages/daynight-server/README.md#application-service-tests)
owns focused commands and the separate domain and Store proof owners.

The [test-writing rules](writing_tests.md) define test ownership. Task HTTP unit
tests mock the directly called service/use-case operations while exercising real
routing, credential middleware, parsing, responses and request lifecycle. Core
rules use domain facts and required controlled DAO, scope and transaction
dependencies. Service tests execute their own assembly, orchestration, transaction
coordination and shared-resource lifetime. Tests may retain inexpensive,
deterministic real collaborators and control narrow capabilities when cost or
precise outcomes require it. Selections designed without PostgreSQL execute
without it. Store tests retain actual SQL, locking, transaction,
persistence and database recheck mechanisms. The
[server test guide](../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns focused commands and failure expectations. The complete
`internal/core/session`, `internal/service/webhook` and
`internal/service/attachment` suites execute without a database URL. Attachment
service tests control directly invoked Project-read and Attachment metadata and
path-conflict operations, with separate snapshot, mutation and required DAO
expectations. Real file gates, staging, publication, leases and callback completion
retain their admission, file/metadata order and resource lifetime assertions. Core receivers retain exact Project-read authority/context and complete access,
conflict-query resource/context and metadata write/delete cancellation forwarding.
The Attachment service test binary clears database and UniAuth fixture variables
even during full module validation.
The [attachment service guide](../packages/daynight-server/README.md#attachment-service-and-store-tests)
owns its focused command and the separate PostgreSQL and local filesystem proof
owners. The regular `internal/server/session` unit suite controls directly
called Session use cases and executes actual routing, credential middleware,
HTTP, WebSocket and TCP behavior. Its
[guide](../packages/daynight-server/README.md#session-http-tests) owns the standalone
command, opaque archive capabilities and call/lifecycle expectations. Producer, service, HTTP/protocol and
PostgreSQL owners retain distinct proofs. Task HTTP's `!stress` TestMain clears
the database and UniAuth fixture variables in its test binary even when the
complete module check supplies them to other packages. It executes the whole
regular suite with that boundary; stress workloads use their separate fixture.
The complete module check still includes isolated real PostgreSQL. The
`internal/server/mcp` suite also clears infrastructure variables and controls
direct service/use-case operations, retaining actual HTTP/SDK framing, schema
registration, input/write byte boundaries and request lifecycle. Its [protocol test guide](../packages/daynight-server/README.md#mcp-protocol-tests)
owns the standalone command and lower admission, transfer and persistence proof
boundaries.

The complete `internal/service/mcptransfer` suite also clears infrastructure
variables and uses explicit DAO, transaction and direct attachment-operation
results. It retains actual file permits, chunk streams, hashes and content
boundaries. Store tests own receipt/accounting atomicity and real lifecycle locks;
the existing startup/shutdown entry owns the cross-process orphan-recovery
witness. The [transfer service guide](../packages/daynight-server/README.md#mcp-transfer-service-tests)
owns focused commands and the core JSON-binding proof.

The explicitly tagged `cmd/integration_tests` suite runs normal API flows through
a production Server process and Go HTTP client. Its runner selects
`TestServerAPINormalFlows` and `TestServerAPISessionNormalFlow`. The Session flow
checks an authenticated Worker claim, registration and grant, Controller
WebSocket hello/synchronization, current-state readback, browser snapshot and
exact timeline content delivery through the assembled services and PostgreSQL.
Build production Web resources
once, then run `bash scripts/integration.sh` from the Go module. The runner owns
a fresh PostgreSQL container when `DAYNIGHT_TEST_DATABASE_URL` is unset; an
explicit URL must identify the invoking test environment's isolated instance.
It also prepares real authentication, records the source and binary identity,
and bounds startup, execution and cleanup. `bash scripts/integration.sh --cleanup`
independently reconciles saved runs after interruption and preserves their
original failure or unknown command outcome. Safe build/result JSON and streamed
logs remain in `.tmp/integration-results/<run-id>/`; private ownership receipts,
credentials, databases and copied binaries are not uploaded. The
[API integration guide](../packages/daynight-server/README.md#go-api-integration)
owns exact preparation, evidence fields and cleanup semantics. An independent
API integration CI job prepares these resources and runs the suite without
waiting for module coverage. The suite does not run CLI or Web tests.

The API runner's six process and cleanup unit tests require Linux `/proc`
process identities. The independent Linux API job runs them as a required,
bounded step before production Web preparation and API flows. Run them directly
on Linux from the Go module without a database or production Web build:

```bash
node --test scripts/integration-runtime.test.mts
```

These tool tests own process termination and escalation, PID identity, targeted
cleanup, original command failures and recoverable directory cleanup. Their
failure cases remain separate from the normal API flows and the portable
`scripts/check.sh` entry.

The server's checked-in PostgreSQL format snapshot is compared with the complete
migration history during ordinary validation. Refresh it with every migration;
the [snapshot maintenance guide](../packages/daynight-server/README.md#schema-snapshot-maintenance)
owns the PostgreSQL 18 regeneration command and equivalence requirements.
Runtime startup initializes an empty target namespace atomically from the
snapshot and replays historical migrations for an existing namespace. Missing
ledger metadata alone does not establish that the namespace is empty.

The startup/shutdown suite's [fresh-process attachment test](../packages/daynight-server/README.md#built-process-acceptance-and-ci-evidence)
checks grant removal and new project denial while an admitted upload remains
incomplete, then verifies the upload and cleanup against real HTTP and PostgreSQL.

## Web development

The private [web workspace](../packages/daynight-web/README.md) implements the project
list, cursor paging, safe API decoding, cancellation, project statistics, task
graphs, complete task details in centered dialogs or independent pages, and
single-file attachment management. An open project or standalone detail synchronizes
its IndexedDB summary base every fifteen seconds while visible, pauses automatic
reads while hidden and synchronizes immediately on return. Current identity is verified through browser-managed `/me` HTTP revalidation;
unchanged profiles use bodyless wire-level 304 responses. Persistent assignee
content is restored only after a user-matched online project sync supplies its
complete qualified-person version manifest. Matching profiles survive reload;
only changed or missing content is fetched. The cached content grants no project
or mutation authority.
Full details reuse matching intrinsic cached content, perform a live read on
opening and refresh on business-version changes or recovery needs.
Refresh retains browsing state and the mounted details, including attachment
inputs and previews. Failed reads keep prior data with an error and recover on a
later successful read; unavailable resources are cleared. The
[automatic refresh decision](../.agents/notes/archived/feature/2026-10-22-project-task-auto-refresh.md) records the rationale for scheduling, request priority and retained-state guarantees. Its
[locale runtime](../docs/design/daynight-web-i18n.md) provides English and Simplified
Chinese across the shipped interface, native Intl formatting and an independent
saved language preference. Navigation, the centered detail dialog and fullscreen
graph share one language choice while preserving browsing and pending attachment
state. The [bilingual requirements](../docs/spec/daynight-web-i18n.md) own the full
outcome. The public `/` introduction and local example use that same language
state. `/login` owns authentication and `/projects` is the workspace index; the
[public entry design](design/daynight-landing.md) owns route composition,
public navigation hints and metadata. The header's book icon and visible Setup guide link, immediately before
the language selector, open public `/setup` in a new tab. Its expanded bilingual
sections cover MCP client configuration, authorization and read-only verification,
and the independent CLI and Agent skill setup. The current origin determines the
MCP endpoint but does not configure the CLI. Selectable commands share copy
feedback. The guide mounts outside the authenticated shell and makes no API,
fetch or XHR requests during reading and interactions. Validate the production
entry in a real browser across both languages, all three MCP clients, desktop,
390px and 320px widths and long endpoints; check exact displayed and copied
commands and the POSIX shell guidance (including Git Bash on Windows), stale
clipboard results, keyboard access and zero-request lifecycle.
Static guide checks do not prove an actual OAuth authorization or MCP call.
The [path decision](../.agents/notes/implemented/feature/2026-11-11-setup-mcp-guide.md)
records the trade-offs; [Web requirements](../docs/spec/daynight-web.md#日常使用引导)
own the complete outcomes. With the Go API running on loopback, use:

```text
pnpm web:dev
pnpm web:typecheck
pnpm web:build
pnpm web:test
pnpm web:test:browser
```

The frontend build emits `packages/daynight-web/dist/`, validates its HTML and
assets, and publishes them into the Go embed directory. A production Go build
requires generated assets. Web quality runs full Web typechecking, the module
harness, the production Docker Web build, the Vitest/V8 suite and a statement
gate strictly greater than 90%; it does not start the Go service or an installed
CLI. `pnpm web:test:browser` separately runs the controlled
module browser fixtures after Playwright Chromium is installed; see the
[Web guide](../packages/daynight-web/README.md#validation-and-build). The CI Web quality job contributes its result to the final
`checks` gate and must succeed when Web validation is selected. The assistant
browser suite runs separately in the
[`shell and browser acceptance` workflow](../.github/workflows/shell-browser.yml)
on `main` pushes or manual dispatch; ordinary Web unit and quality commands do
not invoke it.

For a disposable full-stack HTTP target, run a command through
`bash deployment/dev-ci/run.sh <command> [args...]`; it receives
`DAYNIGHT_BASE_URL` and owns its test resources. The runner removes its
containers, volume, network and image tag after completion, failure or cancellation.

The [independent browser checks](../packages/daynight-web/README.md#independent-browser-checks)
include Project withdrawal against controlled API responses and real browser
storage; they do not establish live-service behavior.

## Public Markdown image integration

The separate `Markdown external-image integration` workflow owns the normal
public-source persistence regression for the Controller Markdown source module.
It runs when the regression or its direct capture owners change, and supports
manual dispatch. It does not add public-network dependencies to ordinary unit
tests or product E2E. The workflow builds current CLI, Go and related runtime
artifacts, uses isolated PostgreSQL and test authentication, saves one HTTP and
one HTTPS image through production source/capture/relay components, then reads
the same service resource after origin access is denied and the Controller
process has stopped. Controlled Markdown and identity inputs are identified in
the result; this does not prove native-model vision or browser rendering.

Run the workflow on a standard GitHub-hosted `ubuntu-24.04` VM. Its entry point
is `node packages/daynight/scripts/external-image-acceptance.ts --run-directory
<checkout>/.tmp/external-image-acceptance/<run-id>`. Network setup refuses local,
self-hosted and non-Linux execution. It requires Node.js 24, pnpm 11.28.6,
Go 1.27.2, Docker, Python 3, curl, iproute2, iptables, nftables and dnsutils.
The workflow prepares these tools and independently invokes the same entry
point with `--cleanup` after execution.

The job-owned Controller namespace has IPv6 disabled and an installed egress
policy. Its service/DNS exceptions compare both original and final addresses
and ports; protected targets remain denied after DNAT in INPUT and FORWARD.
Actual host addresses/routes and the two owned Docker containers/networks,
including their labels, addresses and aliases, supply the deployment inventory.
The trusted external-image profile binds its policy identity to the installed
rule digest.
Source shutdown adds a separate deny and verifies per-protocol counter increases
for probes pinned to the captured peer, without modifying product guards or
fabricating DNS, peer or TLS results. All namespace processes, network links,
firewall entries and changes to host forwarding have an owned cleanup receipt.
Cleanup confirms process exit with pidfds before deleting namespace names;
unconfirmed exit keeps the names and guards and produces a failed receipt.

The workflow uploads only the run directory's `results/`, including source
revision, image identities and hashes, network observations and cleanup
receipts. Private configuration, tokens, keys, database files and image storage
are excluded. A failed public request, changed DNS address or incomplete cleanup
remains a failure. The [integration decision](../.agents/notes/implemented/testing/2026-11-11-public-markdown-image-integration.md)
records scope and alternatives; the [source design](design/session-image-sources.md#可信部署出口配置)
owns the product deployment contract.

The network orchestrator's offline safety checks can run locally without
privileges or network changes:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 packages/daynight/scripts/external-image-network.test.py
bash -n packages/daynight/scripts/external-image-network.sh
```

## Product E2E

`packages/e2e_tests` owns the complete-product Linux runner. It compiles the CLI,
production Web and full Go Server from the current checkout, builds the pinned
unmodified UniAuth command and Console, and starts a dedicated PostgreSQL
instance and auth runtime on dedicated networks. The database network is internal;
a private ingress bridge publishes loopback ports, and the application removes
its default route before starting services.

```bash
pnpm --filter @codetreker/daynight-e2e typecheck
pnpm e2e:test:harness
pnpm e2e:test
```

The product entry performs normal browser/CLI login and same-data task workflows.
Module test jobs do not execute it. The independent `verify-e2e` Linux CI job
runs the same explicit product entry after framework types and harness checks.
Installed CLI checks retain packaging and platform responsibilities. Framework self-tests own
setup, timeout, cancellation and cleanup failures; business fault and concurrency
matrices remain in their modules.

The [Product E2E guide](../packages/e2e_tests/README.md) owns exact prerequisites,
optional pinned-source reuse, local OAuth provider behavior, source/artifact
receipts and resource cleanup. CI reserves a separate always-run recovery step
before uploading only result and log directories; it does not upload private
credentials, database data or copied artifacts. Preparation can fetch dependencies; the running
system does not require an external database, auth deployment or GitHub account.

## Local stress validation

Routine CI excludes stress workloads. Run these explicit local entrypoints when
full-scale evidence is needed:

| Workload | Repository-root command | Prerequisites |
|---|---|---|
| CLI rendering, Session-v2 archives and Controller capacity/transport | `pnpm test:stress` | Builds the CLI and selects `.stress.ts` files |
| Go query, archive and repeated-write checks | `pnpm server:test:stress` | Isolated PostgreSQL and server test environment |
| Web graph, model and geometry checks | `pnpm web:test:stress` | Web workspace dependencies |

Stress configurations and Go stress entrypoints refuse a nonempty `CI`
environment. Ordinary Go discovery omits the `stress` build tag and ordinary
Vitest discovery omits `.stress.ts` files. Local measurements establish only
their recorded source and host.

For Codex output fairness, run
`pnpm test:stress test/commands/controller/output-responsiveness.stress.ts`.
It uses a synthetic native stdout producer and an independent authenticated IPC
client against the assembled Controller runtime, with real tool projection and
SQLite. Finite cases use 400 ten-character deltas (38,000 notification bytes),
both without backlog and with approximately 2,200 events / 55 MB retained without
ACK, using single and per-frame producer writes. A separate sustained case keeps
producing until the observation response. The output records actual pipe chunks,
consumption/request/response timing, remaining input, ordered content hash and
independently checked outbox byte totals. Native Windows and Node 24 evidence is
required for the original pipe scenario; controlled provider/relay behavior does
not establish real model or service performance. Client response latency uses
the client's own clock; causal handoff and parent-local observations prove that
output consumption precedes the request while input remains. Absolute timestamps
from different processes are diagnostic, since their clock origins may differ.
The existing Codex media-stream stress suite retains its separate resource
responsibility.

## Package versions

Ordinary change PRs keep `packages/daynight/package.json` version unchanged.
PR and main CI validate affected code without comparing versions between Git
revisions.
Version selection and complete CLI publication belong to the repository's
[release-daynight skill](../.agents/skills/release-daynight/SKILL.md). It analyzes
CLI changes since the public npm `latest` source, selects patch or minor unless
an explicit version is supplied, and retains an already prepared version when
it meets the release requirements. The skill owns the classification rules,
version PR delivery, release completion evidence, and interrupted-release
reconciliation.

Publication accepts stable `x.y.z` versions. A new release must advance public
npm `latest`; existing npm versions and release tags are immutable. The
[publication procedure](#npm-publication) describes the workflow's admission,
validation, and existing-version skips. A successful skip alone does not prove
that the requested source was published. The
[version policy decision](../.agents/notes/archived/simplification/2026-11-04-release-time-versioning.md)
records why version selection belongs to release preparation.

## npm publication

The manual [`publish` workflow](../.github/workflows/publish.yml) publishes
`@codetreker/daynight` to npmjs using OIDC trusted publishing. Configure the
package's npmjs **Settings → Trusted Publisher** before running it:

| GitHub Actions setting | Value |
|---|---|
| Organization or user | `codetreker` |
| Repository | `daynight` |
| Workflow filename | `publish.yml` |
| Environment name | Leave blank |
| Allowed actions | Allow direct `npm publish` |

Staged publishing permission alone does not allow this workflow's direct
publication. A newly configured trusted publisher must complete its first
successful publication within two days; npm requires an expired configuration
to be recreated. These settings belong to npmjs and are not configured by the
repository. See npm's [trusted publishing documentation](https://docs.npmjs.com/trusted-publishers).

For an authorized release, use the
[release-daynight skill](../.agents/skills/release-daynight/SKILL.md) to select the
version and complete any protected version PR. Its publication step dispatches
the following workflow after the stable version is on `main`:

```bash
gh workflow run publish.yml --ref main
```

The workflow accepts only `main` and freezes that run's source commit. Before
validating the CLI or installing project dependencies, preflight checks the exact
`daynight-v<package-version>` tag and npm package version. Either existing
marker makes every dispatch and retry succeed with an explicit skip message,
regardless of its source or contents. A tag alone is sufficient to skip. A skip
does not download or verify the existing package, or create a missing tag.

npm metadata queries use pinned npm 12.2.0 through
`npm view @codetreker/daynight@<version> --json --registry=https://registry.npmjs.org`.
This uses npm's package-document lookup and version selection. Only npm's JSON
`E404` means the version is absent; GitHub tag absence requires HTTP 404.
Authentication, network, timeout and malformed-response errors fail visibly.
Queries use a project-local cache and have a 30-second process limit.

When both markers are absent, preparation installs frozen dependencies and runs
type checking, tests and installed acceptance explicitly for
`@codetreker/daynight` at the frozen commit. It then smoke-installs the packed
release tarball. Publication validates the CLI independently of the full
`checks.yml` workflow; Go server and Web results do not gate the npm release. The
publishing job is titled `Publish daynight v<version>`, using the version from the
prepared artifact's release receipt. Every publication attempt repeats preflight
before downloading the artifact, so versions that appeared during preparation
or an earlier attempt also skip successfully. That separate GitHub-hosted job
uses Node.js 24 and pinned pnpm 11.28.6 to publish the same artifact publicly with
provenance and the `latest` dist-tag. Development, CI and the Docker build use
the same pnpm version. The publishing job installs its own pinned CLI and invokes
it through Node without installing project dependencies.
`--pm-on-fail=ignore` prevents the workspace's package-manager pin from selecting
a different publisher. pnpm uses its own OIDC implementation; npm 12.2.0 remains
the metadata-query client. Registry configuration comes from `setup-node`, and
GitHub's OIDC environment reaches the publisher unchanged. No npm token is
required. Stable releases
are supported; prerelease versions are rejected, and a new version must advance
the public registry's current `latest` version.

The publication script checks existence again before upload. If an upload
fails, it queries the exact npm version: a confirmed existing version succeeds
as a skip, covering a concurrent duplicate publication; confirmed absence
preserves the original upload error. Failed queries remain failures.

For a new upload, publication creates `daynight-v<package-version>` at the frozen
source commit only after the public registry's source commit, SHA-512 integrity
and downloaded tarball bytes match the artifact. Existing versions and tags are
never overwritten. Public metadata and tarball visibility share one ten-minute
verification deadline after npm accepts publication. npm `E404` and tarball HTTP
404 responses are polled within that deadline, with each attempt logged. Other
errors and source or integrity mismatches fail. npm queries have a 30-second
limit; GitHub and tarball HTTP requests, including response bodies, have a
20-second limit. Verification operations share the remaining overall deadline;
the publishing job has a 15-minute limit.

A verification or tag-creation failure can leave an accepted npm package without
a tag. Re-running failed jobs, re-running all jobs and new dispatches all skip
successfully once the exact npm version or tag exists. These skips do not
complete a missing tag or claim that the existing package matches the retained
artifact. Artifacts remain available for 30 days. The workflow serializes
releases and keeps in-progress releases running. The
[npm CLI publication-check decision](../.agents/notes/archived/process/2026-10-22-npm-cli-publication-checks.md) records the rationale for lookup, skip and duplicate-publication behavior; the
[trusted-publishing decision](../.agents/notes/archived/process/2026-10-20-npm-trusted-publishing.md)
records the new-artifact identity, OIDC and public-verification choices. The
[pnpm OIDC decision](../.agents/notes/archived/process/2026-10-22-pnpm-oidc-publication.md) records the rationale for the publishing client and its configuration. The
[CLI publication-validation decision](../.agents/notes/archived/process/2026-10-22-cli-publication-validation.md) records the rationale for the release validation scope.

## CI selection

The [`checks` workflow](../.github/workflows/checks.yml) compares the explicit PR
head with its merge base using complete Git history and NUL-delimited paths.
Deletions and both sides of renames count. The
[selector](../.github/scripts/ci-modules.mts) assigns module tests by directory,
Go API integration by server and production Web build inputs, and product E2E by
its framework and production build inputs; the
[root routing table](../README.md#ci-selection) owns the summary map. Mixed
changes select their union, and unknown paths select all application jobs in
`checks`. This includes the independent shell/browser workflow's path. Selected
jobs validate the source and tests in their ordinary event checkout. Remote test PRs
do not replace test files or produce an additional composed checkout commit.
The [checkout-source decision](../.agents/notes/implemented/testing/2026-11-09-checkout-source-ci-validation.md)
owns this input boundary; each runner retains its own source/artifact receipts,
validation commands, coverage and resource-cleanup obligations.

Implementations, fixtures and test tooling select their containing module.
Production CLI, Web and Go inputs additionally select product E2E; module-only
tests and fixtures do not. Server inputs also select the independent Go API
integration job. Production Web source, resources and build configuration, root
Node inputs and dependency patches select API integration because its production
Server embeds the resulting Web bundle. Root Node inputs and patches select CLI,
Web and product E2E as well, while preserving the Go module job's directory
ownership. CLI-only changes do not select API integration. Documentation and
instruction exclusions remain effective inside directories, except for bundled
CLI source resources. Deployment changes select Web and do not become API or
product E2E inputs merely because their environments use Docker.

A PR changing only the CLI manifest's regular-file version, with no other
semantic or mode change, selects no application jobs. Routing tests and the
final gate still run; publication validates its frozen artifact separately.
Malformed manifests or Git failures fail detection.

CLI selection runs ordinary and installed phases independently on Linux,
Windows and macOS ARM64, plus Node compatibility. Completion unit tests remain
in the ordinary CLI suite. The Go module job runs its PostgreSQL-backed module
gate and uploads coverage. The independent
`verify-server-startup-shutdown` job uses the same server selection, waits only
for detection, and owns its PostgreSQL-backed command lifecycle tests and
command-package coverage. Selected Go module and startup/shutdown jobs must both
actually succeed. The independent Linux `verify-api-integration` job waits only
for detection, prepares its own Node.js, pnpm, Go and PostgreSQL service, and runs its required Linux runtime-tool
unit tests before production Web preparation and the explicit normal API suite. Its always-run
reconciliation step retains original command and cleanup failures; it uploads
only safe API build/result/log evidence. The
[API integration decision](../.agents/notes/implemented/testing/2026-11-09-independent-go-api-integration.md)
owns the scheduling and build-input rationale. Web quality owns full
typechecking, harness, production Docker Web build and coverage. Product E2E
waits only for detection and prepares its own Node.js, pnpm, Go, Chromium,
database and complete auth system.
It rebuilds every runtime product from the checked-out source, even on a
build-dependency cache hit.

The E2E job has a 40-minute outer limit. Every preparation step is bounded; all
step maxima total 38 minutes, leaving 2 minutes of job margin. The journey is
bounded to 15 minutes, followed by an always-run recovery step bounded to
3 minutes and a bounded evidence upload. Recovery uses the
saved exact run identity to remove its Docker resources and private files after
normal completion, failure or runner termination. Original scenario and cleanup
failures stay observable. Uploads include only `.tmp/product-e2e/*/results/**`
and `*/logs/**`, with 30-day retention.

Final `checks` wait for every job in that workflow. Failure and cancellation are
rejected; selected CLI, Go module, startup/shutdown, API integration, Web quality
and product E2E jobs must equal `success`, so an unexpected skip cannot pass their
gate. Routine CI excludes stress
workloads. The [test-writing rules](writing_tests.md) own test boundaries, while the
[product E2E guide](../packages/e2e_tests/README.md) owns startup and recovery.

Workflow concurrency cancels an older PR run for the same ref; main pushes queue
without cancelling an active run. Documentation-only PRs run routing tests and
the gate. Every main push selects all modules, API integration and product E2E.
npm publication performs its own CLI validation at the frozen release commit.

The separate [`shell and browser acceptance` workflow](../.github/workflows/shell-browser.yml)
contains `verify-completion` and `verify-web-browser`. It runs both jobs on every
`main` push and on `workflow_dispatch`, without module detection or a PR trigger.
Each job checks out its event's source and installs its own locked dependencies.
Shell validation retains the Bash 4.2, modern Bash and zsh behavior matrix and
artifact acceptance. Browser validation retains the complete assistant suite,
locked Playwright Chromium, its private Vite host and failure evidence. Their
job deadlines, failure propagation and resource cleanup remain independent.
Ordinary CLI tests and Web quality do not launch either suite, and final `checks`
has no dependency on either job. Product E2E's Chromium installation, selection,
execution and gate remain part of `checks`.

A successful PR `checks` result therefore does not establish hosted shell or
assistant-browser success for that PR. A `main` run validates the integrated
revision; manual dispatch and the explicit local commands provide additional
results for their own revisions and environments. The
[workflow decision](../.agents/notes/implemented/testing/2026-11-12-shell-browser-workflow.md)
records this trade-off and the preserved suite ownership.

To validate routing rules locally without application dependencies, run:

```bash
node --test .github/scripts/*.test.mts
```

## Validation

Use the development commands above for application changes. `pnpm check` covers
CLI type checking and ordinary tests; `pnpm acceptance` exercises the installed
package. Native CI records environment and fixture preparation evidence, and
shell completion writes `.tmp/completion-module-evidence.json` and
`.tmp/completion-evidence.json`. Match each result to
its tested revision, environment and scope; a local result does not establish a
successful hosted run. A failed scenario or cleanup remains a failure.

Controlled GitHub and Copilot processes do not establish live model reasoning or
publication. Such validation requires a designated repository, a non-author
reviewer identity and authorization. The
[dev-ci attachment check](../deployment/dev-ci/README.md#attachment-persistence-check)
uses Node.js 24, Go 1.27.2 and a supported Linux-container Docker engine to
validate persistence and paired backup restoration with isolated resources.

For document changes, check relative links, requirement references, status, and
note lifecycle sections. For workflow changes, also check skill frontmatter and
discovery links. Run `git diff --check` and inspect newly created files explicitly.
