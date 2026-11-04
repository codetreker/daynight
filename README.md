# Daynight

Daynight is a project and task workspace for people and coding agents. It keeps
work, dependencies, required inputs and resulting artifacts together, with a
browser dashboard for understanding progress and a command-line client for
managing tasks. A foreground worker runs automatically claimed tasks through
Codex, Claude Code or Copilot in private Herdr workspaces or browser-controlled
Task Sessions. The CLI also provides automated
GitHub pull request review through Copilot CLI.

Explore Daynight and its interactive example at **[daynight.cc](https://daynight.cc)**.
Open the **[workspace](https://daynight.cc/projects)** to continue your projects,
or run your own service. The interface supports English and Simplified Chinese.

## What you can do

- **Organize repository work.** Associate projects with Git repositories, create
  Markdown tasks, link pull requests and track `todo`, `in_progress` and `done`.
- **Understand what can start.** Model prerequisites, find ready and blocked
  tasks, and distinguish dependencies within a task chain from dependencies on
  other chains. Both kinds must be completed before dependent work starts.
- **See project progress.** Browse project statistics, task-chain progress and
  standalone tasks. Explore interactive dependency graphs with upstream context,
  task details and fullscreen reading.
- **Keep the working material with the task.** Upload designs, screenshots and
  other files; read Markdown with Mermaid flowcharts, text, images, PDFs and HTML
  previews. Task and attachment links can open directly in an independent page.
- **Discuss tasks in the browser or CLI.** Open a task's Discussion tab to read,
  post and reply as your account, with persistent history independent of Sessions.
  [Thread commands](packages/daynight/README.md#task-discussion-threads) provide
  complete messages and explicit pagination, including verified Agent attribution
  when an Agent explicitly supplies its current claim.
- **Work with coding agents.** Install the `using-daynight` skill for Codex,
  Copilot CLI or Claude Code to register work, discuss designs, execute specified
  tasks and review handoffs. Ordinary execution handles one specified task.
  Worker-started agents use an explicitly assigned managed mode; task readiness
  and agent permission remain separate from delivery authorization.
- **Control access and execution settings.** Use private projects, memberships,
  invitations and revocable CLI credentials. Set task platform requirements and
  agent permission, and view elapsed time and possible-stall warnings.
- **Run ready tasks continuously.** Use `daynight worker run` to claim eligible
  tasks across configured repositories, preserve ongoing work through restarts
  and stop ended executions while retaining resources until their cleanup
  and archive requirements are satisfied.
- **Observe and configure your Workers.** Open My Workers alongside My projects
  to see the current account's recent Workers, online/offline state, resource and
  software observations, and authorized task snapshots. Detail keeps the last
  report time and distinguishes an unknown inventory from idle work. Its
  configuration section edits cloud runtime targets and displays reported actual
  values, partial failures and Project preparation or removal outcomes. Saved
  targets remain distinct from applied results, and configuration is independent
  of the recent-report window.
- **Control a task session in the browser.** With `worker.agentControlMode: web`,
  view native messages, reasoning and tool results, send text, stop a turn, and
  answer supported approvals, questions and forms in the task’s Session tab.
- **Automate PR review.** Monitor configured GitHub repositories and retain
  per-PR worktrees, Copilot sessions and review state across restarts.

Task Steps have [CLI list/show reads, atomic CLI Add and independent persisted HTTP reads and writes](docs/spec/daynight-task-steps.md), with complete ordered content, task-local identities and the shared parent Task version.

Task creation and general editing use the CLI. The Web app provides project and
Worker browsing, Worker configuration editing, status and execution-setting
controls, task deletion, attachment management and persistent task discussions.
The [worker guide](packages/daynight/README.md#worker-configuration-and-startup)
explains configuration, native prerequisites and explicit
retry/release/resume controls. Complete platform acceptance remains
separate from command availability; the
[requirements](docs/spec/daynight-worker.md) and
[design](docs/design/daynight-worker.md) define those boundaries.

## Get started

The public introduction explains the product before sign-in; its example can be
used without an account. The **[setup guide](https://daynight.cc/setup)** walks
through installation and agent setup. Use the latest patch of Node.js 22 or newer,
then install the CLI and sign in:

```bash
npm install --global @codetreker/daynight
daynight --version
daynight login
```

Compare the terminal's code with the browser page, check the account and approve
access. For a remote terminal, use `daynight login --no-browser`. The CLI connects
to `https://daynight.cc` by default.

From a Git repository with an `origin` remote:

```bash
daynight project create "My project"
daynight task create --title "Improve installation instructions" \
  --description "Document prerequisites and verify the setup commands."
daynight task list
daynight task ready
```

`project create` returns the existing project when exactly one matches the
repository; otherwise it creates a project or reports an ambiguous match. Task
commands discover the project from the repository. Use `--project <project-id>`
to select one explicitly. Open the Web app to browse the same tasks and progress.

Read project and task usage from the installed package:

```bash
daynight --skill
```

This prints one standalone project/task reference for coding agents, including
version-safe writes, dependencies, properties and attachments. Use
`daynight --help` for other capabilities. Reading requires no login, configuration
or interactive terminal.

For agent integration, install a supported coding agent, then run:

```bash
daynight skill install
```

Select the detected agents and User or Project scope, then follow the installer's
reload instructions. For example, ask your agent: “Use using-daynight to register
a task for this project: improve the installation instructions.” The
[skill guide](packages/daynight/src/commands/skill/skills/using-daynight/SKILL.md)
explains task creation, handoff, execution and Goal workflows.

`dn` is an alias for `daynight`. Use `daynight --help` and each command's
`--help` for syntax, `daynight update` to update an npm global installation,
and the [CLI manual](packages/daynight/README.md) for detailed usage. Local business
SQLite databases upgrade automatically when an accessed file needs migration,
including through query commands. Current-format reads retain their read-only
snapshot behavior; the [migration requirements](docs/spec/cli-sqlite-migrations.md)
define supported formats, ownership blockers and failure preservation. The complete
[configuration example](packages/daynight/config.example.yml) covers service,
review and worker settings; the
[configuration guide](packages/daynight/README.md#configuration-setup) explains
customizing it and locating the copy included in the npm package.

### Shell completion

Run `daynight completion setup` to install Bash or zsh completion. The
[completion guide](packages/daynight/README.md#shell-completion) covers shell
selection, startup files and activation.

## Standalone Session testing

Run a provider in the current directory and open the printed Daynight URL:

```bash
daynight controller codex
daynight controller claude
daynight controller copilot "Explain this project"
```

These foreground commands create an independent Test Session using the configured
Daynight service and native provider credentials. The page requires Daynight
sign-in as its creator and uses the same timeline and chat controls as a Task
Session. Open `/test-sessions` on that service to find your accessible Test
Sessions that are online, without retaining their URLs. Archived history remains
accessible through its original URL and the Controller resume command. No task,
worker configuration or new worktree is required. Closing the
browser leaves the Agent running; Ctrl+C stops the owned execution and preserves
the user's working directory. See the [Controller guide](packages/daynight/README.md#standalone-controller-sessions)
for input, authentication and lifecycle limits.

## Worker configuration and startup

Use interactive setup to inspect prerequisites, choose a provider, and
select one or more existing Daynight Projects:

```bash
daynight login
daynight worker setup
daynight worker run
```

Setup reports missing tools or integration settings with repair instructions.
It previews the selected Projects, paths and native-setting resets before saving
the agent and complete selection together. Existing Projects are preselected on
repeat setup. Missing native prerequisites can be repaired after saving; the
command explicitly reports when the environment still needs attention.

The default `herdr` execution mode requires Git, Herdr 0.9.5 or newer with the supported API, and
the selected native CLI. Configure provider credentials before execution. Before
starting a native agent, runtime preflight installs or updates its official Herdr
integration through the private daemon when needed, then verifies the current
integration and effective hook configuration. Codex installation first checks
that the supported Herdr installer preserves configuration semantics; unsafe
layouts fail before installation. Setup remains read-only. Local setup checks do
not qualify real native execution, provider login or task delivery.

Set `worker.agentControlMode: web` in `~/.daynight/config.yml` to use Daynight's
Task Session page with Codex, Claude Code or Copilot. Web execution uses a private
Controller and the Daynight relay, with no Herdr dependency. Each claim retains
its original mode; a configuration change applies only to new claims. Herdr
continues to own terminal sessions in the default mode.

`repo add` lists accessible Projects for multiselection. Use `--project
PROJECT_UUID` for an explicit noninteractive registration; `worker repo list`
and `worker repo remove` inspect or change the selection. `worker run` accepts
an empty repository list without prompting and can start from an ordinary
directory. Add repositories explicitly to enable new task acquisition. Startup
saves configured Project mappings before reading its complete current claim
inventory, including after a local database reset; existing claims and cleanup
responsibilities remain managed even when no repositories are configured.

New registrations use `worker.repositoryRoot`, defaulting to `~/daynights`, and
keep existing paths when the root changes. Review's clone-root setting is
independent. Projects must already exist, and their tasks need automatic
execution permission before the worker can acquire them.

The worker runs in the foreground with one execution slot by default and stores
state under `DN_CONFIG_DIR/worker/` (default `~/.daynight/worker/`). On macOS,
each Herdr run owns a separate daemon. A durable lifecycle journal binds the
original claim, worktree, Session, terminal and process birth identities before
automatic input is allowed. Linux and Windows retain the shared private Herdr
path. Each workspace shows its task title and stable ownership suffix.

Use `daynight worker attach` in another terminal for human input, including for
paused tasks. On macOS it selects a recorded runtime and verifies the original
daemon before connecting. Detaching leaves execution running. Ctrl+C cancels
and joins Worker jobs, then stops the original execution while preserving
claims, worktrees, native history and unfinished local rows. It sends no cleanup
prompt and does not wait for a cleanup turn. Unconfirmed stopping retains
responsibility and blocks replacement; external temporary resources may remain.

Herdr fresh and resumed Copilot/Codex processes use fixed full access and
task-folder trust settings; business delivery remains bounded by task
authorization. Linux and Windows retain process-local Herdr business recovery:
a NULL native ID permits a fresh conversation, while a known ID selects resume.
On macOS, durable launch, input and stop evidence protect the original runtime;
a missing native ID after a possible launch cannot authorize another conversation.
Session registration advertises no preview, control or archive capability, and
stopped worktrees remain until archive finalization is available.

Terminal cleanup preserves its original resource identity, deadline and retry
schedule across restarts; current resource observations determine completion.
Web retains its original execution evidence and recovery pause across restarts.
An exhausted or paused Web execution keeps its claim and slot, reports waiting,
and requires explicit retry with the original native identity and complete stop
proof. See the [worker guide](packages/daynight/README.md#worker-configuration-and-startup)
and [Herdr lifecycle design](docs/design/herdr-worker-lifecycle.md) for platform,
recovery and retention boundaries.

Stop the runner before `worker retry/release/resume`; the commands use
its same instance lock. The [worker guide](packages/daynight/README.md#worker-manual-management)
explains version checks, remote-result handling and resource cleanup.

## Review configuration and startup

PR review requires Git, authenticated GitHub CLI and Copilot CLI on `PATH`:

```bash
daynight review add-repo https://github.com/OWNER/REPO.git
daynight review run
```

The reviewer runs in the foreground. Its first observation records the current
PR boundary; it tracks newly opened eligible PRs after that boundary. Use
`daynight review list` to inspect persisted local state. The
[review guide](packages/daynight/README.md#review-configuration-and-startup)
covers eligibility, reviewer identity, retries, retained sessions and shutdown.

## Self-hosting

The Go service serves the Web app and API together, with PostgreSQL for project
and task data and persistent file storage for attachments. The
[local deployment guide](deployment/localhost/README.md) provides Docker Compose
setup, required UniAuth settings, updates and paired database/file backups.
The [CLI configuration guide](packages/daynight/README.md#configuration-setup)
explains connecting to a different service.

HTML attachments execute as trusted content on the application origin. Only
upload HTML you trust with that authority.

## Repository layout

| Component | Role | Documentation |
|---|---|---|
| [`packages/daynight/`](packages/daynight/) | TypeScript CLI, task-management skill and Copilot review coordinator | [CLI manual](packages/daynight/README.md) |
| [`packages/daynight-server/`](packages/daynight-server/) | Go service, authentication, memberships, PostgreSQL and file storage | [Server guide](packages/daynight-server/README.md) |
| [`packages/daynight-web/`](packages/daynight-web/) | React/TypeScript browser workspace embedded in the service | [Web guide](packages/daynight-web/README.md) |
| [`deployment/localhost/`](deployment/localhost/) | Persistent Docker Compose deployment | [Deployment guide](deployment/localhost/README.md) |
| [`deployment/dev-ci/`](deployment/dev-ci/) | Disposable full-stack verification environment | [Dev-CI guide](deployment/dev-ci/README.md) |

## CLI development

The CLI supports Linux, Windows and Apple Silicon (ARM64) macOS. Intel macOS
is unsupported. Source development uses Node.js 24 LTS and pnpm 11.28.6. The
published CLI runs on Node.js 22 or newer. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm acceptance
```

Use `pnpm dev:install` on macOS/Linux to install a local `daynight-dev` snapshot
beside the npm CLI. It defaults to a separate `~/.daynight-dev` state root;
Agent command aliases remain opt-in. See the [development channel guide](docs/development.md#local-development-cli-channel)
for configuration, build identity and isolation limits.

These commands target the CLI. Its build publishes skill bundles and per-owner
SQLite SQL directories with the compiled dist tree; the
[development guide](docs/development.md#cli-development) owns packaging details.
Web checks use `pnpm web:typecheck`,
`pnpm web:test` and `pnpm web:build`. The server uses Go 1.27.2 and PostgreSQL
18.6; from `packages/daynight-server/`, run `bash scripts/check.sh` with
`DAYNIGHT_TEST_DATABASE_URL` pointing to an isolated database. See the
[development guide](docs/development.md) for prerequisites, native diagnostics,
browser acceptance and complete validation commands.

## Package versions

Ordinary change PRs leave the version in `packages/daynight/package.json`
unchanged. Use the repository's
[release-daynight skill](.agents/skills/release-daynight/SKILL.md) to select a
release version, deliver any version PR, publish, and verify the npm release.
The [version guide](docs/development.md#package-versions) describes ownership and
publication constraints.

### npm publication

The manual `publish.yml` workflow publishes stable CLI releases from `main`
through npm trusted publishing. Follow the
[publication guide](docs/development.md#npm-publication) for publisher setup,
release validation, existing-version skips and artifact verification.

## CI selection

The [`checks` workflow](.github/workflows/checks.yml) selects PR application jobs
from all changed paths, including deletions and both sides of renames:

| Changed paths | PR application jobs |
|---|---|
| `packages/daynight/test/fixtures/installed-cli.ts` | Every module |
| `packages/daynight/src/api/`, `packages/daynight/src/session/`, `packages/daynight/src/platform/text.ts` | CLI, Go server coverage/E2E, Web quality and Web browser acceptance |
| Implementation and resources under CLI `commands/worker/`, `controller/`, `review/`, `skill/`, `update/` or `completion/`, except `definition.ts` | CLI |
| Other `packages/daynight/src/` paths, including command definitions | CLI and Go server coverage/E2E |
| A PR changing only the CLI `package.json` top-level `version`, with unchanged regular-file mode and other parsed fields | No application jobs |
| Other CLI `package.json` changes limited to top-level `version`, JSON formatting or object key order | CLI |
| Other CLI `package.json` changes; TypeScript build configuration, example configuration, build/resource scripts and service-acceptance scripts | CLI and Go server coverage/E2E |
| Other `packages/daynight/` paths | Complete ordinary and installed CLI phases on Linux, macOS ARM64 and Windows; runtime compatibility and shell completion |
| `packages/daynight-server/` | Go server coverage and E2E |
| `packages/daynight-web/` and current Dagre and XYFlow patches | Go server coverage/E2E, Web quality and Web browser acceptance |
| Runtime files under `deployment/` | Web quality and Web browser acceptance |
| Root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc` | Every module |
| Root `.gitignore`, `docs/`, `.agents/`, `.claude/`, files named `README.md`, `AGENTS.md` or `CLAUDE.md`, manual `publish.yml` workflow | No application jobs |
| CI routing/workflow changes and other unclassified paths | Every module |

Every path under `packages/daynight/src/` selects CLI checks, including SQL
resources and bundled Markdown. The CLI loads the six independent commands above
only when selected; their implementations and resources do not select Go jobs.
Their `definition.ts` files are loaded at startup and retain server selection.
Other CLI source remains a conservative server input. The manifest comparison
uses committed merge-base and head contents, ignoring only the top-level
`version` field. Manifest additions, deletions and file-type changes select both
server jobs; malformed modified manifests fail detection. A PR with exactly one
modified path skips application jobs only when that path is the CLI manifest,
its regular-file mode is unchanged, its version string changes, and all other
parsed fields are equal. Formatting-only changes and any additional changed
path retain ordinary selection. Version-only PRs run the existing routing
checks and final gate; version and artifact validation remain in the publication
workflow. Exact preparation inputs are listed in
[the selector](.github/scripts/ci-modules.mts).

Documentation exclusions apply after CLI source ownership; changes selecting
several modules run their union. CLI selection enables independent ordinary-test
and installed-acceptance matrices on Linux and Windows, each with a 10-minute
bound per job. A required `verify-macos` job uses one macOS ARM64 allocation for
complete ordinary and installed phases in sequence, with a 20-minute outer bound
and 10-minute validation-command bounds. Each phase builds current source and
records its own environment, outcome and artifacts. The ordinary Ubuntu entry supplies
the runtime package; runtime jobs depend only on the Linux/Windows ordinary
producer matrix, while final `checks` still requires macOS. The
[single-allocation decision](.agents/notes/implemented/testing/2026-11-05-single-macos-native-allocation.md)
owns macOS failure, evidence and budget handling. The Web selector enables a quality job and two
browser matrix entries, each with a 20-minute bound. The two browser shards
jointly cover the complete native/container inventory; shard 2 owns the shared
navigation, deployment, combined-authentication and persistence checks. The
server selector enables parallel coverage and E2E jobs, also bounded to 20 minutes
each. All selected jobs are required by `checks` and retain their complete
integration and coverage gates.
The final `checks` job uses `always()` and accepts only `success` or `skipped`
from preceding jobs. Selected Web quality and browser matrix results must be
`success`; the same gate validates both current-source shard summaries and their
complete inventory before passing. A newer PR run cancels the older run for that PR.
New `main` pushes queue behind an active `main` run without cancelling it.
Documentation-only PRs run routing tests and that gate; every `main` push selects
full application validation. See the
[CI guide](docs/development.md#ci-selection) for routing and execution details.

## Validation

`pnpm check` covers CLI type checking and tests; `pnpm acceptance` exercises the
installed package. Server and Web checks have separate commands and require
statement coverage strictly greater than 90%. Routine CI suites exclude stress
workloads. Run the corresponding explicit local command when full-scale evidence
is required:

| Local workload | Command from the repository root |
|---|---|
| CLI rendering and Session-v2 archive limits | `pnpm test:stress` |
| Installed CLI production decoded-byte budgets | `pnpm test:stress:budgets` |
| Go query, archive and repeated-write workloads | `pnpm server:test:stress` |
| Web graph and geometry workloads | `pnpm web:test:stress` |
| Production browser capacity and timing matrix | `pnpm web:acceptance:stress` |

These stress entrypoints refuse a CI environment. The
[development guide](docs/development.md#local-stress-validation) owns their
prerequisites and evidence boundaries. For document changes, check local links
and anchors, newly created files and `git diff --check`.

Acceptance results belong to their tested revision, artifacts, environment and
execution scope. Controlled process fixtures do not prove live Copilot/GitHub
behavior, and a local browser run does not prove hosted-CI results. A failed
scenario or cleanup remains a failure. The
[validation guide](docs/development.md#validation) owns detailed prerequisites,
receipt identity checks and evidence limits.

## Working in the repository

Read [AGENTS.md](AGENTS.md) for scope, shared task worktrees, verification and
delivery. This repository manages concrete work in Daynight; load
[`using-daynight`](packages/daynight/src/commands/skill/skills/using-daynight/SKILL.md)
before executing a task. See the [repository skills](.agents/skills/) for
decision notes, scope choices and prose, and [Agent Notes](.agents/notes/README.md)
for decision history.

## Documentation conventions

| Location | Responsibility |
|---|---|
| `README.md` | Project purpose, capabilities, setup, development entry points and documentation conventions |
| Package READMEs and `docs/development.md` | Component usage, development, release procedures and validation methods |
| [`docs/ui-design.md`](docs/ui-design.md) | Shared UI design principles, examples and information boundaries |
| `docs/spec/` | Required product behavior and observable guarantees |
| `docs/design/` | Current structure, mechanisms, rationale and implementation boundaries |
| `docs/research/` | Investigations, evidence, sources and observation conditions |
| `.agents/notes/` | Decisions, alternatives, consequences and reconsideration conditions |
| `docs/plans/` | Git-ignored local scratch execution plans |

Keep each explanation with its owner and synchronize active facts when they
change. Preserve historical decision premises; explicit archives remain
immutable. Run-specific counts, hashes, timings and delivery results stay with
their PR and CI run. CI artifacts expire after 30 days; lasting conclusions must
remain understandable in their research or decision owner with methods, source
identity and limitations. See the
[evidence ownership decision](.agents/notes/archived/process/2026-10-20-source-bound-validation-evidence.md).

UI mockups, `mockui` pages, their resource bundles, and tests targeting them
must not be committed, including interactive previews composed from production
components. Keep local prototypes in the task worktree's Git-ignored `.tmp/`
and reviewable prototypes in their owning Daynight task's attachments.

Specifications and designs use Chinese headings and prose while preserving
technical literals. Other documents, skills, code, comments and commit messages
use English unless explicitly instructed otherwise. Discuss work in Chinese.
