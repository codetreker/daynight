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
`pnpm-workspace.yaml`. Runtime review also requires
Git, authenticated GitHub CLI and Copilot CLI on PATH. The inspected
`better-sqlite3` 13.0.3 Linux x64 prebuild requires `GLIBC_2.34` and
`GLIBCXX_3.4.29`; these observed symbol requirements constrain older distributions
and do not establish compatibility for other distributions, architectures or
musl. Native validation must identify its actual operating system and architecture.
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
runs ordinary tests and installed acceptance independently on Linux and Windows.
macOS uses one allocation for the same two complete phases in sequence. Both
logical phases retain all three platforms, their own validation build and
outcome, and 10-minute validation bounds; the ordinary phase also typechecks and
tests the local development installer. The macOS job shares dependency setup and
has a 20-minute outer limit. Ordinary suites exclude `.stress.ts` files; explicit
local stress commands select those workloads separately, as described in
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
The pnpm dependency store is local to `.tmp/pnpm-store`. Native skill terminal
acceptance uses the development-only `node-pty` dependency, including Windows
ConPTY. The workspace build policy permits only the pinned node-pty hook and
keeps the existing SQLite build-hook suppression. Linux builds its native
terminal addon with the available compiler/Python toolchain; macOS and Windows
use the packaged prebuild when available. A version-pinned pnpm patch restores
missing Darwin helper executable bits in the stable terminal dependency. The
[native terminal decision](../.agents/notes/archived/testing/2026-10-21-native-skill-terminal-acceptance.md)
records the test isolation and stream separation. Installer acceptance constructs
Agent launcher fixtures and verifies they are never run. Static bundle tests own
frontmatter, mode references and published task-command guidance; existing
project/task suites own service and task semantics. `pnpm acceptance`
separately packs and installs the CLI in a local consumer and requires package-
registry access. The review lifecycle suite uses controlled GitHub/Copilot
executables with real Git and SQLite. The self-update suite uses real npm and an
isolated, task-local global prefix with a controlled HTTP registry. Neither suite
changes the operator's installed CLI or requires live review credentials.
Project/task acceptance is a third native installed suite using the shared
packed production installation, real Git and controlled HTTP. Vitest prepares
default PNPM shims once and gives consumers private runtime state or writable
package views. Non-Vitest standalone consumers retain owned preparation with
PNPM's supported POSIX executable-link preference; npm global updates remain real.

Project/task runtime/view preparation and self-update's initial package/global
installation belong to case-owned setup hooks. The complete ordered business
scenarios remain in their callbacks. Both use the existing 180-second hook and
180-second callback limits. Installed validation keeps a 10-minute bound, either
in its independent Linux/Windows job or its own phase of the 20-minute macOS job.
Separating these allowances changes budget ownership; it does not mean the old
scenario-total allowance or total runtime is unchanged. Teardown aborts and
awaits pending preparation/behavior, reaps owned processes, closes registries
and removes private trees before publishing successful cleanup receipts. The
[hosted-runner and preparation decision](../.agents/notes/archived/testing/2026-11-03-macos-hosted-runner-capacity.md)
records the platform, linking and lifecycle rationale.

Shell completion has a separate real-shell acceptance command. It requires
Python 3 on a POSIX host, Bash 4.2, a modern Bash, and zsh. Linux hosts can prepare
isolated shell executables from the repository root:

```bash
bash packages/daynight/scripts/prepare-completion-shells.sh
source .tmp/shell-completion/environment.sh
pnpm completion:acceptance
```

The preparation helper downloads a SHA-256-pinned GNU Bash 4.2 release and builds
its executable in `.tmp/shell-completion/`. It requires standard build tools,
`curl`, `sha256sum`, `tar` and `timeout`. It uses an existing zsh when available;
otherwise it downloads Debian packages with `apt-get download` and extracts them
locally with `dpkg-deb`. It installs no global packages. First-time preparation
requires network access; subsequent runs reuse the local toolchains.

On other POSIX hosts, or to select existing executables, set `DAYNIGHT_TEST_BASH42`
to the Bash 4.2 executable before running `pnpm completion:acceptance`.
`DAYNIGHT_TEST_BASH` and `DAYNIGHT_TEST_ZSH` select the other executables and default
to `bash` and `zsh`. `DAYNIGHT_TEST_ZSH_ROOT` optionally selects an extracted zsh
toolchain root. `DAYNIGHT_COMPLETION_EVIDENCE` optionally selects the JSON receipt
path. The command builds the client and runs a Python PTY harness against actual
Tab insertion in all three shells. It also installs setup into isolated startup
files and checks real login and interactive shell loading, repeated installation
and completion registration. It uses task-local fixtures, with no user
configuration, review credentials or installed CLI changes.
A dedicated Ubuntu 24.04 CI job runs this suite separately from the native CLI
matrix; its result belongs to the tested revision. The
[completion design](../docs/design/daynight-completion.md) owns its coverage and
loading guarantees.

Native development and validation support Linux, Windows and Apple Silicon
(ARM64) macOS. Intel macOS is unsupported. GitHub Actions runs type checking,
build and tests on native Linux, macOS 15 ARM64 and Windows runners. macOS uses
the standard `macos-15` label for one `verify-macos` allocation, retaining Darwin
ARM64 verification and the complete ordinary and installed phases. The [platform decision](../.agents/notes/archived/testing/2026-11-04-macos-arm64-support.md) records the rationale for the support boundary; the [image availability decision](../.agents/notes/implemented/testing/2026-11-05-macos-ci-image-availability.md)
records the explicit image selection and its limits. Hosted capacity failures
require diagnosis within this ARM64 runner policy, and a supported label still
requires real allocation and complete native test results.
Each native job resolves the latest available Node.js 24 patch.
The ordinary Ubuntu job builds and packs the Node.js 24 artifact consumed by the
separate runtime matrix. Runtime jobs wait for the ordinary Linux/Windows
producer matrix, without an installed-acceptance or macOS dependency, and check
that packed artifact with Node.js
`22.14.0`, the latest `22` and `24` releases, and current
`node`. Each runtime installs it in a fresh npm consumer with `--engine-strict`
and exercises CLI commands, interactive prompt dependencies and SQLite. These
checks cover the published package and its production dependency graph without
requiring the source-development toolchain on each supported runtime.
PRs select complete module jobs from their changed paths; the
[CI selection rules](#ci-selection) define shared inputs and exclusions for
documentation and repository metadata. A selected CLI runs both phases on every
native platform, the runtime compatibility matrix and the dedicated Linux shell
completion job. Both Linux/Windows matrices and the macOS job need only module
detection. Within macOS, installed validation runs after ordinary validation even
if the latter fails, provided shared preparation and architecture checks passed
and the job was not cancelled. Ordinary environment/probe uploads run before the
fixed receipt paths are cleared and the installed recorder starts. Each phase
retains its own outcome, artifacts, build and cleanup; an ordinary failure still
fails the job and final gate. The [phase ownership decision](../.agents/notes/archived/testing/2026-11-04-parallel-native-cli-validation.md)
records the original parallel model; the [single macOS allocation decision](../.agents/notes/implemented/testing/2026-11-05-single-macos-native-allocation.md)
owns its partial replacement, failure handling and budget trade-off.
Main pushes run every module. The checkout includes the required history.
Native tool discovery records command resolution, launcher, PID, timing, status
and bounded output in `.tmp/validation-probes.json`. Before executing `gh`, it
reads the selected file sequentially and records its byte count, SHA-256 and
preparation duration. Resolution, preparation and native execution share one
10-second gh budget; expired preparation or an over-budget native result fails
the probe. The version child uses isolated project-local configuration/state and
disabled telemetry. A separate diagnostic artifact uploads after validation even
when environment discovery fails. Ordinary environment and diagnostic artifacts
use `daynight-cli-tests-*` and `daynight-cli-tests-probes-*` names; installed
receipts and diagnostics use `daynight-cli-installed-*` and
`daynight-cli-installed-probes-*`. The installed receipts include the environment,
curated acceptance outputs and canonical preparation/cleanup result. Every
native version and both complete phase workloads remain required whenever CLI
validation is selected. Linux/Windows phases each have a 600-second job gate;
macOS retains a 600-second limit per validation phase inside one 1200-second
job, including shared setup and uploads. The
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
Git repositories, IPC and Controller pending-content files retain their own
private filesystem fixtures. The
[memory SQLite decision](../.agents/notes/implemented/testing/2026-11-06-cli-memory-sqlite-tests.md)
owns storage selection and connection ownership.
GitHub tests use controlled API responses and subprocess fixtures to verify
complete scans, HTTP failures, and atomic observation commits.
Git lifecycle tests use local origin/clone fixtures and real worktrees to check
captured targets, disposable review artifacts, shared refs, and isolation between
PR worktrees. Independent Git suites run in separate Vitest workers. Review suites
copy immutable bare-origin seeds into private test directories; refs,
SQLite databases, clones and worktrees remain separate for every case. Sparse
suites prepare their shared source graph before copying; scenario observations
and mutations remain private. Source snapshots are prepared through batched
native Git imports, while real clone/fetch/worktree operations remain the test
subjects. Worker worktree cases separately copy file-owned starting repositories
for the files and reftable backends. Direct mutation checks verify independent
tracked bytes, refs and Git objects in each copy. The
[Worker seed decision](../.agents/notes/archived/testing/2026-11-04-worker-git-fixture-seeds.md) records the rationale for that fixture lifetime. Tests within a file stay sequential so environment
changes and cleanup have one owner.
The [Git test decision](../.agents/notes/archived/testing/2026-10-18-parallel-git-validation.md)
records the isolation rules, and the
[CI timing report](../docs/research/windows-ci-performance.md) records native
before/after measurements. The repository-discovery submodule case prepares its
real Git fixture in a case-scoped hook before exercising discovery, retaining
separate setup and behavior limits and the existing private-directory cleanup.
The [fixture lifecycle decision](../.agents/notes/archived/testing/2026-10-22-submodule-discovery-fixture-lifecycle.md)
records that separation. The installed acceptance suite additionally verifies the package
bin, default native command shims, singleton/stale-lock behavior and the complete
review/re-review/restart/closure lifecycle. Its Vitest global setup packs and
installs the production package once per platform invocation. Consumers own
private runtime directories; manual, SQL-resource and review lifecycle mutation
uses private CLI package files with shared read-only dependencies. Global
teardown checks the canonical package bytes and removes that installation after
all consumers finish. Consumer receipts report runtime cleanup separately from
the canonical preparation receipt in `.tmp/installed-cli-preparation.json`.
The [shared preparation decision](../.agents/notes/archived/testing/2026-11-04-shared-installed-cli-preparation.md) records the rationale for installation, view and cleanup responsibilities. Separate npm global-prefix
acceptance checks self-update and installation ownership. Curated environment and scenario
receipts are uploaded by each native CI job; [validation](#validation) describes
their scope and interpretation. Controlled Copilot executables exercise retained sessions, durable
launch intent, stdin prompts and streamed completion/failure handling. These
checks require no live model invocation or GitHub publication.

## Local development CLI channel

The repository's [prepare-daynight-local skill](../.agents/skills/prepare-daynight-local/SKILL.md)
guides GitHub test-repository preparation and environment refresh across the local
site, development CLI and Worker. It covers isolated state, directory command
routing, automatic test identities and a CLI/website/Agent test loop using only
localhost fixtures. Its runtime checks include WebSocket Upgrade forwarding and
the native Provider environment; normal Worker recovery preserves the original
claim and Session without replaying confirmed input. Browser testing uses an
isolated headless Edge instance by default. Real OAuth and device consent remain
separate optional checks. The [UI audit reference](../.agents/skills/prepare-daynight-local/references/ui-audit.md)
guides user-path exploration, representative fixtures, responsive and interaction
checks, and the distinction between confirmed issues and candidates. Evidence
capture binds selected page state to its artifact; a local package validator
checks files and hashes before individual production handoff. Each confirmed
improvement has its own task, evidence, prototype and acceptance criteria.
Retesting merged fixes and correcting demonstrated false positives improve the
reusable audit guidance while local fixtures remain separate from delivery work.

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

The command requires the five authentication settings in that private file,
builds the UI and server inside Docker, applies embedded migrations and waits for
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

Read the [server organization rules](daynight-server.md) before adding to, changing,
or reviewing daynight-server.

Use Go 1.27.2, PostgreSQL 18.6, Node.js 24 LTS and pnpm 11.28.6. Run
`pnpm install --frozen-lockfile` and `pnpm web:build` from the repository root
as a separate asset-preparation step before Go validation or local Go stress. The
[server module](../packages/daynight-server/README.md) owns configuration, startup,
the isolated database setup and complete validation commands. Its HTTP runtime
binds only numeric loopback addresses and serves authenticated project/task,
task-chain graph, task-summary sync, membership, invitation and attachment routes
with embedded UI.
The five mandatory authentication settings and independent HTTP test switches
are described in the server module and deployment guides.

From `packages/daynight-server/`, set `DAYNIGHT_TEST_DATABASE_URL` to an isolated
PostgreSQL database, then run:

```bash
bash scripts/check.sh
```

The entrypoint consumes the prepared real embedded Web assets and prepares the
pinned UniAuth fixture, then builds the service, runs vet and validates Go module
tests and coverage. It accepts no validation-mode flags, does not install package
dependencies or build JavaScript, and does not build, install or execute the CLI.
Missing generated assets fail the Go embed compilation. Node runs the Go-owned
coverage and fixture scripts using builtin modules; the Go entrypoint needs no
pnpm or frontend dependency installation.
PostgreSQL is mandatory; a missing URL or unavailable database fails validation.

The pinned `go-cov` gate requires statement coverage strictly greater than 90%,
package coverage of at least 85% and function coverage of at least 80%, with
critical-block checks enabled. The raw profile supplies the exact total
comparison; exactly 90% fails independently of display rounding. No production
files, functions or packages are excluded. The complete production package list
supplies `-coverpkg` so assembled Go tests also measure their DAO calls.

TaskGraph exact-limit fixtures collect planner statistics after their complete
bulk graph load. Their real PostgreSQL traversal, 1000-node backbone, 5000
references and independent overflow assertions remain part of ordinary validation;
the [server fixture guide](../packages/daynight-server/README.md#task-graph-boundary-fixtures)
owns the preparation boundary.

`DAYNIGHT_TEST_RACE` accepts only literal `true` or `false`. Its absent local
value enables race instrumentation; the workflow supplies `false` for PR events
and `true` for main pushes. The [server race policy](../packages/daynight-server/README.md#race-instrumentation)
owns the command and inherited `GOFLAGS` behavior. Module tests retain their
normal boundary, failure, transaction and concurrency responsibilities.

When CI selects the server, `build-web-assets` independently installs Web build
dependencies and compiles the production resources, with no Web tests. Its
`daynight-web-assets` artifact records the source revision and tree. The
`verify-server` job requires that producer, validates the downloaded identity
and consumes the real assets without pnpm setup, dependency installation or a
JavaScript build. Go validation has its own PostgreSQL and a 20-minute bound.
CI invokes go-cov `v0.1.0` directly and writes module `coverage.out`, then applies
the separate exact raw-profile checker. The local supervised runner keeps its
existing commit pin and `.tmp/coverage.out`; the CI command does not use that
wrapper. The final `checks` job requires both selected results. The
[server validation guide](../packages/daynight-server/README.md#go-module-validation-and-ci-evidence)
owns the raw profile and evidence interpretation; the
[Go validation boundary](../.agents/notes/implemented/testing/2026-11-06-go-module-validation-boundary.md)
records the removal of cross-product acceptance from the Go module gate.

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
the language selector, open public `/setup` in a new tab. Its expanded bilingual steps cover CLI
installation, device login, repository project discovery or creation, Agent skill
installation and registering a first task. Commands stay selectable and provide
copy feedback; the current origin is informational. The guide mounts outside the
authenticated shell and makes no API requests, including identity or provider
discovery, on direct access, reload, language changes or foreground return.
The [guide decision](../.agents/notes/archived/architecture/2026-10-26-public-setup-guide.md) records the rationale for its boundaries; [Web requirements](../docs/spec/daynight-web.md#日常使用引导)
own the complete outcomes. With the Go API running on loopback, use:

```text
pnpm web:dev
pnpm web:typecheck
pnpm web:build
pnpm web:test
```

The frontend build emits `packages/daynight-web/dist/`, validates its HTML and
assets, and publishes a complete replacement into the Go embed directory. A
clean Go build without generated assets fails; no placeholder UI is committed.
Web validation runs typecheck, production build, controlled-fetch UI tests,
isolated deployment lifecycle fixtures and an exact statement gate strictly
above 90%. Quality independently enumerates all product TypeScript/TSX files and
publishes raw counters plus a relative source manifest. When
[CI selection](#ci-selection) selects Web, quality and both browser shards
contribute their required results to the final `checks` job; existing root CLI
commands retain their scope.

For a disposable full-stack HTTP target, run a command through
`bash deployment/dev-ci/run.sh <command> [args...]`; it receives
`DAYNIGHT_BASE_URL` and owns only its unique test project. The runner removes its
containers, volume, network and image tag after completion, failure or cancellation,
and records cleanup failures.

`pnpm web:acceptance` builds production UI and a native Go executable, creates an
owned PostgreSQL instance and starts the normal dev-ci production build in
parallel. After shared CLI preparation, it overlaps thirty-six native functional
workflows with the same container workflows, then requires complete target and
shared CLI cleanup. The explicit local
`pnpm web:acceptance:stress` command adds the fixed native capacity cases after
those phases. Both modes require Go 1.27.2, Docker, Node 24, pnpm 11.28.6 and
Playwright Chromium. The
[web README](../packages/daynight-web/README.md#production-browser-acceptance) owns
browser setup, required gates and receipt interpretation.

## Local stress validation

Routine CI validates observable behavior, failures, concurrency and complete
product-source coverage without executing stress workloads. Full-scale graph,
archive, rendering and decoded-byte workloads use explicit local entrypoints:

| Workload | Repository-root command | Prerequisites and output |
|---|---|---|
| CLI rendering and full Session-v2 archives | `pnpm test:stress` | Builds the CLI and selects `.stress.ts` files with `vitest.stress.config.ts` |
| Go query, archive and repeated-write checks | `pnpm server:test:stress` | Requires separately prepared real Web assets, isolated PostgreSQL and the server test environment; invokes stress-tagged Go packages with race detection |
| Web graph/model/geometry scale checks | `pnpm web:test:stress` | Selects Web `.stress.ts` files with `vitest.stress.config.ts` |
| Production browser capacity matrix | `pnpm web:acceptance:stress` | Uses the production browser prerequisites and adds five native capacity/limit scenarios with their original measurements and budgets |

The stress configs, raw workload entrypoints and Go stress tests reject a
nonempty `CI` environment before creating stress fixtures. Ordinary Go discovery
omits files with the `stress` build tag; ordinary Vitest discovery omits
`.stress.ts` files, and ordinary Playwright discovery excludes the capacity spec.
The package-local commands are documented by their owners. From the server
module, `bash scripts/stress.sh` runs its query, archive and repeated-write
workloads. Go module validation does not run installed-CLI byte-budget probes.

Web evidence records `mode: functional` or `mode: stress`:
local functional mode requires thirty-six scenarios per target (72 total);
CI partitions that inventory into disjoint eighteen-case selections per
target. Shard receipts additionally identify `shard` and `selection`, and the
final gate requires their complete canonical union. Stress mode remains local
and unsharded, adds five native capacity scenarios (41 native / 36 container,
77 total) and `native/capacity/performance.json`. Both local modes retain strict
source/browser identity, combined authentication and owned-resource cleanup;
CI shard 2 owns both combined journeys while each shard owns its full cleanup. Local measurements prove only their recorded source and host;
they do not establish hosted PR latency.

The [local stress decision](../.agents/notes/archived/testing/2026-11-03-local-stress-suites.md)
records the workload split and retained correctness guarantees.

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

The [`checks` workflow](../.github/workflows/checks.yml) runs a lightweight routing
job for every PR. It compares the event's explicit head with its merge base,
using the complete Git history and NUL-delimited paths. Deletions count; a rename
counts at both its old and new paths. Application jobs test the PR merge result.
Multiple affected modules select the union of their jobs.

The [root README routing table](../README.md#ci-selection) owns path selection.

Every path under `packages/daynight/src/` selects CLI validation, including
runtime Markdown such as the bundled review skill's `SKILL.md` or `README.md`.
The CLI command registry loads the implementations of `worker`, `controller`,
`review`, `skill`, `update` and `completion` only when selected. Implementation
and resource changes within those command directories select only CLI checks;
their `definition.ts` files remain server inputs because the registry imports
definitions at startup. Other CLI source conservatively selects Go validation,
including shared startup and project/task/authentication code. This conservative
routing is separate from the Go gate's module-only execution boundary. The
browser-consumed `src/api/` and `src/session/` trees and exact `src/platform/text.ts` path additionally select Web quality and
browser validation. Changes to these command-loading or shared-code relationships
must keep the selector's ownership rules aligned with the actual imports.

For a modified CLI `package.json`, detection reads the committed merge-base and
PR head blobs, parses both JSON objects and compares them after removing only
the top-level `version` field. Equality omits server jobs. Any other semantic
difference, including dependency versions, scripts, package contents or nested
`version` fields, retains server selection; array order remains significant.
Additions, deletions and file-type changes select server jobs conservatively.
Invalid modified manifests and Git read failures fail detection. The checkout
contents and changes made only on the target branch do not determine this
comparison. Root manifests, the lockfile and workspace inputs keep all-module
selection.

When the complete PR diff contains exactly one modified path, that path is the
CLI manifest, its regular-file mode is unchanged, its version string changes,
and all other parsed fields remain equal, detection selects no application
jobs. The existing routing checks and final gate still run. Formatting-only
changes, executable-bit changes and any additional changed path retain ordinary
path selection, including excluded documentation paths alongside a version
change. This distinction keeps the exception tied to a complete version-only
PR rather than an individual file. Version validity, packaging and installed
artifact validation remain in the existing publication workflow. The
[version-only PR decision](../.agents/notes/archived/testing/2026-11-04-version-only-pr-ci.md)
records the rationale and retained publication responsibilities.

The exact build/configuration and acceptance-script inputs in
[the selector](../.github/scripts/ci-modules.mts) select CLI and Go validation.
Web source and its Dagre/XYFlow patches select Go validation because the service
embeds their built assets; the build itself belongs to the separate producer. Documentation exclusions apply after CLI source
ownership. The `.gitignore` exclusion matches only the repository root; nested
ignore files retain their module ownership or the unclassified-path fallback.
An excluded path does not suppress jobs selected by other changed files. New
modules and unclassified patches select all jobs until their consumers are
explicitly assigned. The [server input decision](../.agents/notes/archived/testing/2026-11-04-server-ci-input-selection.md)
records the dependency boundary and its maintenance cost.

Selected jobs keep their ordinary functional checks, coverage thresholds,
timeouts and cleanup requirements. Stress workloads have explicit local-only
entrypoints and are excluded from routine CI selection. Go validation consumes
source-validated assets from the separate Web build producer and prepares
PostgreSQL and UniAuth without installing the CLI or building frontend source;
each Web browser shard still builds and
exercises its own Go service and production deployment.
The same Web selector enables quality and both browser matrix entries; all are required by the final gate. The Ubuntu shell-completion and Web
browser jobs select the
official HTTPS Ubuntu archive and security services before package preparation.
Their shared command changes only the runner's referenced mirror list; signed
source stanzas and package indices remain intact. An unexpected source layout
fails explicitly. The [mirror decision](../.agents/notes/archived/testing/2026-10-22-ubuntu-package-mirrors.md)
records the provisioning failure and the retained acceptance limits.
Each native phase builds current source for its own validation. Linux/Windows
ordinary and installed phases use independent jobs; macOS shares checkout and
dependency setup, then retains a separate build for each serial phase. The
separate runtime compatibility matrix checks
the packed CLI installation across the supported Node.js range. The Web selector
enables `verify-web-quality` and two `verify-web` matrix entries, each with a
20-minute bound. Shared workflow changes retain all-module selection.

The internal `quality` mode of `scripts/ci.mts` runs the canonical Web Node harness,
the ordinary Vitest/V8 suite and the strict statement checker serially. Harness
has a 180-second deadline and collection has a 300-second deadline; final source-inventory and
coverage verification has an independent 60-second deadline. The
[stage budget decision](../.agents/notes/archived/testing/2026-11-04-web-coverage-finalization-budget.md)
keeps a completed collection from consuming its final verification budget.
Only the Vitest/V8 subprocess uses four workers
through its copied environment, retaining the `forks` pool and file isolation.
The [worker capacity decision](../.agents/notes/archived/testing/2026-10-28-web-quality-worker-capacity.md)
calibrates that setting for the dedicated public standard Linux runner's four
CPUs; it does not change inputs, assertions or coverage gates.

Each browser entry invokes `browser --shard=1/2` or `browser --shard=2/2`, installs
pinned Chromium/Linux dependencies under the existing 600-second bound, and
builds its own real native and container deployments. Case selection uses
`--fully-parallel --workers=1 --retries=0 --shard=i/2`; every database still runs
one worker serially. Complete and selected discovery use the same functional
arguments as execution and the canonical scenario inventory. Current selections
contain eighteen cases each and jointly cover all thirty-six scenarios per target. The selected IDs and shard identity remain in the existing run evidence.
The container callback reads its validated source/run-bound parent selection.

Within each entry, native and container preparation overlap. Once native
preparation has installed the shared CLI, an atomic source/run-bound permission
releases the container functional browser alongside the native functional
browser. Its permission wait remains 900 seconds. Each phase has a separate
private profile root outside uploaded artifacts. Command wrappers require
owned groups to stop after settlement; failures and cancellation still fail.
Both targets drain before run-wide CLI recovery, preserving active commands and
credentials in the other target. The
[functional target decision](../.agents/notes/archived/testing/2026-11-04-web-functional-target-overlap.md) records the rationale for those isolation constraints.

Chromium installation completes before CI starts acceptance. A validated optional
navigation request in the existing source/run receipt makes the container callback
run serial navigation alongside its functional browser, after permission and
installed-CLI validation. Both branches drain before combined-authentication
restart and callback exit, keeping network teardown outside navigation. Their
hosts, output directories, profiles and API fixtures remain separate. Navigation
command environments omit the production browser-ownership marker while retaining
browser-channel and tool settings. Navigation
command cancellation uses a one-second escalation grace inside the callback's
outer termination grace, preserving verification deadlines. The
[browser job scheduling decision](../.agents/notes/implemented/testing/2026-11-06-web-browser-job-overlap.md)
owns cancellation, concurrency and measurement limits.

Shard 2 owns all 28 navigation-contract cases, dev-ci lifecycle fixtures, both
ten-check combined-authentication journeys and the existing real attachment
persistence/paired-backup-restoration check. That ownership derives from the
shard identity. Both entries retain functional, image identity, process,
browser and resource cleanup requirements. Matrix `fail-fast` is false so the
other entry can finish its diagnostics and cleanup after a failure.
Local ordinary acceptance remains complete and unsharded; local stress adds
capacity only after the same functional/container/browser/CLI barriers and
rejects a shard combination before preparation.

The existing final `checks` job first applies its general preceding-job gate.
For selected Web validation it also requires quality and the browser matrix to
succeed, checks out current source, sets up Node 24, and downloads exactly
`daynight-web-summary-1` and `daynight-web-summary-2`. Each contains only the
existing `runID/evidence.json`. The install-free report CLI validates two distinct
run IDs, shard identities 1/2 and 2/2, clean passing receipts at `GITHUB_SHA` and
the checkout tree, exact native/container inventories and cleanup, disjoint
canonical coverage and both combined receipts only on shard 2. Missing,
inconsistent or incomplete summaries fail the same required job. Full browser
artifacts are `daynight-web-acceptance-1` and `daynight-web-acceptance-2`; coverage
remains separate. Artifacts retain 30 days. The
[two-shard decision](../.agents/notes/archived/testing/2026-11-04-web-ci-case-shards.md)
records duplication costs and the limits of the estimated critical path.

Quality checks retain their independent responsibility and command budgets;
the [quality isolation decision](../.agents/notes/archived/testing/2026-10-26-web-quality-job-isolation.md)
records that separation and its rationale. Standard
Playwright JSON reports expose named phases for the largest journeys. Selected
status journeys share worker-owned API/CLI credentials and a project while
retaining fresh per-case API contexts, browser login and artifact validation;
permission, platform and assignment share only a project. Worker restart or a
different service origin cannot reuse another worker's prepared resources. The
[shared preparation decision](../.agents/notes/archived/testing/2026-11-04-web-scenario-preparation.md) records the rationale for those resource lifetimes. The
[Web validation guide](../packages/daynight-web/README.md#production-browser-acceptance)
owns detailed receipt and wall-time interpretation rules.
The Go validation and Web browser jobs restore module and compiler caches keyed
by the server `go.sum`. Go validation expires test results before database and
coverage checks.
Race instrumentation follows the PR/main/local policy described above.
The web pipeline retains the full production build and unique image identity check. One packed/installed CLI is reused by the native
and container browser attachment journeys. After the web pipeline and recorded
resource recovery, Ubuntu browser shard 2 runs the existing real-container
attachment persistence and paired-backup check once; its `.tmp/attachment-deployment-*/`
evidence is archived with the browser/deployment evidence. The
[acceptance pipeline decision](../.agents/notes/archived/testing/2026-10-21-web-acceptance-pipeline.md)
records the scheduling and phase-evidence choices; the
[CI efficiency decision](../.agents/notes/archived/testing/2026-10-21-ci-validation-efficiency.md)
retains the other workload optimizations and their limits.

The final `checks` job uses `always()` to run after routing and application jobs,
including failed or cancelled validation. Its general gate accepts only
`success` or `skipped` from every preceding job. For selected Web validation,
quality and the browser matrix must specifically succeed and both summaries
must validate; a skipped selected job cannot establish complete Web acceptance.

Workflow concurrency groups runs by workflow and ref. A newer PR run cancels an
older run for that PR. For `refs/heads/main`, `cancel-in-progress` is false: new
pushes queue behind the active run without cancelling it. GitHub may replace an
older pending run with a newer pending run in the same group.
The [main CI continuity decision](../.agents/notes/archived/process/2026-11-03-main-ci-continuity.md)
records the concurrency and aggregation policy.
Documentation-only PRs run routing tests and this final gate
without installing application dependencies or running application tests. Every
`main` push retains full application validation. npm publication runs its own
CLI validation at the frozen release commit. Version-only PRs skip application
checks; publication retains its version and artifact validation as described
under [package versions](#package-versions). The
[selection decision](../.agents/notes/archived/process/2026-10-21-module-scoped-pr-ci.md)
records the routing alternatives and maintenance costs; the
[CI simplification decision](../.agents/notes/archived/simplification/2026-10-21-ci-gate-simplification.md)
records the earlier PR version-check timing and the retained final job-result
gate choices. The [cancellation decision](../.agents/notes/archived/bug-fix/2026-11-03-cancelled-workflow-gate.md)
preserves the earlier rationale for stopping aggregation during cancellation.

To validate the routing rules locally without application dependencies, run:

```bash
node --test .github/scripts/*.test.mts
```

## Validation

Use the development commands above for application changes. `pnpm check` covers
ordinary type/build/test validation; `pnpm acceptance` exercises the installed
package. The suite uses Git 2.48+ for its relative-worktree fixture. Each native CI
job uploads `.tmp/validation-environment.json`, `.tmp/e2e-evidence.json`,
`.tmp/update-evidence.json` and `.tmp/project-task-evidence.json`, recording the
tested source and platform, scenario outcomes and owned-resource cleanup. Shell
completion has a separate `.tmp/completion-evidence.json` receipt. Match each
receipt to its tested revision and execution scope; local or controlled receipts
do not establish a successful current-source hosted run. Shared packed-CLI and
Web source records require `source.gitTreeSha` from actual
`git rev-parse HEAD^{tree}`. Commit, tree, dirty state,
package and artifact identities must agree at handoff and recovery. Missing or
mismatched tree data fails validation. Tree equality identifies committed content;
it does not fingerprint dirty changes or prove an executed gate, platform result
or reviewer decision. A failed scenario or cleanup remains a failure even when
other results pass.

The [lifecycle cross-layer acceptance decision](../.agents/notes/archived/testing/2026-10-22-task-lifecycle-cross-layer-acceptance.md)
records the same-data packed-CLI/production-Web journey and the historical Go
installed-process and migration proof. The current Web fixture retains its
normal source, fault and cleanup ownership; historical Go process receipts do
not describe the current module validation entrypoint. Native project/task HTTP fixtures remain controlled client evidence;
actual Go/PostgreSQL and native/container browser receipts remain separate.
Installed skill checks validate the six shipped resources, metadata, contained
references and bounded cross-resource instruction contracts on actual package and
target copies. Simulated launchers and instruction artifacts do not establish
live Agent behavior or waive the existing native terminal checks.

The review lifecycle uses controlled GitHub and Copilot processes. Native Copilot
loading probes establish skill activation under their recorded conditions.
Live model reasoning and GitHub publication require separate acceptance with a
designated repository, non-author reviewer identity and authorization. That
acceptance observes reviewed heads, retained session UUIDs, remote inline reviews
and approvals, restart continuity and closure cleanup. Missing-marker recovery
must reconcile confirmed publication while retaining the same session; controlled
publication receipts do not establish live model behavior. The
[installed CLI decision](../.agents/notes/archived/testing/2026-10-17-installed-cli-acceptance.md)
owns the lifecycle rationale; the [bundled-skill decision](../.agents/notes/archived/architecture/2026-10-20-bundled-review-skill.md)
owns native loading evidence.

The [dev-ci attachment check](../deployment/dev-ci/README.md#attachment-persistence-check)
runs with `node deployment/dev-ci/tests/attachments.mts` using Node.js 24,
Go 1.27.2 and a supported Linux-container Docker engine. An architecture-matching
prebuilt fixture can replace host preparation as documented by dev-ci. Two isolated production builds verify attachment-volume permissions,
restart/recreation persistence, project isolation, paired PostgreSQL/file restore
and targeted cleanup. The Bash runner fixture remains a separate orchestration
check; real-container evidence is required for persistence claims.

For document changes, check relative links, requirement references, status, and
note lifecycle sections. For workflow changes, also check skill frontmatter and
discovery links. Run `git diff --check` and inspect newly created files explicitly.
