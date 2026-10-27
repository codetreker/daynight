# Daynight

Daynight is a project and task workspace for people and coding agents. It keeps
work, dependencies, design documents and delivery evidence together, with a
browser dashboard for understanding progress and a command-line client for
managing tasks. A foreground worker runs automatically claimed tasks through
Copilot or Codex in private Herdr workspaces. The CLI also provides automated
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
  and clean resources when the original claim leaves the worker's inventory.
- **Automate PR review.** Monitor configured GitHub repositories and retain
  per-PR worktrees, Copilot sessions and review state across restarts.

Task creation and general editing use the CLI. The Web app provides browsing,
status and execution-setting controls, task deletion and attachment management.
The [worker guide](packages/daynight/README.md#worker-configuration-and-startup)
explains configuration, native prerequisites and explicit
retry/release/transfer/resume controls. Complete platform acceptance remains
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
and the [CLI manual](packages/daynight/README.md) for detailed usage. The complete
[configuration example](packages/daynight/config.example.yml) covers service,
review and worker settings; the
[configuration guide](packages/daynight/README.md#configuration-setup) explains
customizing it and locating the copy included in the npm package.

### Shell completion

Run `daynight completion setup` to install Bash or zsh completion. The
[completion guide](packages/daynight/README.md#shell-completion) covers shell
selection, startup files and activation.

## Worker configuration and startup

Use interactive setup to inspect prerequisites, choose Copilot or Codex, and
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

Worker execution requires Git, Herdr 0.9.5 or newer with the supported API, and
the selected native CLI. Configure provider credentials and the official Herdr
integration explicitly. Local setup checks do not qualify real native execution,
provider login or task delivery.

`repo add` lists accessible Projects for multiselection. Use `--project
PROJECT_UUID` for an explicit noninteractive registration; `worker repo list`
and `worker repo remove` inspect or change the selection. With an empty
repository list, interactive `worker run` also guides Project selection before
starting new tasks. Startup saves configured Project mappings before reading
its complete current claim inventory, including after a local database reset.

New registrations use `worker.repositoryRoot`, defaulting to `~/daynights`, and
keep existing paths when the root changes. Review's clone-root setting is
independent. Projects must already exist, and their tasks need automatic
execution permission before the worker can acquire them.

The worker runs in the foreground with one execution slot by default. It uses
fixed state under `~/.daynight/worker/`. Run `daynight worker attach` in another
terminal to open its private Herdr session for human input. Detaching the client
leaves ongoing worker tasks running. Ctrl+C in `worker run` stops original
agents through bounded cleanup while retaining unfinished claims, worktrees and
native history. The [worker guide](packages/daynight/README.md#worker-configuration-and-startup)
covers defaults, repository overrides, recovery, attachment and manual management.

Native startup may require folder trust or another authorization. Use
`daynight worker attach` to make that decision in the task pane. The local task
record retains only Project/task/claim, pending/active/done, agent type and native
session ID. A missing session ID produces Warning and a fresh conversation in the
same worktree; a known ID uses native resume. Cleanup timers and recovery counts
are process-local, and restarted agents use current applicable settings.

Stop the runner before `worker retry/release/transfer/resume`; the commands use
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

Source development uses Node.js 24 LTS and pnpm 11.28.6. The published CLI runs on
Node.js 22 or newer. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm acceptance
```

These commands target the CLI. Web checks use `pnpm web:typecheck`,
`pnpm web:test` and `pnpm web:build`. The server uses Go 1.27.2 and PostgreSQL
18.6; from `packages/daynight-server/`, run `bash scripts/check.sh` with
`DAYNIGHT_TEST_DATABASE_URL` pointing to an isolated database. See the
[development guide](docs/development.md) for prerequisites, native diagnostics,
browser acceptance and complete validation commands.

## Package versions

Release-input changes require a strictly greater SemVer in
`packages/daynight/package.json`. This includes `packages/daynight/src/`, either
package manifest, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, either
application TypeScript configuration and the CLI build-cleanup script. Additions,
deletions and moves count; build metadata alone does not increase precedence.
Tests, fixtures, documentation, CI workflows and validation scripts alone do not
require a version increase.

Check committed revisions with
`pnpm version:check pull_request <base-sha> <head-sha>` or
`pnpm version:check push <before-sha> <after-sha>`. The
[version guide](docs/development.md#package-versions) explains comparison rules.

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
| `packages/daynight/test/fixtures/installed-cli.ts` | CLI, Go server, Web quality and Web browser acceptance |
| Other `packages/daynight/` paths | Linux, macOS and Windows CLI, runtime compatibility, plus shell completion |
| `packages/daynight-server/` | Go server |
| `packages/daynight-web/`, runtime files under `deployment/`, current Dagre and XYFlow patches | Web quality and Web browser acceptance |
| Root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc` | Every module |
| Root `.gitignore`, `docs/`, `.agents/`, `.claude/`, files named `README.md`, `AGENTS.md` or `CLAUDE.md`, manual `publish.yml` workflow | No application jobs |
| CI routing/workflow changes and other unclassified paths | Every module |

Runtime files under `packages/daynight/src/` always select CLI checks, including
bundled Markdown. Other documentation exclusions apply before module selection;
changes selecting several modules run their union. The Web selector enables
parallel quality and browser jobs, each with a 20-minute bound; both are required
by `checks`. Selected jobs retain their complete integration and coverage gates.
The final `checks` job accepts only
`success` or `skipped` from all preceding jobs. Documentation-only PRs run routing
tests and that gate; every `main` push runs full application validation. See the
[CI guide](docs/development.md#ci-selection) for routing and execution details.

## Validation

`pnpm check` covers CLI type checking and tests; `pnpm acceptance` exercises the
installed package. Server and Web checks have separate commands and require
statement coverage strictly greater than 90%. For document changes, check local
links and anchors, newly created files and `git diff --check`.

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

Specifications and designs use Chinese headings and prose while preserving
technical literals. Other documents, skills, code, comments and commit messages
use English unless explicitly instructed otherwise. Discuss work in Chinese.
