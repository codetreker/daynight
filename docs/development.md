# Development and release guide

This guide covers source builds, package releases, CI selection and validation
evidence. Start with the [project introduction](../README.md) for capabilities
and first-use setup, or the [CLI manual](../packages/daynight/README.md) for
installed commands. Commands below run from the repository root unless a module
working directory is specified.

- [CLI development](#cli-development)
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
same compiled output. `pnpm build` clears the package's `dist/` before emitting
`packages/daynight/dist/main.js` and copying the explicit review and public skill
bundles into `dist/commands/review/skills/daynight-review/` and
`dist/commands/skill/skills/using-daynight/`. Complete relative resources are included;
repository workflow skills are not scanned for publication. The package's
`daynight` and `dn` bins point to the same stable JavaScript entry.
Source tests mirror `cli/`, `config/`, `api/`, `commands/` and `platform/`
ownership, with build and version-policy tests in `test/tooling/`.
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
pack/install fixture, real Git and controlled HTTP.

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

GitHub Actions runs type checking, build, and tests on native Linux, macOS, and
Windows runners. Each native job resolves the latest available Node.js 24 patch.
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
On PRs, the Linux job also enforces package version increases before ordinary
validation. It compares the PR's complete source changes with
its merge base and its package version with the event's target-branch revision.
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
suites prepare their shared source graph before copying, and version-gate tests
reuse only immutable default-base objects; scenario observations and mutations
remain private. Source snapshots are prepared through batched native Git imports,
while real clone/fetch/worktree operations remain the test subjects. Tests within
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

This first runs the shared `pnpm web:build` to publish real embedded assets, then
builds the binary, runs vet and race-enabled `go-cov`, and enforces total
statement coverage strictly greater than 90%, package coverage of at least 85%,
and function coverage of at least 80%, with critical-block checks enabled. The
same raw coverage profile supplies an exact strict comparison; exactly 90%
fails, independently of display rounding. No product files or functions are
excluded. When [CI selection](#ci-selection) selects the server, the complete
Go job contributes its result to the final `checks` job. PostgreSQL absence is a
failure, not a skipped test. The gate includes an installed-CLI service path and
resource-budget probes. A Node orchestrator shares one real installation across
the Go command scenarios and, after the unchanged go-cov/strict-profile checks,
public-command probes outside Go's default ten-minute timer. Test-only deadline
mocks use a 1-second request and 3-second operation budget while separately
asserting the installed production defaults of 30 seconds and five minutes.
The 128 MiB single-response and 256 MiB cumulative decoded-byte probes keep
real exact-limit and +1-byte tests. Each receipt identifies actual deadlines and
mock status. The Go job retains its 20-minute bound and complete validation
workload. The [acceptance design](../docs/design/daynight-project-task.md#验证与交付证据)
owns the mechanism and source-bound evidence. The
[server validation guide](../packages/daynight-server/README.md#built-process-acceptance-and-ci-evidence) maps
requirements to tests and describes the CI receipt containing tested source and
binary identity, scenario results and resource cleanup.

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

For the frontend-only recent-task preview, open
`/tests/mockups/recent-tasks.html` on the origin printed by `pnpm web:dev`. It
mounts the production project page, styles and locale catalog with controlled
read-only synchronization responses. Its `#mixed`, `#completed`, `#empty`,
`#loading` and `#failure` scenarios cover 20-entry pagination, full Goal children,
local-calendar recency, 100% recent completion and recovery without a Go service
or PostgreSQL. These responses demonstrate frontend behavior; they do not prove
real service or deployment behavior.

For the frontend-only attachment mockup, run `pnpm web:dev` and open
`/tests/mockups/attachments.html` on the origin printed by Vite. It uses the real
attachment UI with in-memory metadata and local fixture files; it needs no Go
service or PostgreSQL. It exercises the detail tabs, adjacent panes, tall
content and attachment loading, empty, failure and busy states. Production builds
keep the single application index and exclude these fixture entry points. The [web README](../packages/daynight-web/README.md#task-attachments)
explains previews and the mockup's evidence limits.

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
parallel. It runs native functional workflows, then the container workflows and
complete container cleanup, and finally the fixed native capacity cases. It
requires Go 1.27.2, Docker, Node 24, pnpm 11.28.6 and Playwright Chromium. The
[web README](../packages/daynight-web/README.md#production-browser-acceptance) owns
browser setup, required gates and receipt interpretation.

## Package versions

Changes to `packages/daynight/src/`, either package manifest, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `.npmrc`, either application TypeScript configuration, or
the package's build-cleanup script require a strictly greater SemVer in `packages/daynight/package.json`. Source
additions, deletions and moves all count. Unchanged versions, downgrades and
build-metadata-only changes fail. Tests, fixtures, documentation, CI workflows
and validation scripts alone do not require a version increase. CI enforces this
policy in the PR's Linux CLI job using the event's explicit base and head commits.

Update the version in the same PR as the code. To check committed revisions
locally, run `pnpm version:check pull_request <base-sha> <head-sha>` or
`pnpm version:check push <before-sha> <after-sha>`. The command reads versions
from those commits; uncommitted files do not affect the result. The local push
mode compares the complete before/after range; an all-zero before SHA validates
the starting version without a predecessor comparison. Missing history,
unreadable manifests and invalid versions fail visibly. The
[toolchain decision](../.agents/notes/archived/process/2026-10-16-typescript-cli-toolchain.md)
records the original comparison and CI ownership choices.

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

After merging a stable package version to `main`, run:

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
Other documentation exclusions apply before module selection. The `.gitignore`
exclusion matches only the repository root; nested ignore files retain their
module ownership or the unclassified-path fallback. An excluded path does not
suppress jobs selected by other changed files. New modules and unclassified
patches select all jobs until their consumers are explicitly assigned.

Selected jobs keep their complete checks, coverage thresholds, acceptance suites,
timeouts and cleanup requirements. The Go job still builds real web assets and
exercises the installed CLI; the web job still builds and exercises the Go
service and production deployment. Selecting one module does not split these
existing integration suites. The same Web selector enables quality and browser
jobs; both are required by the final gate. The Ubuntu shell-completion and Web
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
`checks` job requires both and every other selected module; shared workflow
changes retain all-module selection.

The internal `quality` mode of `scripts/ci.mts` runs the canonical Web Node harness
and the complete Vitest/V8 suite with its strict statement checker serially,
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
container preparation still overlap; native functional checks and browser cleanup
precede the container browser permission release. The permission wait remains
900 seconds. Core preparation, functional phases, full container cleanup and
browser recovery finish before native capacity. Independent quality checks run
on their own runner and do not add empty core phases or split browser scenarios.
The [quality isolation decision](../.agents/notes/implemented/testing/2026-10-26-web-quality-job-isolation.md)
records the responsibility and budget boundaries without claiming a measured
CPU/I/O cause or guaranteed hosted speedup.
Both Go-consuming jobs restore module and compiler caches keyed by the server
`go.sum`, while the server check expires test results before database/race/
coverage validation. The web pipeline retains the full production build and
unique image identity check. One packed/installed CLI is reused by the native
and container browser attachment journeys. After the web pipeline and recorded
resource recovery, Ubuntu web CI runs the existing real-container attachment
persistence and paired-backup check once; its `.tmp/attachment-deployment-*/`
evidence is archived with the browser/deployment evidence. The
[acceptance pipeline decision](../.agents/notes/archived/testing/2026-10-21-web-acceptance-pipeline.md)
records the scheduling and phase-evidence choices; the
[CI efficiency decision](../.agents/notes/archived/testing/2026-10-21-ci-validation-efficiency.md)
retains the other workload optimizations and their limits.

The final `checks` job always runs after routing and application jobs. It accepts
only `success` or `skipped` from every preceding job; failures, cancellations and
other results fail the gate. It uses those job results without comparing module
selection flags. Documentation-only PRs run routing tests and this final gate
without installing application dependencies or running application tests. Every
`main` push retains full application validation. npm publication runs its own
CLI validation at the frozen release commit. Package-version enforcement belongs
to PR validation. The
[selection decision](../.agents/notes/archived/process/2026-10-21-module-scoped-pr-ci.md)
records the routing alternatives and maintenance costs; the
[CI simplification decision](../.agents/notes/archived/simplification/2026-10-21-ci-gate-simplification.md)
records the version-check timing and final job-result gate choices.

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
