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
typechecks and builds once, then invokes both Vitest configurations against that
same compiled output. Ordinary suites exclude `.stress.ts` files; explicit
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
Source tests mirror `cli/`, `config/`, `api/`, `commands/` and `platform/`
ownership, with build and version-policy tests in `test/tooling/`. Large binary
payload and copied-resource assertions use `Buffer.equals` to check every byte
and the total length.
Controller IPC admission tests keep real sockets, assert the production timeout
and its cancellation, and accelerate the incomplete socket's native expiry;
virtual time separately exercises the authenticated response wait. The
[test timing decision](../.agents/notes/implemented/testing/2026-11-04-cli-test-time-and-bytes.md)
explains the distinction between Node socket timers and global fake timers.
Controller and Worker lifecycle fixtures record production poll requests while
using short native promise-timer ticks for their controlled resource states.
Their tests retain exact cadence, deadline clipping and cancellation assertions;
the [coordinator polling decision](../.agents/notes/implemented/testing/2026-11-04-coordinator-test-polling.md)
owns that test boundary.
Native supervisor fixtures use production observation budgets and a controlled
parent clock only after a real TERM receipt and native signal-observation window.
The [native fixture decision](../.agents/notes/implemented/testing/2026-11-04-native-supervisor-fixture-clock.md)
records the real-process proof and cleanup requirements.
The native fsmonitor regression uses a real hook's invocation marker to qualify
ordinary Git and verify protected-query suppression. Its
[fixture decision](../.agents/notes/implemented/testing/2026-11-04-fsmonitor-fixture-marker.md)
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
Project/task acceptance is a third native installed suite using a reusable
pack/install fixture, real Git and controlled HTTP. Repeated private consumers
use PNPM's supported POSIX executable-link preference; the independent e2e
consumer still exercises default PNPM shims, and npm global updates remain real.

Project/task installation preparation and self-update's initial package/global
installation belong to case-owned setup hooks. The complete ordered business
scenarios remain in their callbacks. Both use the existing 180-second hook and
180-second callback limits, while the native job keeps its 10-minute limit.
Separating these allowances changes budget ownership; it does not mean the old
scenario-total allowance or total runtime is unchanged. Teardown aborts and
awaits pending preparation/behavior, reaps owned processes, closes registries
and removes private trees before publishing successful cleanup receipts. The
[hosted-runner and preparation decision](../.agents/notes/implemented/testing/2026-11-03-macos-hosted-runner-capacity.md)
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
build and tests on native Linux, macOS 26 ARM64 and Windows runners. The macOS
job uses the standard `macos-26` label and verifies Darwin ARM64 before validation;
the [platform decision](../.agents/notes/implemented/testing/2026-11-04-macos-arm64-support.md)
records the support boundary and runner selection. Hosted capacity failures
require diagnosis within this ARM64 runner policy.
Each native job resolves the latest available Node.js 24 patch.
A separate runtime matrix builds the package with Node.js 24 and checks the packed
artifact with Node.js `22.14.0`, the latest `22` and `24` releases, and current
`node`. Each runtime installs it in a fresh npm consumer with `--engine-strict`
and exercises CLI commands, interactive prompt dependencies and SQLite. These
checks cover the published package and its production dependency graph without
requiring the source-development toolchain on each supported runtime.
PRs select complete module jobs from their changed paths; the
[CI selection rules](#ci-selection) define shared inputs and exclusions for
documentation and repository metadata. A selected CLI runs every native platform,
the runtime compatibility matrix and the dedicated Linux shell completion job.
Main pushes run every module. The checkout includes the required history.
Native tool discovery records command resolution, launcher, PID, timing, status
and bounded output in `.tmp/validation-probes.json`. Before executing `gh`, it
reads the selected file sequentially and records its byte count, SHA-256 and
preparation duration. Resolution, preparation and native execution share one
10-second gh budget; expired preparation or an over-budget native result fails
the probe. The version child uses isolated project-local configuration/state and
disabled telemetry. A separate diagnostic artifact uploads after validation even
when environment discovery fails. Every native version, the complete validation
workload and the 600-second platform gate remain required whenever CLI validation
is selected. The
[cold-start decision](../.agents/notes/archived/bug-fix/2026-10-20-gh-cold-start-preparation.md)
records the measurements, deadline semantics and remaining limits.

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
SQLite tests use real disk databases, including reopen, transaction rollback,
locking, and revision/retry transitions on every platform.
GitHub tests use controlled API responses and subprocess fixtures to verify
complete scans, HTTP failures, and atomic observation commits.
Git lifecycle tests use local origin/clone fixtures and real worktrees to check
captured targets, disposable review artifacts, shared refs, and isolation between
PR worktrees. Independent Git suites run in separate Vitest workers. Each suite
copies its immutable bare-origin seed into private test directories; refs,
SQLite databases, clones and worktrees remain separate for every case. Sparse
suites prepare their shared source graph before copying; scenario observations
and mutations remain private. Source snapshots are prepared through batched
native Git imports, while real clone/fetch/worktree operations remain the test
subjects. Tests within
a file stay sequential so environment changes and cleanup have one owner.
The [Git test decision](../.agents/notes/archived/testing/2026-10-18-parallel-git-validation.md)
records the isolation rules, and the
[CI timing report](../docs/research/windows-ci-performance.md) records native
before/after measurements. The repository-discovery submodule case prepares its
real Git fixture in a case-scoped hook before exercising discovery, retaining
separate setup and behavior limits and the existing private-directory cleanup.
The [fixture lifecycle decision](../.agents/notes/implemented/testing/2026-10-22-submodule-discovery-fixture-lifecycle.md)
records that separation. The installed acceptance suite additionally verifies the package
bin, default native command shims, singleton/stale-lock behavior and the complete
review/re-review/restart/closure lifecycle. Separate npm global-prefix acceptance
checks self-update and installation ownership. Curated environment and scenario
receipts are uploaded by each native CI job; [validation](#validation) describes
their scope and interpretation. Controlled Copilot executables exercise retained sessions, durable
launch intent, stdin prompts and streamed completion/failure handling. These
checks require no live model invocation or GitHub publication.

## Local development CLI channel

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

Use Go 1.27.2, PostgreSQL 18.6, Node.js 24 LTS and pnpm 11.28.6. Run
`pnpm install --frozen-lockfile` from the repository root before source builds. The
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

The complete entrypoint prepares real embedded Web assets and the pinned UniAuth
fixture, then runs coverage and E2E validation in sequence. Select either
responsibility independently with `bash scripts/check.sh --coverage` or
`bash scripts/check.sh --e2e`; each prepares its own required inputs and installed
CLI. Both require PostgreSQL, whose absence fails validation.

Coverage validation builds the binary, runs vet and race-enabled `go-cov`, and
enforces total statement coverage strictly greater than 90%, package coverage of
at least 85%, and function coverage of at least 80%, with critical-block checks
enabled. The raw profile supplies an exact strict comparison; exactly 90% fails
independently of display rounding. No production files or functions are excluded.
Only the test-only `cmd/e2e_tests` package is removed from coverage execution;
a recursive source check rejects non-test Go files there before validation.

The coverage installation supports the authentication package's installed-CLI
assertions and its normally issued PAT handoff to two public-command deadline
probes. These probes run outside Go's ten-minute timer. Test-only mocks use a
1-second request and 3-second operation budget while separately asserting the
installed production defaults of 30 seconds and five minutes. The four 128 MiB
single-response and 256 MiB cumulative decoded-byte probes run only through the
explicit local stress entrypoint, preserving real exact-limit and +1-byte tests.
Each receipt identifies actual deadlines and mock status.

E2E validation runs the complete `cmd/e2e_tests` package with race detection,
`-count=1` and a ten-minute timeout, including its freshly built race-enabled
server and independent installed CLI. It owns built-process scenarios and
source/artifact provenance, concurrency, refusal and cleanup assertions. It does
not consume the coverage installation or run deadline probes.

When [CI selection](#ci-selection) selects the server, `verify-server` and
`verify-server-e2e` run concurrently on separate runners, each with its own
PostgreSQL and a 20-minute bound; both contribute to the final `checks` job.
The [server validation guide](../packages/daynight-server/README.md#built-process-acceptance-and-ci-evidence)
owns receipt paths, resource ownership and requirement-to-test mappings, and the
[CI split decision](../.agents/notes/implemented/testing/2026-11-04-server-e2e-ci-jobs.md)
records the execution boundary and retained gates.

## Web development

The private [web workspace](../packages/daynight-web/README.md) implements the project
list, cursor paging, safe API decoding, cancellation, project statistics, task
graphs, complete task details in centered dialogs or independent pages, and
single-file attachment management. An open project or standalone detail synchronizes
its IndexedDB summary base every five seconds while visible, pauses automatic
reads while hidden and synchronizes immediately on return. The current mount must
complete a user-matched online sync before displaying persisted private data.
Full details reuse matching intrinsic cached content, perform a live read on
opening and refresh on business-version changes or recovery needs.
Refresh retains browsing state and the mounted details, including attachment
inputs and previews. Failed reads keep prior data with an error and recover on a
later successful read; unavailable resources are cleared. The
[automatic refresh decision](../.agents/notes/implemented/feature/2026-10-22-project-task-auto-refresh.md)
owns scheduling, request priority and retained-state guarantees. Its
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
The [guide decision](../.agents/notes/implemented/architecture/2026-10-26-public-setup-guide.md)
owns its boundaries; [Web requirements](../docs/spec/daynight-web.md#日常使用引导)
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
The web job runs typecheck, production build, controlled-fetch UI tests, isolated
deployment lifecycle fixtures and an exact statement gate strictly
above 90%. It independently enumerates all product TypeScript/TSX files and
publishes raw counters plus a relative source manifest. When
[CI selection](#ci-selection) selects web, the complete job contributes its result
to the final `checks` job; existing root CLI commands retain their scope.

For a disposable full-stack HTTP target, run a command through
`bash deployment/dev-ci/run.sh <command> [args...]`; it receives
`DAYNIGHT_BASE_URL` and owns only its unique test project. The runner removes its
containers, volume, network and image tag after completion, failure or cancellation,
and records cleanup failures.

`pnpm web:acceptance` builds production UI and a native Go executable, creates an
owned PostgreSQL instance and starts the normal dev-ci production build in
parallel. After shared CLI preparation, it overlaps thirty-two native functional
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
| Installed CLI production byte budgets | `pnpm test:stress:budgets` | Requires the server validation prerequisites and isolated `DAYNIGHT_TEST_DATABASE_URL`; writes `.tmp/project-task-stress-evidence.json` |
| Go query, archive and repeated-write checks | `pnpm server:test:stress` | Requires isolated PostgreSQL and the server test environment; invokes the explicit stress-tagged packages with race detection |
| Web graph/model/geometry scale checks | `pnpm web:test:stress` | Selects Web `.stress.ts` files with `vitest.stress.config.ts` |
| Production browser capacity matrix | `pnpm web:acceptance:stress` | Uses the production browser prerequisites and adds five native capacity/limit scenarios with their original measurements and budgets |

The stress configs, raw workload entrypoints and Go stress tests reject a
nonempty `CI` environment before creating stress fixtures. Ordinary Go discovery
omits files with the `stress` build tag; ordinary Vitest discovery omits
`.stress.ts` files, and ordinary Playwright discovery excludes the capacity spec.
The package-local commands are documented by their owners. From the server
module, `bash scripts/stress.sh` runs its query, archive and repeated-write
workloads; `bash scripts/check.sh --stress-budgets` selects the installed CLI's
four full-byte probes in coverage validation and then runs the complete E2E suite.

Default CLI service acceptance retains two bounded deadline probes and
`.tmp/project-task-service-evidence.json`. The separate stress receipt preserves
the unchanged 128 MiB/256 MiB exact-limit and +1-byte observations without
claiming CI execution. Web evidence records `mode: functional` or `mode: stress`:
functional mode requires thirty-two scenarios per target (64 total); stress mode
adds five native capacity scenarios (37 native / 32 container, 69 total) and
`native/capacity/performance.json`. Both
modes retain strict source/browser identity, combined authentication and owned
resource cleanup. Local measurements prove only their recorded source and host;
they do not establish hosted PR latency.

The [local stress decision](../.agents/notes/implemented/testing/2026-11-03-local-stress-suites.md)
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
[version policy decision](../.agents/notes/implemented/simplification/2026-11-04-release-time-versioning.md)
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
[npm CLI publication-check decision](../.agents/notes/implemented/process/2026-10-22-npm-cli-publication-checks.md)
owns lookup, skip and duplicate-publication behavior; the
[trusted-publishing decision](../.agents/notes/archived/process/2026-10-20-npm-trusted-publishing.md)
records the new-artifact identity, OIDC and public-verification choices. The
[pnpm OIDC decision](../.agents/notes/implemented/process/2026-10-22-pnpm-oidc-publication.md)
owns the publishing client and its configuration. The
[CLI publication-validation decision](../.agents/notes/implemented/process/2026-10-22-cli-publication-validation.md)
owns the release validation scope.

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
definitions at startup. Other CLI source conservatively selects both Go jobs,
including the shared startup code and project/task/authentication commands used
by installed-CLI acceptance. The browser-consumed `src/api/` and `src/session/`
trees and exact `src/platform/text.ts` path additionally select Web quality and
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
and all other parsed fields remain equal, detection selects only
`verify-release`. This Ubuntu/Node.js 24 job uses the existing publication
preparation command to validate stable version syntax and pack the built CLI.
It installs that tarball into an isolated consumer, requires both `daynight` and
`dn` to report the manifest version, and executes both aliases' `--help`.
The ordinary CLI platform, Node compatibility and completion matrices are
skipped for this case. Formatting-only changes, executable-bit changes and any
additional changed path retain ordinary path selection, including excluded
documentation paths alongside a version change. This distinction keeps the
exception tied to a complete version-only PR rather than an individual file.
The [release-only validation decision](../.agents/notes/implemented/testing/2026-11-04-version-only-pr-ci.md)
records the rationale and retained publication responsibilities.

The exact build/configuration and acceptance-script inputs in
[the selector](../.github/scripts/ci-modules.mts) select CLI and both server jobs.
Web source and its Dagre/XYFlow patches select both server jobs because those jobs
build embedded Web assets. Documentation exclusions apply after CLI source
ownership. The `.gitignore` exclusion matches only the repository root; nested
ignore files retain their module ownership or the unclassified-path fallback.
An excluded path does not suppress jobs selected by other changed files. New
modules and unclassified patches select all jobs until their consumers are
explicitly assigned. The [server input decision](../.agents/notes/implemented/testing/2026-11-04-server-ci-input-selection.md)
records the dependency boundary and its maintenance cost.

Selected jobs keep their ordinary functional checks, coverage thresholds,
timeouts and cleanup requirements. Stress workloads have explicit local-only
entrypoints and are excluded from routine CI selection. The Go coverage and E2E
jobs each build real Web assets and install the CLI; the Web browser job builds
and exercises the Go service and production deployment. Both server jobs use the
same server selector and prepare independent PostgreSQL and UniAuth resources.
The same Web selector enables quality and browser jobs; both are required by the final gate. The Ubuntu shell-completion and Web
browser jobs select the
official HTTPS Ubuntu archive and security services before package preparation.
Their shared command changes only the runner's referenced mirror list; signed
source stanzas and package indices remain intact. An unexpected source layout
fails explicitly. The [mirror decision](../.agents/notes/implemented/testing/2026-10-22-ubuntu-package-mirrors.md)
records the provisioning failure and the retained acceptance limits.
Native CLI jobs typecheck and build once before running ordinary and installed
tests against the same output. The separate runtime compatibility matrix checks
the packed CLI installation across the supported Node.js range. Web quality and
browser acceptance run in parallel jobs, `verify-web-quality` and `verify-web`, each with a 20-minute bound. The final
`checks` job requires both and every other selected job, including the release
smoke check; shared workflow changes retain all-module selection.

The internal `quality` mode of `scripts/ci.mts` runs the canonical Web Node harness
and the ordinary Vitest/V8 suite with its strict statement checker serially,
each with a 180-second deadline. Only the coverage subprocess uses four workers
through its copied environment, retaining the `forks` pool and file isolation.
The [worker capacity decision](../.agents/notes/implemented/testing/2026-10-28-web-quality-worker-capacity.md)
calibrates that existing setting for the dedicated public standard Linux
runner's four CPUs; it does not change inputs, assertions or coverage gates.
The `browser` mode installs pinned Chromium and Linux dependencies under the
existing 600-second bound, then invokes ordinary core acceptance after the job's
deployment fixture checks. The wrapper checks that each command's owned process
group stopped after settlement, preserving both command and cleanup failures.

The core has no quality/browser preparation callbacks or readiness-admission
observer. Local acceptance uses its existing installed browser. Native and
container preparation overlap. Once native preparation has installed the shared
CLI, an atomic source/run-bound permission releases the container functional
browser alongside the native functional browser. Each target retains one worker,
zero retries and its complete inventory. The permission wait remains 900 seconds.
Each browser phase uses a separate private profile root outside uploaded
artifacts. Run-wide CLI recovery waits until both targets have drained, preserving
active commands and credentials in the other target. Combined CLI commands
receive cancellation and retain individual process-group checks.
Ordinary CI completes after both functional targets, combined authentication,
full container cleanup, browser recovery and shared CLI recovery. Explicit local
stress acceptance adds native capacity only after those phases finish.
Independent quality checks run on their own runner and do not add empty core
phases or split functional browser scenarios. The
[functional target decision](../.agents/notes/implemented/testing/2026-11-04-web-functional-target-overlap.md)
records the isolation and scheduling constraints.
The [quality isolation decision](../.agents/notes/implemented/testing/2026-10-26-web-quality-job-isolation.md)
records the responsibility and budget boundaries without claiming a measured
CPU/I/O cause or guaranteed hosted speedup.
The Go coverage, Go E2E and Web browser jobs restore module and compiler caches
keyed by the server `go.sum`. Coverage validation expires Go test results before
database/race/coverage checks; E2E uses `-count=1` to require fresh observations.
The web pipeline retains the full production build and unique image identity check. One packed/installed CLI is reused by the native
and container browser attachment journeys. After the web pipeline and recorded
resource recovery, Ubuntu web CI runs the existing real-container attachment
persistence and paired-backup check once; its `.tmp/attachment-deployment-*/`
evidence is archived with the browser/deployment evidence. The
[acceptance pipeline decision](../.agents/notes/archived/testing/2026-10-21-web-acceptance-pipeline.md)
records the scheduling and phase-evidence choices; the
[CI efficiency decision](../.agents/notes/archived/testing/2026-10-21-ci-validation-efficiency.md)
retains the other workload optimizations and their limits.

The final `checks` job uses `always()` to run after routing and application jobs,
including failed or cancelled validation. It accepts only `success` or `skipped`
from every preceding job; any other result fails the gate. The gate uses job
results without comparing module selection flags.

Workflow concurrency groups runs by workflow and ref. A newer PR run cancels an
older run for that PR. For `refs/heads/main`, `cancel-in-progress` is false: new
pushes queue behind the active run without cancelling it. GitHub may replace an
older pending run with a newer pending run in the same group.
The [main CI continuity decision](../.agents/notes/implemented/process/2026-11-03-main-ci-continuity.md)
records the concurrency and aggregation policy.
Documentation-only PRs run routing tests and this final gate
without installing application dependencies or running application tests. Every
`main` push retains full application validation. npm publication runs its own
CLI validation at the frozen release commit. The version-only PR smoke check
does not publish or query npm; publication retains its independent version and
artifact checks as described under [package versions](#package-versions). The
[selection decision](../.agents/notes/archived/process/2026-10-21-module-scoped-pr-ci.md)
records the routing alternatives and maintenance costs; the
[CI simplification decision](../.agents/notes/archived/simplification/2026-10-21-ci-gate-simplification.md)
records the earlier PR version-check timing and the retained final job-result
gate choices. The [cancellation decision](../.agents/notes/implemented/bug-fix/2026-11-03-cancelled-workflow-gate.md)
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
`git rev-parse HEAD^{tree}`; Go acceptance records the same tree as root
`gitTreeSha` and verifies it against the installed CLI. Commit, tree, dirty state,
package and artifact identities must agree at handoff and recovery. Missing or
mismatched tree data fails validation. Tree equality identifies committed content;
it does not fingerprint dirty changes or prove an executed gate, platform result
or reviewer decision. A failed scenario or cleanup remains a failure even when
other results pass.

The [lifecycle cross-layer acceptance decision](../.agents/notes/implemented/testing/2026-10-22-task-lifecycle-cross-layer-acceptance.md)
owns the same-data packed-CLI/production-Web journey, real installed-process
competition and genuine historical-SQL startup/restart proof. These extend the
existing service and browser fixtures, with their normal source, fault and cleanup
ownership. Native project/task HTTP fixtures remain controlled client evidence;
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
