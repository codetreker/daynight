# Daynight

Daynight is a project and task workspace for people and coding agents. It keeps
work, dependencies, required inputs and resulting artifacts together, with a
browser dashboard for understanding progress and a command-line client for
managing tasks. A foreground worker runs automatically claimed tasks through
Codex, Claude Code or Copilot in private Herdr workspaces or browser-controlled
Task Sessions. The same Worker hosts named assistants in ordinary directories,
with shared browser conversations and Daynight CLI access. The CLI also provides automated
GitHub pull request review through Copilot CLI.

Explore Daynight and its interactive example at **[daynight.cc](https://daynight.cc)**.
Open the **[workspace](https://daynight.cc/projects)** to continue your projects,
or run your own service. The interface supports English and Simplified Chinese.

## What you can do

- **Organize repository work.** Associate projects with Git repositories, create
  Markdown tasks, link pull requests and track `todo`, `in_progress`, `done` and `cancelled`.
- **Understand what can start.** Model prerequisites, find ready and blocked
  tasks, and distinguish dependencies within a task chain from dependencies on
  other chains. Both kinds must be completed before dependent work starts.
- **See project progress.** Browse project statistics, task-chain progress and
  standalone tasks. Explore interactive dependency graphs with direct external
  prerequisites, card navigation to their tasks or Goals, task details and
  fullscreen reading.
- **Keep the working material with the task.** Upload designs, screenshots and
  other files; read Markdown with stable Mermaid diagrams, text, images, PDFs and HTML
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
  tasks across selected, prepared Projects, preserve ongoing work through restarts
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
- **Read and control task sessions in the browser.** Project members can view
  Session content. With `worker.agentControlMode: web`, the Session owner can send
  text, stop a turn, and answer supported approvals, questions and forms; other
  administrators and members are read-only.
- **Keep an assistant available.** Open Assistants in the workspace and create one
  with just a name. A compatible online Worker supplies the directory and Agent;
  advanced settings allow explicit choices. Switch conversations, inspect details
  and close or reopen the chat without stopping its Agent. Assistants use the CLI
  for system queries and authorized operations across accessible projects.
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
daynight project create "My project" --confirm
daynight task create --title "Improve installation instructions" \
  --description "Document prerequisites and verify the setup commands."
daynight task list
daynight task ready
```

`project create` returns the existing project when exactly one accessible project
matches the repository, and reports multiple matches as ambiguous. Only a new
project uses `--team <uuid|personal>`, the configured default Team, or Personal
when no default exists. Omit `--confirm` for interactive confirmation; a
noninteractive creation requires it. Task commands discover the project from the
repository. Use `--project <project-id>` to select one explicitly. Open the Web
app to browse the same tasks and progress.

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

## Assistants

Keep `daynight worker run` running on a machine with a configured native Agent,
then open **Assistants** in the workspace. No repository registration or separate
Controller command is required. Create with a name, or expand advanced settings
to choose a Worker, ordinary directory and Agent. Older Workers without assistant
hosting reports remain visible as unsupported and cannot be selected automatically.

The Worker remains a foreground process: closing a browser does not stop an
assistant, but an offline or stopped Worker cannot execute requests. Normal Worker
restart resumes the original native conversation when its identity and stop
evidence are available; uncertain execution is reported without starting an
empty replacement or replaying input.

Deleting an assistant removes its Daynight conversation and private execution
files after verified stopping. It leaves independently created tasks, working
directories and Provider-owned native history intact. Webhook/MCP integrations,
automatic migration and OS service installation are not provided. Existing
standalone Test Sessions remain separate and are not converted automatically.
See the [assistant guide](packages/daynight/README.md#bot-management) for CLI
commands, authentication, lifecycle and failure handling.

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

Before the first cloud enrollment, use interactive setup to inspect prerequisites,
choose a provider, and select existing Daynight Projects:

```bash
daynight login
daynight worker setup
daynight worker run
```

Setup reports missing tools or integration settings with repair instructions.
It previews the selected Projects, paths and native-setting resets before saving
the agent and complete selection together. Existing Projects are preselected on
repeat setup before enrollment. Missing native prerequisites can be repaired after
saving; the command explicitly reports when the environment still needs attention.

The first run imports local managed settings only when no cloud target exists.
After enrollment the cloud configuration resource owns concurrency, Project
selection, global and Project-level Agent/model/args, polling and recovery limits.
Local setup and repository edits direct managed changes to cloud management;
repository paths, credentials, Worker identity and agentControlMode remain local.
Startup checks the cloud before normal scheduling. Heartbeats receive targets
and report actual application outcomes independently of task polling; settings
apply separately, and failed items retain errors for the next accepted report.
Running native processes keep their launch arguments. The
[configuration contract](docs/spec/daynight-worker-configuration.md) and
[worker guide](packages/daynight/README.md#worker-configuration-and-startup)
define ownership, retries and recovery boundaries.

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

Before enrollment, `repo add` lists accessible Projects for multiselection. Use
`--project PROJECT_UUID` for an explicit noninteractive registration;
`worker repo list` and `worker repo remove` inspect or change local registrations.
Normal `worker run` does not open a Project picker. An empty cloud selection keeps
heartbeats active and does not create fictitious Task resources. Existing claims,
cleanup responsibilities and local mappings remain available for reconciliation;
only selected Projects with confirmed local preparation become eligible for
execution. A Project without a prepared binding remains pending.

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
| [`packages/daynight-server/`](packages/daynight-server/) | Go service, authentication, memberships, PostgreSQL and file storage | [Server guide](packages/daynight-server/README.md), [organization rules](docs/daynight-server.md) |
| [`packages/daynight-web/`](packages/daynight-web/) | React/TypeScript browser workspace embedded in the service | [Web guide](packages/daynight-web/README.md) |
| [`packages/e2e_tests/`](packages/e2e_tests/) | Isolated normal workflows across compiled CLI, production Web, Server and auth | [Product E2E guide](packages/e2e_tests/README.md) |
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
`pnpm web:test`, `pnpm web:test:browser` and `pnpm web:build`. The server uses Go 1.27.2 and PostgreSQL
18.6; from `packages/daynight-server/`, run `bash scripts/check.sh` with
`DAYNIGHT_TEST_DATABASE_URL` pointing to an isolated database. Task HTTP, complete
Session core and Webhook service unit suites run independently without
PostgreSQL; the
[server test guide](packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns their focused commands and dependency boundaries. The regular
[Session HTTP unit suite](packages/daynight-server/README.md#session-http-tests)
also runs without a database or gateway, exercising actual routes, credential
middleware and HTTP/WebSocket/TCP transport with direct Session use-case mocks.
Normal Go API flows use the separate
[API integration runner](packages/daynight-server/README.md#go-api-integration),
which builds the production Server and uses a Go HTTP client with real
authentication and an isolated database. See the
[development guide](docs/development.md) for prerequisites, native diagnostics
and module validation commands. `pnpm e2e:test` separately builds and runs the complete
product with isolated PostgreSQL and full UniAuth; the [Product E2E guide](packages/e2e_tests/README.md)
owns its Linux prerequisites, authentication topology and cleanup.

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

The [`checks` workflow](.github/workflows/checks.yml) selects PR jobs from all
changed paths, including deletions and both sides of renames. Module jobs follow
module ownership. The independent product E2E job follows the framework and its
actual production build inputs. Mixed changes select the union of their jobs.
The [selector](.github/scripts/ci-modules.mts) owns exact path rules; the
[development guide](docs/development.md#ci-selection) owns execution details.
Main pushes select every module and product E2E. Each selected job runs its ordinary event checkout and
its checked-in tests. Validation does not compose remote test PRs or require
pairing receipts; the [checkout-source decision](.agents/notes/implemented/testing/2026-11-09-checkout-source-ci-validation.md)
preserves the source boundary and normal gates.

| Changed paths | PR application jobs |
|---|---|
| CLI production source, manifest, build configuration and resources | CLI and product E2E |
| CLI tests and other CLI/installer test tooling | CLI |
| Go production source, embedded data and module dependencies | Go and product E2E |
| Go tests, fixtures and validation tooling | Go |
| Web production source, resources and build inputs | Web and product E2E |
| Web tests, other Web validation tooling and `deployment/` | Web |
| `packages/e2e_tests/` code, fixtures, scenarios and configuration | Product E2E |
| Root `package.json`, lockfile, workspace configuration, `.npmrc`, and `patches/` | CLI, Web and product E2E |
| Root `.gitignore`, documentation, repository instructions and manual publication workflow | None |
| CI workflow, routing and unclassified paths | Every module and product E2E |

Documentation exclusions apply inside module and framework directories. Bundled
CLI source Markdown retains validation because it is a production resource. The
strict CLI manifest version-only exception still selects no application jobs.
The [module routing decision](.agents/notes/implemented/testing/2026-11-06-module-validation-routing.md)
records module ownership; the [product E2E decision](.agents/notes/implemented/testing/2026-11-08-self-contained-product-e2e.md)
records the independent integration boundary.

CLI has ordinary and installed phases on Linux, Windows and macOS ARM64, a Node
runtime matrix and shell-completion checks. Go owns its module job. Web owns
independent quality and frontend browser jobs. Product E2E owns an independent
Linux job that builds and runs the complete system with its own database and
auth. Final `checks` reject failures and cancellations and explicitly require
selected Web and product E2E jobs to succeed. A newer PR run cancels its older
run; main runs queue without cancelling an active run.

## Validation

`pnpm check` covers CLI type checking and tests; `pnpm acceptance` exercises the
installed package. CLI tests use private home and configuration environments
and guard real Daynight state (`~/.daynight` and the inherited `DN_CONFIG_DIR`)
against filesystem and SQLite writes or cleanup. The [CLI test isolation guide](docs/development.md#cli-test-isolation)
owns child-process propagation, symbolic-link checks and protection limits.
SQLite unit tests use native memory connections; file and process integration
suites remain part of ordinary `pnpm test`, as described in the
[CLI development guide](docs/development.md#cli-development). Server and Web checks
have separate commands and require statement coverage strictly greater than 90%.
Routine CI suites exclude stress workloads. Run the corresponding explicit local
command when full-scale evidence is required:

| Local workload | Command from the repository root |
|---|---|
| CLI rendering and Session-v2 archive limits | `pnpm test:stress` |
| Go query, archive and repeated-write workloads | `pnpm server:test:stress` |
| Web graph and geometry workloads | `pnpm web:test:stress` |

These stress entrypoints refuse a CI environment. The
[development guide](docs/development.md#local-stress-validation) owns their
prerequisites and evidence boundaries. For document changes, check local links
and anchors, newly created files and `git diff --check`.

Acceptance results belong to their tested revision, artifacts, environment and
execution scope. Controlled process fixtures do not prove live Copilot/GitHub
behavior, and a local browser run does not prove hosted-CI results. A failed
scenario or cleanup remains a failure. The
[validation guide](docs/development.md#validation) owns detailed prerequisites,
result scope and evidence limits.

## Working in the repository

Read [AGENTS.md](AGENTS.md) for scope, shared task worktrees, verification and
delivery. This repository manages concrete work in Daynight; load
[`using-daynight`](packages/daynight/src/commands/skill/skills/using-daynight/SKILL.md)
before executing a task. Use
[`dispatch-small-change`](.agents/skills/dispatch-small-change/SKILL.md) to turn
a bounded change request into a clear task, choose its required operating
system, and hand it off to a Worker. Use
[`optimize-unit-tests`](.agents/skills/optimize-unit-tests/SKILL.md) to reduce test
runtime, resource use and CI completion time while preserving defect detection.
See the [repository skills](.agents/skills/) for decision notes, scope choices
and prose, and [Agent Notes](.agents/notes/README.md) for decision history.

## Documentation conventions

| Location | Responsibility |
|---|---|
| `README.md` | Project purpose, capabilities, setup, development entry points and documentation conventions |
| Package READMEs and `docs/development.md` | Component usage, development, release procedures and validation methods |
| [`docs/ui-design.md`](docs/ui-design.md) | Shared UI design principles, examples and information boundaries |
| [`docs/daynight-server.md`](docs/daynight-server.md) | Stable server code organization rules |
| [`docs/daynight-server-database.md`](docs/daynight-server-database.md) | Server database usage rules: business logic, SQL, constraints, concurrency and query costs |
| [`docs/writing_tests.md`](docs/writing_tests.md) | Test ownership, real dependencies, normal integration flows and CI responsibilities |
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

Specifications, designs, and the server organization and database usage rules
use Chinese headings and prose while preserving technical literals. Other documents, skills, code,
comments and commit messages use English unless explicitly instructed otherwise.
Discuss work in Chinese.
