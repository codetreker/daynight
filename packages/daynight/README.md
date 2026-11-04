# Daynight CLI

The `@codetreker/daynight` package provides the `daynight` command and its `dn`
alias. Use it to manage server-backed projects, tasks, discussion threads,
attachments and Bot definitions, inspect remote Workers, install the
`using-daynight` skill for coding agents, run foreground task workers through
Herdr or browser-connected native Controllers, and run a local GitHub PR reviewer
through Copilot CLI. Both command names share configuration and behavior. Supported native platforms are Linux, Windows
and Apple Silicon (ARM64) macOS. Intel macOS is unsupported.

See the [project overview](../../README.md) for the browser workspace and service,
and the [development guide](../../docs/development.md) for source builds,
validation, package versions and npm publication. Ordinary test and installed
acceptance suites exclude stress workloads. From this package, `pnpm test:stress`
builds the CLI and runs the rendering and full Session-v2 `.stress.ts` suites;
`pnpm test:stress:budgets` runs the server validation gate with the four full
128 MiB/256 MiB installed-CLI byte probes. The latter requires an isolated
`DAYNIGHT_TEST_DATABASE_URL` and the [server validation prerequisites](../daynight-server/README.md#validate).
Both commands are explicit local-only validation and refuse CI. The
[local stress guide](../../docs/development.md#local-stress-validation) owns
selection and receipt interpretation. Each command's `--help` owns its exact usage. Review execution additionally requires Git, an authenticated
GitHub CLI and Copilot CLI on `PATH`.

- [Install and update](#install-and-update)
- [Configuration root](#configuration-root)
- [Client commands](#client-commands)
- [CLI usage manual](#cli-usage-manual)
- [Agent skill installation](#agent-skill-installation)
- [Shell completion](#shell-completion)
- [Configuration setup](#configuration-setup)
- [Project management](#project-management)
- [Task management](#task-management)
- [Task deletion](#task-deletion)
- [Task discussion threads](#task-discussion-threads)
- [Task attachments](#task-attachments)
- [Bot management](#bot-management)
- [Remote Worker queries](#remote-worker-queries)
- [Worker configuration and startup](#worker-configuration-and-startup)
- [Worker manual management](#worker-manual-management)
- [Review configuration and startup](#review-configuration-and-startup)
- [Review status listing](#review-status-listing)
- [Durable review state](#durable-review-state)
- [GitHub observations](#github-observations)
- [Repository clones and worktrees](#repository-clones-and-worktrees)
- [Copilot execution](#copilot-execution)
- [Coordination and shutdown](#coordination-and-shutdown)

## Install and update

Use the latest patch of Node.js 22 or newer (`>=22`, with no upper major-version
limit). SQLite requires Node.js 22.14.0 or newer. Install the CLI with npm:

```bash
npm install --global @codetreker/daynight
dn --version
```

The installation provides both `daynight` and `dn`; every command works with
either name, for example `dn task list` or `dn skill install`. Help and diagnostics
use the canonical `daynight` spelling.

Update that npm global installation with:

```bash
dn update
```

The command checks `@codetreker/daynight`'s `latest` version in the configured npm
registry and installs that exact version only when it is newer. It updates the
installation that is running, even if npm's current default global prefix has
changed. An equal or newer installed version succeeds without installation or
downgrade. User and global npm registry/authentication settings apply; the current
working directory's project `.npmrc` does not select the update source.

`daynight update --help` explains the command. Self-update requires an npm-owned
global package and launcher. Source checkouts, local dependencies, `npx`, pnpm and
`npm link` installations receive guidance to use their original package manager.
If an update is needed, run the command from outside its installation directory.
The installer streams its output, enforces the target's Node.js engine requirement
and reports permission, network and installation errors. It does not request
administrator privileges automatically. npm owns replacement and recovery; a
failed installation is not a promise that every original file remains unchanged.

The command verifies the installed manifest, launcher and a fresh invocation's
version, then refreshes existing `using-daynight` skills from that installed
package. It checks User destinations and the current Git worktree's Project
destinations, including calls from subdirectories and linked worktrees. Outside
Git it checks User destinations only. It does not search other projects or need
agent launchers on PATH. Missing skills remain uninstalled. The same refresh
runs when the CLI is already current or ahead, using its installed bundle.

Refresh replaces complete skill directories, including local edits and obsolete
files. Shared physical destinations are written once. Each result identifies
its agents, scope, path and package version. A skill failure exits nonzero and
reports the package outcome separately; a successfully installed npm package is
retained, and rerunning `update` retries the skill refresh. All phases must
succeed before the command reports success. It requires no review configuration and does
not open SQLite, modify sessions or restart a running reviewer or worker. The next CLI
invocation uses the installed version. Restart any running reviewer or worker to use it;
on Windows, a reviewer or worker holding a native addon open can prevent npm from replacing
that file and cause the update to fail. The
[self-update decision](../../.agents/notes/archived/feature/2026-10-20-cli-self-update.md)
records installation ownership and verification requirements.

## Configuration root

`DN_CONFIG_DIR` selects the absolute directory containing `config.yml` and all
Daynight user-local state. When unset, it remains `~/.daynight`. Empty or relative
values and paths containing control characters are rejected; use an expanded
absolute path such as `DN_CONFIG_DIR="$HOME/.daynight-test"`. Paths shown under
`~/.daynight` in this manual describe that default and follow the selected root.

The root includes credentials, worker identity, Worker/Review SQLite databases,
locks, logs, caches, Controller launch tickets, journals, content and resume leases.
Controller IPC identities are scoped to this root; long Unix socket paths use a
private owner-checked temporary directory. Herdr retains its native socket length
limit and reports an error for overly long roots; select a shorter root for
Herdr mode. Native home and Provider session directories remain unchanged.
Project `.daynight` bindings, Git worktrees, installed skills, npm installations
and remote service data are not isolated by this setting.

Top-level `agentCliAliases` optionally maps `daynight` and/or `dn` to another
executable for newly launched Worker/Controller Agents. It defaults to disabled.
The [development channel guide](../../docs/development.md#keep-the-skills-command-spelling)
explains the mapping, platform limits, fixed build lifetime and shell verification.

## Client commands

```text
daynight                            # Show root help
daynight --help                      # Also -h
daynight --version                   # Also -v
daynight --skill                    # Print the project/task usage manual
daynight update
daynight login [--no-browser]         # Authorize CLI access through the browser
daynight logout                      # Revoke and remove the current CLI credential
daynight worker                     # Show worker help
daynight worker list [--json]        # Query this account's remote Workers
daynight worker show <worker-id> [--json]
daynight worker setup               # Check prerequisites and choose an agent and Projects
daynight worker run                 # Run until interrupted
daynight worker attach              # Connect to an existing Herdr task runtime
daynight worker repo list [--json]
daynight worker repo add [--project <project-id>]
daynight worker repo remove [--project <project-id>]
daynight worker retry <task-id> --claim-id <claim-id> [--project <project-id>]
daynight worker release <task-id> --claim-id <claim-id> --if-version <version> [--project <project-id>]
daynight worker resume <task-id> --claim-id <previous-claim-id> --if-version <version> [--project <project-id>]
daynight review                     # Show review help
daynight review run
daynight review list                 # Also review ls
daynight review add-repo <remote> [--path <path>]
daynight completion                 # Show completion help
daynight completion bash
daynight completion zsh
daynight completion setup [--shell bash|zsh] [--rc-file <path>]
daynight skill                      # Show skill help
daynight skill install              # Select Agents, then User or Project scope
daynight project
daynight project create <name> [--repo <repo>]
daynight project list [--json]
daynight project show <project-id> [--json]
daynight team list [--json]
daynight team show [--team <uuid|personal>] [--json]
daynight team projects [--team <uuid|personal>] [--json]
daynight team default show [--json]
daynight bot list [--json]
daynight bot show <bot-id> [--json]
daynight bot create --name <name> [--worker <worker-id>] [--cwd <path>] [--agent <codex|claude|copilot>] [--request-id <uuid>] [--json]
daynight bot delete <bot-id> --if-version <version> [--request-id <uuid>] [--json]
daynight task
daynight task create --title <title> [options]
daynight task list [--all | --status <status>] [--ready] [--assigned-to <assignee>] [--json] [--project <project-id>]
daynight task ready [--limit <N>] [--json] [--project <project-id>]
daynight task show <task-id> [--json] [--project <project-id>]
daynight task step
daynight task step list <task-id> [--json] [--project <project-id>]
daynight task step show <task-id> <step-id> [--json] [--project <project-id>]
daynight task step add <task-id> --title <text> [--id <step-id>] [--description <markdown>] [--status <todo|in_progress|done|skipped>] [--before <step-id> | --after <step-id>] [--if-version <version>] [--json] [--project <project-id>]
daynight task step update <task-id> <step-id> [--title <text>] [--description <markdown>] [--if-version <version>] [--json] [--project <project-id>]
daynight task step set-status <task-id> <step-id> <todo|in_progress|done|skipped> [--if-version <version>] [--json] [--project <project-id>]
daynight task step move <task-id> <step-id> (--before <step-id> | --after <step-id> | --first | --last) [--if-version <version>] [--json] [--project <project-id>]
daynight task step delete <task-id> <step-id> [--if-version <version>] [--json] [--project <project-id>]
daynight task update <task-id> [options]
daynight task set-status <task-id> <status> [--claim-id <claim-id>] [--if-version <version>] [--project <project-id>]
daynight task delete <task-id> [--remove-depends] [--if-version <version>] [--project <project-id>]
daynight task graph <task-id> [--depends-only] [--json] [--project <project-id>]
daynight task thread read <task-id> [--before-id <message-id> | --after-id <message-id>] [--count=N] [--details] [--project <project-id>]
daynight task thread post <task-id> --body <text> [--reply-to <message-id>] [--claim-id <claim-id>] [--project <project-id>]
daynight task attachment
daynight task attachment put <task-id> <file> [--path <relative-path>] [--project <project-id>]
daynight task attachment list <task-id> [--tree | --json] [--project <project-id>]
daynight task attachment read <task-id> <relative-path> [--project <project-id>]
daynight task attachment remove <task-id> <relative-path> [--project <project-id>]
```

Groups and operations show help when `--help` or `-h` is their sole argument.
Help, version, usage-manual output and completion generation do not resolve the
user home, load review configuration, open SQLite or require review tools. `review add-repo` accepts one
`--path <path>` before or after its remote; `--path=value` and `--` are invalid.
Unknown commands and invalid arguments exit with status 2; operation failures
exit with status 1 and retain their cause. The old `--daemon-review` and root
`add-repo` forms are invalid. The
[client design](../../docs/design/daynight.md) owns command composition and lazy loading;
the [composition decision](../../.agents/notes/archived/architecture/2026-10-20-client-command-composition.md)
records module ownership and the preserved data layout.

## CLI usage manual

```bash
daynight --skill
dn --skill
```

`--skill` prints one standalone English project/task usage manual from the
current package. It covers project selection, task queries and writes,
dependencies, properties, attachments and ordered Step list/show reads, Add, Update,
Set-status, Move and Delete. Other capabilities are discovered
through `daynight --help`, with exact options in each subcommand's help. The
output preserves the manual's original bytes, including YAML
frontmatter and the final newline. The document has no package-relative
references to read separately.

The option must be the sole argument. Extra arguments or another option exit
with status 2 and empty stdout before the manual is read. A missing file, read
failure or invalid UTF-8 exits with status 1 and retains its cause. Reading and
validation complete before output; an output failure can leave partial stdout.
The command requires no login, Git repository, configuration, launcher or
interactive terminal, and creates no files.

The `using-daynight` skill owns task orchestration workflows and is installed
through the separate command below. The CLI manual explains command use.

## Agent skill installation

The public `using-daynight` skill provides task creation, handoff review and
execution of one specified task. Ordinary execution reads `run-task.md`.
Worker-started agents use `autopilot-managed-task` only when their startup
prompt explicitly names the `worker-managed` environment, the `using-daynight`
skill and that mode, together with their assignment. `SKILL.md` routes to the
selected instructions; ordinary execution does not load managed task rules.
Shared task inputs, delivery and acceptance rules retain one owner in the bundle.
The [foreground worker](#worker-configuration-and-startup) constructs that
explicit assignment and loads the installed managed entry before launch.
Managed execution follows one assignment through implementation, validation,
focused PR delivery, CI and review repair, and merge. A valid worker-managed
assignment already has sufficient authorization for that delivery and PR merge;
merge as soon as the checks and review conditions are satisfied without asking
for additional confirmation. Explicit user restrictions, pauses and revocation
remain binding. Pending CI or
review stays in execution; demonstrated external blockers return to the worker
with a checkpoint. Merge requires current-head approval and required checks,
and platform confirmation; mainline CI after merge is awaited only on explicit
request. The mode preserves the assigned scope, the original claim and the
controller's ownership of worktree, branch and workspace cleanup.

Install the skill through an interactive terminal:

```bash
daynight skill install
```

The command detects available codex, copilot and claude launchers without
starting them or checking login. Select one or more detected Agents with Space,
then Enter; the initial selection is empty. Next select User or Project,
with User initially selected. Installation starts after the scope is submitted.
Repeating the command refreshes the full bundle from the running package.
`daynight update` automatically refreshes existing User and current-worktree
Project copies with the same replacement semantics; it also repairs existing
skill directories whose entrypoint was removed and replaces dangling leaf links.
A regular file at the expected skill-directory path is an error. See
[CLI updates](#install-and-update) for package ownership and failure handling.

| Agent | User destination | Project destination |
|---|---|---|
| Codex | `~/.agents/skills/using-daynight/` | `<worktree>/.agents/skills/using-daynight/` |
| Copilot CLI | `~/.agents/skills/using-daynight/` | `<worktree>/.agents/skills/using-daynight/` |
| Claude Code | `~/.claude/skills/using-daynight/` | `<worktree>/.claude/skills/using-daynight/` |

User scope works outside Git. Project scope uses the current Git worktree root,
including calls from subdirectories or linked worktrees, without requiring an
origin, server configuration or project association. Installing the skill and
associating a project remain separate operations. Terminal stdin and stderr are
required; prompts use stderr and installation results use stdout. Help and
installation do not depend on review configuration or credentials.

Each installation replaces the complete using-daynight leaf, including local
edits and obsolete files. It then removes the legacy daynight leaf in the same
selected physical skill root. The old name is retained until publication
succeeds. Other skills, opposite-scope copies and parent-directory links are
preserved; leaf links are replaced or removed without following their targets.
Several Agent paths resolving to one physical root share one write. Destructive
nesting involving an installation or legacy-cleanup path is rejected before
writing. Discovery paths may be shared with unselected Agents, and host precedence
continues to govern copies at other scopes.

The command reports per-Agent destinations and results. Failure stops later
targets, retains earlier completed installations and exits nonzero. If legacy
cleanup fails after publication, the new bundle stays installed and the command
reports the incomplete migration. Replacement failure after removing an existing
using-daynight leaf may leave that destination absent; diagnostics preserve the
actual phase and reason. Rerunning installs the complete packaged bundle.
Cancellation before publication cleans its stage and newly created empty parents.

Codex normally discovers changed skills automatically; restart its session if
needed. For Copilot CLI run `/skills reload` and inspect
`/skills info using-daynight`. Claude Code watches existing roots; use
`/reload-skills` when a top-level skills directory was created during the session.
The [skill design](../../docs/design/daynight-agent-skill.md) owns mechanisms, routing
and the simulated-launcher native installation matrix.

## Shell completion

Bash 4.2 or newer and zsh have native completion scripts. Install startup
configuration with:

```bash
daynight completion setup
```

Setup detects the calling shell from its direct parent process. If it cannot
identify Bash or zsh reliably, select one explicitly:

```bash
daynight completion setup --shell bash
daynight completion setup --shell zsh
```

The login-shell preference in `SHELL` does not establish which shell is running.
For a custom startup file, use `--rc-file`; only that file is managed:

```bash
daynight completion setup --shell bash --rc-file /path/to/bashrc
```

Bash setup manages `.bashrc` and the first readable existing login file in the
order `.bash_profile`, `.bash_login`, `.profile`. It creates `.bash_profile` only
when none of those files exists; if existing profiles are all unreadable, it
reports an error. The login block runs only in interactive Bash and can safely
appear in a `.profile` shared with other POSIX shells. It does not
make the login shell load the rest of `.bashrc`.

zsh setup uses `$ZDOTDIR/.zshrc`, or `$HOME/.zshrc` when `ZDOTDIR` is unset.
An exported empty `ZDOTDIR` selects `/.zshrc`; setup resolves a relative value
from its current working directory. A later zsh started in another directory
resolves that relative value from its own startup directory. A value set only
inside zsh is not visible to the installer; use `--rc-file` in that case.
The managed block reuses an initialized completion system or runs `compinit`
with its normal security checks before loading daynight.

Setup recognizes its managed block and the documented standalone manual loading
statement. Repeating it leaves an installed file unchanged. A managed block
checks that both `daynight` and `dn` use the expected callable completion
function before skipping loading. A missing or replaced registration for either
command reloads the shared script and restores both commands. Complete
registrations are reused, including when startup files load each other. Preserved
manual loading statements keep their unconditional behavior: if one runs after a managed block, it generates and loads the script
again. Existing content, line endings, permissions and startup-file symbolic
links are retained. Added blocks use LF line endings because a carriage return
is shell token data. Malformed managed blocks, invalid targets and file access failures produce
explicit errors. Setup does not migrate blocks from earlier templates. If an
earlier block is reported as unrecognized, remove its marked section and rerun
setup, or use the source command below to activate the current script directly.

Setup reports the startup files it handled. It installs persistent configuration;
an ordinary CLI child process cannot inspect or change its parent shell's loaded
completion functions. Use the existing loading command to enable completion in
the current session:

```bash
source <(daynight completion bash)
```

For zsh, initialize its completion system first if the session has not already
done so:

```zsh
autoload -Uz compinit
compinit
source <(daynight completion zsh)
```

The `bash` and `zsh` generation operations write only scripts to stdout and do
not change startup files. Loading the zsh script without initialized `compinit`
fails with a diagnostic. The outputs are designed for `source`; using the same
output directly as an `fpath` autoload file is outside the loading contract.
Setup checks file contents without executing them. Custom early returns or later
commands that remove registrations can prevent a startup file from enabling
completion; verify such configuration by starting the shell.

The generated scripts register completion for both `daynight` and `dn`.
Completion suggests commands, nested operations, aliases, options, shell names
and local directories for `review add-repo --path`.
zsh also displays descriptions.
The scripts run in the shell on each Tab without starting Node or reading review
configuration, SQLite or the network. Directory suggestions preserve quoted and
special-character paths; an uncreated target directory remains valid input.

New shells generate definitions from the currently installed package. After an
update, run the applicable `source` command again to refresh an existing shell.
A saved generated script must be regenerated after updating. The
[completion design](../../docs/design/daynight-completion.md) explains the shared grammar
and shell integration. The
[completion decision](../../.agents/notes/archived/feature/2026-10-20-shell-completion.md)
records compatibility and execution trade-offs; the
[setup decision](../../.agents/notes/archived/feature/2026-10-21-completion-setup.md)
records startup-file ownership and installation limits.

## Configuration setup

The shared configuration file is `~/.daynight/config.yml`. The complete
[`config.example.yml`](config.example.yml) covers service access, review and worker
settings with their defaults and optional overrides. It is included at the root
of the npm package. For an npm global installation, locate it with:

```bash
npm root --global
```

Open `@codetreker/daynight/config.example.yml` beneath that directory. Select the
sections needed for your commands and replace the example repositories and local
paths. For a new configuration, save the selected settings to
`~/.daynight/config.yml`; for an existing file, merge them while preserving its
credential, generated `workerId` and unrelated settings. The example itself is
not loaded automatically. Repository paths resolve from the configuration
directory, with the rules in the [worker](#worker-configuration-and-startup) and
[review](#review-configuration-and-startup) guides.

Unknown fields at the root, in `review` or `worker`, and in their repository
entries are ignored at runtime and preserved by CLI configuration edits. Known
fields retain their type and value checks. Invalid YAML, duplicate keys and
invalid mapping structures remain errors. Every CLI configuration write, including
first-time `workerId` creation, preserves decoded values outside the fields it owns. If shared YAML aliases would change an unrelated value, the write fails
and retains the original file; separate those aliases before retrying. Unaffected
aliases remain valid.

Project and task commands use `https://daynight.cc` when the configuration file or
`serverUrl` is absent. A production connection needs no server configuration.
Run `daynight login` to display an authorization code and open the verification
page. Check that the page's code matches the terminal, confirm the account and
approve access. The CLI saves the resulting credential without displaying its
secret. `daynight login --no-browser` displays the URL and code for authorization
in another browser. The device authorization expires after ten minutes; rejection, expiry and
cancellation leave an existing saved credential unchanged.

The CLI credential is named `Daynight CLI (<hostname>)`, using the machine that
runs `daynight login`, including when another device approves access. Hostnames
longer than 85 Unicode characters are shortened to their first 85 characters to
keep the credential name within 100 characters. The credential never expires by default.
The Web account's token manager can set a future expiration, restore “Never expires”, or
revoke it. Changing expiration keeps the same credential, so the saved CLI login
continues without replacing its secret. Expired or revoked credentials cannot be
revived. A credential
represents the account's current project permissions. `daynight logout` revokes the current credential and removes
its local value after a confirmed response; an already invalid credential is
removed locally. Network or unconfirmed failures remain visible. Configuration
changes made during login or logout cannot overwrite another service origin or
another saved credential. A lost successful login response requires a fresh
login; the account token list can revoke a credential whose response was lost.

Without a local credential, a service command fails before dispatch and directs
the user to `daynight login`. A server `401` gives the same guidance. Business
commands do not start login, follow redirects with credentials, or automatically
repeat a write. Reconcile an unconfirmed business mutation before another one.

The first `review run`, `review list` or `review ls` asks for a repository when
the file, `review` section or `review.repositories` field is absent. To configure
one in advance, run:

```bash
daynight review add-repo https://github.com/OWNER/REPO.git
daynight review add-repo git@github.com:OWNER/OTHER.git --path ./review-other
```

Interactive guidance requires terminal stdin and stderr. Prompts and save
messages use stderr so stdout retains its normal text or JSON format.
Noninteractive missing review configuration fails with a `review add-repo`
command. Shared YAML/schema errors, invalid selected values, explicit empty
review lists and read failures retain their errors. Unrelated capability values
remain outside the current command's validation. Help, version, usage-manual
output, completion, update and invalid arguments do not prompt.

Test services and noninteractive automation use the existing
`~/.daynight/config.yml` fields. For a test service, provision its origin before
running `daynight login`:

```yaml
serverUrl: http://127.0.0.1:8787
```

For unattended access, a secret-provisioning process can write `serverToken`
together with its intended `serverUrl`; omit `serverUrl` only when the credential
belongs to `https://daynight.cc`. Keep that file private, with mode `0600` on
POSIX, and never put credentials in command arguments, logs or repository files.
Provisioners must preserve unrelated settings and pair the origin with its own
credential. Replacing `serverUrl` manually does not clear an old token; remove
or replace it before sending another request. External editors and provisioners
do not participate in the CLI's configuration lock.

Tokens are opaque visible ASCII and require HTTPS except for HTTP origins whose
host is literal `localhost`, a numeric IPv4 address in `127.0.0.0/8`, or `::1`.
Invalid explicit origins and credentials remain errors. Normal CLI use requires
no manual PAT creation. There is no top-level `daynight setup` command; shell
startup installation remains available through `daynight completion setup`.

Review guidance collects values before one atomic save under the configuration
write lock, preserving comments, unrelated settings and completed concurrent
changes to unrelated fields. A selected review-field conflict requires a fresh
decision. Login and logout check the observed origin and credential together
under the same lock. Credential-bearing files use POSIX mode `0600`, including
review writes; files without a token retain existing permissions. Symlink
rejection and atomic replacement apply to CLI configuration writers.
Ctrl+C, termination signals or EOF cancel prompts without partial saves or
business execution. Human input consumes no business timeout. Review guidance
saves configuration without network, login or authentication checks; cloning and
review state initialization belong to the business operation.

The [configuration decision](../../.agents/notes/archived/feature/2026-10-21-guided-configuration-setup.md)
records the review-guidance and persistence choices; the
[device-login decision](../../.agents/notes/implemented/architecture/2026-10-25-cli-device-login.md)
owns the default service, explicit login/logout and credential lifecycle. The
[top-level setup removal decision](../../.agents/notes/implemented/simplification/2026-10-25-remove-top-level-setup.md)
records the command removal and configuration-file provisioning boundary.

## Project management

After `daynight login`, create, list or inspect projects on `https://daynight.cc`.
To use a test server, set `serverUrl` in `~/.daynight/config.yml`:

```yaml
serverUrl: http://127.0.0.1:8787
```

The origin includes its protocol, host and optional port; the client adds
`/api/v1`. When changing the origin externally, remove the old `serverToken`
before logging in to the new service; manual edits do not run CLI credential
cleanup. Then use the same commands:

```bash
daynight project create "Example"
daynight project create "Example" --repo https://github.com/OWNER/REPO.git
daynight project list
daynight project list --json
daynight project show <project-id> --json
```

Creation requires one positional name; quote names containing spaces. Omit
`--repo` to use the current Git worktree's effective `origin`, including Git
`insteadOf` expansion. Supply `--repo` to use that address without inspecting Git;
this form, listing and details work outside Git repositories. For a name beginning
with `-`, use `daynight project create -- -name` or put an explicit repository
option before the terminator: `daynight project create --repo <repo> -- -name`.
The name is sent unchanged.

Creation first scans every project page and compares canonical repository
identities. With no match it reads the current user, binds the request and response
to that identity, and registers the original name and repository address in the
Personal Team. An unknown write is not automatically replayed.
With one match it reports `Project already exists.` and the existing project,
leaving that project's name and address unchanged. Multiple matches fail with
their IDs; lookup failures and exhausted command budgets stop before creation.
This client preflight does not provide atomic uniqueness against concurrent
creators, and the service continues to allow duplicate repository registrations.
Project commands do not write repository bindings or ignore rules. Lists traverse
all pages. Human output uses complete labeled project blocks with visible
terminal-control escapes. JSON preserves resource fields and nanosecond timestamp
strings; a later-page failure produces an error with empty stdout. The
[project/task requirements](../../docs/spec/daynight-project-task.md) own the complete
behavior and remaining task-command scope.

## Team context

`team list` reads all Teams joined by the current account. `team show` and
`team projects` use `--team <uuid|personal>` when supplied; otherwise they use
the configured `teamDefaults` entry for the normalized service origin and current
account, or the account's Personal Team when that entry is absent. `team default
show` verifies and displays the resolved target. An invalid or inaccessible
configured target fails explicitly; `team list` and an explicit `--team` remain
available. These commands do not change configuration or remote resources.
Lists finish and validate every page before producing output. Use `--json` for
complete resources. Project discovery and `project list` still use all accessible
projects, independently of this default.

An externally provisioned default uses canonical UUIDs and the normalized
service origin as keys:

```yaml
teamDefaults:
  https://daynight.cc:
    80be22c3-96d8-4ed1-bcd3-b820f2508c62: b95baeff-1522-4d99-a9b4-dfcb58392eca
```

`team default show --json` returns `configured` (the saved ID or `null`) and
the verified `team` resource.

## Task management

Task commands use the same `serverUrl` configuration as project commands:

```bash
daynight task create --title "Implement sign-in" --description '## Sign-in

Implement OAuth sign-in for the web workspace. Deliver the callback flow and
visible failure recovery; preserve the existing session and provider rules.
Complete when a valid login opens the workspace and a rejected login can retry.'
daynight task create --title "Build the sign-in page" --depends-on <design-task-id> --external-depends-on <authentication-task-id>
daynight task ready
daynight task ready --limit 5 --json
daynight task ready --allow-agents true --compatible-platform linux --json
daynight task list --allow-agents false --ready
daynight task list --ready
daynight task list --all --json
daynight task list --status in_progress --json
daynight task list --ready --assigned-to me --json
daynight task list --assigned-to unassigned --json
daynight task show <task-id> --json
daynight task properties <task-id> --json
daynight task properties --schema --json
daynight task set-property <task-id> pullRequests '[{"url":"https://github.com/owner/repo/pull/123","title":"Fix synchronization"}]' --if-version <observed-version>
daynight task remove-property <task-id> pullRequests --if-version <observed-version>
daynight task update <task-id> --description=
daynight task update <task-id> --allow-agents true --if-version <version>
daynight task create --title "Check Windows build" --required-platform windows
daynight task update <task-id> --required-platform macos --if-version <version>
daynight task update <task-id> --clear-required-platform --if-version <version>
daynight task create --title "Review installation" --assigned-to <user-uuid>
daynight task update <task-id> --assigned-to <user-uuid> --if-version <version>
daynight task update <task-id> --clear-assigned-to --if-version <version>
daynight task set-status <task-id> <status> [--claim-id <claim-id>] [--if-version <version>] [--project <project-id>]
daynight task update <task-id> --depends-on <task-a> --depends-on <task-b>
daynight task update <task-id> --clear-dependencies
daynight task graph <task-id> --json
daynight task graph <task-id> --depends-only
daynight task graph <task-id> --depends-only --json
```

`task graph` requires a task ID. It returns every member of that task's ordinary
undirected dependency component, including completed tasks and sibling branches,
plus one layer of external prerequisites declared by those members. External
tasks that depend on the chain do not enter the result. Added external tasks do
not expand their own prerequisites or chain. The service applies its 1,000-task
and 5,000-dependency-reference limits to this returned set; unrelated chains do
not count toward this query's limits.

Every returned task retains its full `dependsOn`, `externalDependsOn`, `blockedBy`
and `ready`. An external context task can therefore reference an ID with no task
row in this response. Those references remain available for dependency audits.
The ordinary graph output includes the project, statistics for all returned
nodes and the compact node facts. `--depends-only` uses the same tasks but prints
only `ID`, `Depends on` and `External dependencies`, with full UUIDs and `none`
for empty sets. With `--json`, this mode returns a bare array of objects containing
only `id`, `dependsOn` and `externalDependsOn`.

Project-scoped operations accept `--project <project-id>`, which selects a project
for one invocation without reading Git or local bindings. `task properties --schema`
uses only the authenticated service and rejects project selection. Otherwise, the CLI reads the
current worktree's effective `origin`, normalizes equivalent HTTPS/SSH/SCP
addresses, and matches the configured server's projects. A missing match fails
with `Project does not exist`; multiple matches require explicit selection.
A unique discovery is saved in the worktree's `.daynight/project.yml` with the
server origin and repository identity, after ensuring `/.daynight/` is effective
in the root `.gitignore`. A cached binding is verified against the server on each
use and remains stable if another project later shares that repository.

Creation starts in `todo` with `allowAgents=false` and unrestricted
`requiredPlatform=null` and `assignedTo=null` unless explicitly set. Unset properties remain absent;
creation does not inject a PR array or worker null. `task set-status <id> <status>`
sets `todo`, `in_progress` or `done`, including reopening and direct completion.
Every project member may use ordinary status setting. Active worker completion
requires the current owner and an explicit `--claim-id <claim-id>` with target
`done`; the CLI uses the existing typed completion operation. The option is
validated before configuration or network access, is rejected for other targets,
and is never inferred from a task or environment. Without it, ordinary status
setting is unchanged. Release and continuation of released work use their protected
operations. Status does not grant execution or delivery authority. Generic updates cannot write status; old lifecycle commands and routes
are removed without aliases. `--if-version` uses the exact reviewed int64 value;
without it, the CLI reads once immediately before submitting. No write retries
occur. A controller-bounded worker assignment executes its supplied claim in the
provided worktree, finishes with the explicit claim ID after delivery, and leaves
system worktree cleanup and next-task selection to its controller. Version is
checked before same-state handling: current same-state keeps
version, update time and timing unchanged; actual changes increment once.

Entering in_progress or done requires all direct prerequisites, ordinary and
external, to be done. Reopening done requires no direct in-progress or done
dependents. Refusals return sorted blocking task IDs without cascading changes.
The project transaction serializes status and dependency writes and preserves
materials, assignedTo, properties/PRs, permission, both dependency sets and attachments.

Migration `014_task_status_assignment.sql` converts historical proposed rows
to todo, increments only those versions and updates their update time while
preserving every other field, including requiredPlatform and historical execution timestamps. Default,
data, CHECK and ledger change atomically. Other rows and applied migrations remain
unchanged; restart does not repeat the conversion. Runtime readers reject the old state.

Task resources expose required nullable `startedAt` and `completedAt`. Actual entry
into in_progress starts a new interval and clears the end; return to todo clears
both. In-progress to done preserves a nullable start and records a real end;
todo to done records only an end, leaving duration unknown. Metadata and same-state
writes preserve time. Task-graph and task-sync responses supply a database
`observedAt` sample; Web synchronization updates its separate clock without
rebuilding unchanged graph/index data.
Read-only timing fields remain in JSON; human CLI output keeps its field choices.
The [status requirements](../../docs/spec/daynight-task-status.md) and
[architecture](../../docs/design/daynight-task-status.md) own the complete rules.

Task and graph resources also require `externalDependsOn`, a sorted,
duplicate-free subset of all `dependsOn` IDs. CLI JSON preserves it and the
shared human dependency block shows `External dependencies (N): ...`. Current
API dependency fields are independently optional: a dependsOn-only PATCH
retains classification on surviving edges, while an externalDependsOn-only PATCH
replaces the exact external subset. CLI --depends-on and --external-depends-on
compile both complete sets whenever either option is supplied; ordinary-only
clears the external subset and external-only replaces all relationships. Omit
both CLI options to preserve them. Metadata and lifecycle actions retain
unmodified classification. Every edge still participates in blocking and cycles.

Every Project resource includes `settings` with an exact positive int64 `version`
and `executionWarningMinutes` from 1 through 2147483647, initially 60. Project
create/read/list, the project in graph responses, and a successful settings PATCH
return this same shape. The member-readable settings page lets administrators
save or cancel a draft; ordinary members see the saved value without editing.
The server checks current administrator authority after the project lock, then
the observed settings version. An equal-value save preserves version and
`updatedAt`; a real change increments version and updates `updatedAt`. Migration
preserves historical project timestamps. CLI JSON preserves settings and nested
versions without rounding; human output keeps its established fields.

An unconfirmed settings PATCH response requires a Project and membership reread
before another write. Failed reconciliation keeps Save blocked and offers read
retry; network, protocol, 5xx or navigation cancellation never prove rollback.
Confirmed refusals and unsaved/canceled drafts do not apply local settings.
Project-only changes update graph metadata while retaining the task index and
layout when tasks and summary are unchanged. Running known-start tasks subscribe
to one visible-page ticker; completed duration uses stored endpoints and unknown
starts show no inferred duration. Warnings use an unrounded strict comparison
and disappear on completion without changing task status. The server-sample
clock avoids client wall-clock skew but does not remove network sampling delay.


The Web detail header places a three-item status menu beside the actual task
title on both tabs. The current item remains selectable. Confirmation names the
task, current/target states and timing effects; Cancel and Escape send no write.
Status, **Automatic execution / 自动执行** and platform confirmation share one per-task mutation owner.
Pending, stale or unknown results block conflicting writes. Current-version same-state responses
confirm no stored change; actual changes refresh the graph. Unknown outcomes use
GET-only reconciliation, preserving errors and never attributing the observed
state to the uncertain request. Closing details does not roll back a submission.

Task details use one platform select in the left status group to display the
confirmed requirement and offer Any platform, Windows, Linux and macOS. Choosing
a different value opens confirmation showing the current and target platforms;
only confirmation submits the reviewed exact task version. Choosing the saved
value, Cancel, close, backdrop dismissal and Escape send no request. Cancellation
returns focus to the select. The confirmed value remains displayed until success,
and Any platform clears requiredPlatform. Overview has no separate platform
editor or Save action. The control stays available on either detail tab, is
locked during in_progress, and retains shared pending/unknown reconciliation
across navigation. Rows and graph nodes remain read-only and show each task's
own requirement; root values do not define chain-wide platform requirements.
The [confirmed platform control decision](../../.agents/notes/implemented/simplification/2026-10-24-task-platform-confirmation-control.md)
records its allocation and focus behavior.

The permission switch has confirmation in both directions, remains false by
default and is locked against actual changes while in_progress. It governs
automatic discovery; explicit task execution may use either value. Rows and graph
nodes display each task's own permission. Permission does not control worker
ownership; ordinary status setting cannot release active execution or resume
released resources. Claim-bound done validates ownership. None of these
operations stops a remote process or replaces PR review and delivery authority.
The [status decision](../../.agents/notes/implemented/architecture/2026-10-24-task-status-assignment.md)
records migration and shared-session trade-offs.

`task ready` selects up to 10 actionable tasks by
default; `--limit <N>` accepts decimal integers from 1 through 100. It makes one
task-list request with `ready=true`, the chosen limit and optional
`--allow-agents true|false` and `--compatible-platform windows|linux|macos`
filters, without fetching later pages. Compatibility includes unrestricted tasks
and tasks requiring that platform. The service applies all filters before
pagination and binds them to the cursor. The service orders results by creation time and then task ID, both
ascending. A ready task is `todo` with all direct dependencies `done`. This
bounded selection supports choosing the next work without retrieving the whole
project; `task graph <task-id>` provides the selected chain and one layer of
external prerequisites. `task list`
reads every matching page, including with `--ready`, and excludes `done` by
default. `--all` includes every status; `--status <status>` selects one status,
including `done`. These two options conflict. `--ready` intersects the selected
statuses and can be combined with `--all`. List results place `in_progress`
first, then ready tasks, other `todo` tasks, and `done`; each group retains
service order across all pages. This order applies to human and JSON results.
`task ready` accepts neither `--status` nor `--cursor`. `task list` supports the
same permission and compatibility filters across every matching page. Both are
automatic-selection conditions independent of readiness; explicitly designated
execution retains the manual exception. List also accepts
`--assigned-to <user-uuid|me|unassigned>`, combined with its other filters and
preserved across every page. `task ready` has no assignee option; use
`task list --ready --assigned-to me` for that intersection. Automatic acquisition
requires the task to be assigned to the worker's authenticated account, in addition
to permission and other eligibility checks. Existing claim inventory and manual
control remain execution-based; the
[self-assigned acquisition decision](../../.agents/notes/implemented/architecture/2026-11-03-worker-self-assigned-claims.md)
owns the runtime rule.

For `me`, each successful task-page response must carry one canonical
Daynight-User-ID, even when its items array is empty. A complete list traversal
binds its first successful page to that identity and rejects a different later
principal or a task assigned to someone else. The binding is per traversal, not
a global client cache. UUID and unassigned filters also verify every result;
mismatches are protocol errors, not locally discarded rows. No extra `/me`
request is issued. Non-me requests without a configured expectedUserId retain
their existing optional-header behavior. Error responses retain the existing
service-error and configured-principal admission behavior; me adds no new
error-response header requirement.

Updates preserve omitted fields; an empty description clears it. Repeated
`--depends-on` and `--external-depends-on` declare the complete ordinary and
external sets. Either option replaces all relationships and classifications;
ordinary-only makes every supplied edge ordinary, while external-only leaves
only those external edges. IDs are canonicalized and sorted; malformed and
case-equivalent duplicate/cross-declared UUIDs fail before configuration or
network access. `--clear-dependencies` sends two empty sets and conflicts with
either dependency option. An update needs at least one mutable
field. Create/update accept `--assigned-to <user-uuid>`; update also accepts
`--clear-assigned-to` to send null. CLI creation without `--assigned-to` reads
the signed-in account through `/me` and submits its UUID. An explicit UUID skips
that identity lookup. A failed or cancelled lookup prevents creation; the CLI
does not substitute an unassigned task. Update omission preserves the existing
assignee. Direct API callers retain optional assignment and may create unassigned
tasks by omitting `assignedTo` or sending null. The set/clear options conflict, and invalid UUIDs or combinations fail before
configuration, Git or HTTP access. Writes accept UUIDs, not the list tokens
me/unassigned. A real assignment change atomically sets allowAgents=false; an
equal assignment causes no permission reset; a pure equal update preserves
version and timestamps. Other supplied fields keep their ordinary mutation
rules. Actual changes are refused while in_progress. Assignment grants neither project access nor
control of another worker, Session or archive.

`--allow-agents true|false` explicitly changes automatic-execution permission;
omission preserves it when assignment does not change. Creation rejects the option. Existing tasks
receive true through migration without changing versions or business timestamps.
A matching same-value permission PATCH retains version and time, while a stale
version still conflicts and an actual in-progress toggle fails atomically.
Create and update accept `--required-platform windows|linux|macos`; update
accepts `--clear-required-platform` to send null, mutually exclusive with setting
a platform. Omission preserves an existing requirement. New and migrated tasks
are unrestricted unless explicitly set. Exact-version equal platform updates
preserve version and time; stale updates conflict and actual in-progress changes
are refused atomically. Explicit manual status setting remains available for every
requirement. The query platform selects candidates; it does not configure or
prove the environment of a future worker.
By default the CLI reads the task version before PATCH; `--if-version <n>`
uses that exact positive int64 version without a task pre-read. Existing project
resolution/admission still applies. Null clearing is serialized literally; only
undefined fields are omitted. A normal write consumes the full Task response
without a post-write GET or a name lookup. A combined update may advance its
version for other fields, so v+1 alone does not establish an assignee change.
Conflicts and failed writes are reported without automatic retries.

Text options accept both separated values and `--option=value`. Inline assignment
splits at the first equals sign and supports leading dashes, such as
`--title=-example`; `--description=` is the explicit empty form. Separated values
starting with a dash are rejected. Directory options, switches and help reject
inline assignment. Attachment `put` declares its `--path` as text, accepting
`--path=value`; attachment `put/read/remove` also accept `--` before positional
paths starting with a dash. Property set/remove also accept this terminator for
literal property/value positionals; other operations retain their declared syntax.

The internal typed ApiClient accepts optional `assignedTo` and `workerId` on
TaskFilters and TaskPageQuery. Assignment selectors accept `me`, `unassigned` or
a user UUID; the worker uses `me` for new candidates across every page. With
workerId, the client requests only the authenticated user/worker active claims
and validates active state and matching worker ID in responses. `listTasks` returns
only after every page succeeds; `listTaskPage` remains partial. A workerId-only
traversal across all relevant projects provides ownership inventory; extra filters
or incomplete pages cannot authorize cleanup. These filters are not public task
CLI options.

Human task lists use labeled blocks containing ID, project, title, complete
properties, status, readiness, automatic-execution permission, required platform,
assignee, dependencies and blocking. Property rows are ordered by name and rendered as
terminal-safe JSON; missing keys are not replaced with default values.
Description, version and timestamps
remain available in show, ready, create and update output. Graph nodes include
state, permission, required platform, assignee, dependencies, blocking and
title-preview truncation flags.
Task and graph decoders require a boolean `allowAgents`; missing, null or
nonboolean values are protocol errors. They also require `requiredPlatform`
as null or one of the three platform enums; missing keys or other values fail
without a runtime default. Human output uses `Required platform: any` for null
and the enum otherwise. `assignedTo` is also required as null or a canonical
local user UUID on every Task and graph node; missing, malformed or noncanonical
values fail instead of defaulting. Human output adds `Assigned to: USER_UUID` or
`Assigned to: unassigned`, with no profile request or rule narration. Task metadata queries support
`--json`: task `list` returns every matching task in one array, omitting only
`description` while retaining every other API field, including explicit nullable
assignedTo, raw PR strings, version and timestamps. This applies to the default list and every filter,
including `--all`. Project lists retain all API fields. Task `ready` returns its
selected full tasks as an array, details return one full resource, and graphs
return the selected task-chain API object unless `--depends-only` projects the
three dependency fields. An empty human ready result is `No ready tasks.`
and empty JSON is `[]`. Versions remain JSON numbers with full int64 precision.
Local preparation fails before any task mutation; a lost write response is
reported as unconfirmed. Installed CLI integration uses the real Go/PostgreSQL
service; deadline behavior uses short test-only budgets and byte probes retain
the full production limits. [PR #55](https://github.com/codetreker/daynight/pull/55)
records the original integration and real-default-budget validation, with its
historical source identity.

## Task properties

`task properties <task-id>` reads the task's complete current values;
`task properties --schema` reads the service's definitions without project or
Git discovery. The two modes are exclusive, and schema mode does not accept
`--project`. Both read modes support `--json`. Task show continues to include
properties.

`task set-property <task-id> <property> <value>` replaces one complete value.
`task remove-property <task-id> <property>` deletes its record, so reads omit
that key. Setting `pullRequests` to `[]` retains an explicit empty array; null is
an actual value only where the service definition permits it, never a delete
marker.

Names are complete case-sensitive literal names; dots do not select nested
object paths. Exact dot-only names `.` and `..` fail before dispatch because URL
normalization cannot preserve their resource path; this is a transport error,
not property-schema validation. Other representable names reach the service. The CLI forwards value unchanged as valueText and does not parse
JSON, fetch the schema before writes, or validate a property-specific structure.
The server owns JSON/string interpretation and read-only protection. A string
property accepts raw text or JSON string syntax; structured values use JSON.
Generic commands do not introduce custom attributes or make worker publicly
writable. To set PR references, supply the whole ordered array of url/title
objects, preserving every entry still needed.

The writable boolean property `paused` controls periodic worker continuation
pings. The macOS durable Herdr path also checks it before every automatic input.
Set it to `true` to suppress those inputs, or set it to `false` or remove it to
restore the usual policy. Observation, original-run stopping and human attach
remain available. An absent key remains absent in reads. The
property can change during an active claim without changing task status,
execution ownership or timing:

```bash
daynight task set-property <task-id> paused true --if-version <observed-version>
daynight task set-property <task-id> paused false --if-version <observed-version>
daynight task remove-property <task-id> paused --if-version <observed-version>
```

The value positional argument can be empty. Use `--` before a positional
argument beginning with a dash, with options before the terminator. For example,
`task set-property <task-id> <property> -- -123` forwards the exact text to the
service; it does not assert that any current property accepts a number.
Shared Bash/zsh completion follows the same argument schema without a remote
catalog lookup or hardcoded property choices.

Both writes support `--if-version`. With it, submit once without a pre-read;
without it, GET the property resource once for the task version, then submit
once. An explicit project is sent directly to that property request; absent
project selection uses normal repository discovery. Conflicts and uncertain
results are never automatically replayed. A default pre-read cannot protect a
decision formed from older task material.

Read JSON returns the complete projectId/taskId/version/properties resource or
the complete definition catalog. Human output prints identifiers, exact version
and property JSON sorted by name; successful writes return the current property
resource, including unchanged versions for no-ops. Terminal control characters
remain safely escaped, and missing keys are not filled. Invalid or read-only
values and invalid stored properties remain service 400 invalid_input failures;
database/internal faults remain 500 internal_error.

The version/valueText JSON envelope shares the server's 1 MiB request limit.
Extra escaping counts toward that limit, so it is not a property-content
allowance. Creation/update expose ordinary metadata; property-specific PR
options are not accepted. The native HTTP create/PATCH operations still support
atomic fields/dependencies/properties mutations.

## Task Steps

```bash
daynight task step list <task-id>
daynight task step list <task-id> --json --project <project-id>
daynight task step show <task-id> <step-id> --json --project <project-id>
```

Steps are an independent ordered resource owned by a Task. The
[resource contract](../../docs/spec/daynight-task-steps.md#cli-读取) owns their
fields and read behavior. The CLI provides `list`, `show`, `add`, `update`,
`set-status`, `move` and `delete`; the parent Task's
ordinary show/list/graph does not contain the full Steps collection. Step status
is `todo`, `in_progress`, `done` or `skipped`, independent from Task status.

Project and Task arguments are complete UUIDs. A Step argument is exactly eight
hex characters, normalized to lowercase on input with leading zeros preserved;
full UUIDs, prefixes and display numbers are invalid. For reads, explicit `--project`
works outside Git and sends the selected Steps GET directly, without hidden
project or parent reads. Without it, normal repository project discovery runs.
Group and operation help complete before configuration, Git or network work.

List reads the complete collection once, retains saved order and prints the
Task, exact parent Version and Steps count, followed by one-based display numbers,
full short IDs, statuses and untruncated titles. Empty output reports zero Steps.
Show prints the complete target title, description, status and created/updated
timestamps with its Task/project scope and parent version. Both use visible
terminal-control and bidi-control escapes and preserve all text. `--json` emits one complete
StepsResource or StepResource with raw strings, every required field and exact
int64 JSON numbers, followed by LF; it does not use a Task-list projection or
output a bare Steps array.

Typed reads validate complete fields, requested scope, canonical response IDs,
collection uniqueness, four-state values, original text and UTC microsecond
timestamp strings. They preserve array order and time spelling without sorting,
rounding or filling missing values. Malformed or mismatched resources, duplicate
IDs and read failures remain errors rather than empty collections. Reads retain
the shared request/operation deadlines, cancellation and response-byte budgets.
The endpoint body cap is 64 MiB, inclusive, and is combined with the configured
response budget by taking the smaller bound. Stricter configured limits still
win, total-operation bytes remain charged, and shared defaults do not change;
no partial resource reaches stdout before full validation and rendering. An
output failure can still leave partial stdout and is reported as a failure.
Errors go to stderr with exit status 1; argument errors use 2 and success uses 0.
A 401 includes `daynight login` guidance without automatic login or retry.
Help, Bash/zsh completion and the standalone manual expose the delivered
list/show/add/update/set-status/move/delete commands. The [server acceptance owner](../daynight-server/README.md#built-process-acceptance-and-ci-evidence)
maps the real-service installed Node-entry read case, separate maximum-resource
check and their normal fixture prerequisites. The packed CLI acceptance runner
checks literal `daynight`/`dn` launchers through cross-spawn on native platforms.
Manual copy/byte checks establish package resource fidelity separately from
these complementary runtime and launcher checks.

### Add a Step

```bash
daynight task step add <task-id> --title "Coding round 2" --description "Review findings" --project <project-id>
daynight task step add <task-id> --title "Review round 2" --id 00abcdef --status todo --after <step-id> --if-version <observed-version> --json --project <project-id>
```

Add requires a raw nonblank title. Description may be empty; omitted description
and status mean empty text and todo. Before/after are mutually exclusive Task-local
anchors; omitting both appends. Input IDs normalize without losing leading zeros.
Without an explicit ID, the command selects the first eight-hex segment of one
UUIDv4 before submission. A separate full UUID identifies the POST through
X-Request-ID. Neither identity is regenerated after a conflict or unknown result.

An explicit project/version sends one POST without discovery or resource pre-reads.
Without --if-version, the command reads complete Steps once and posts that parent
version once; failed pre-read prevents POST. All calls use the same operation,
credentials and budgets. JSON request encoding retains the 1 MiB body bound,
including escaping, without truncating submitted text.

Confirmation requires 201, principal and canonical Location plus a complete valid
resource, exact version +1, the requested target fields, equal new timestamps
and correct append/anchor placement. A default pre-read also permits checking
that prior items remain unchanged. Explicit versions do not add a hidden GET.
Readable success is `Step added. ID: <id>` plus the complete confirmed collection;
--json emits only that full resource and LF.

A decoded 4xx remains a known refusal, including capacity encodedBytes and
maxEncodedBytes. A dispatched write without a trusted full receipt stays unknown,
exits 1 and prints no success resource. At most one full GET with originalUUID.r1
may observe current version and target found/absent inside the same still-live
operation. Presence or absence never attributes the historical Add. Cancellation,
operation deadline or total-byte exhaustion creates no detached recovery; no
observation uses old pre-read data as a fallback. Diagnostics retain original
Project/Task/Step IDs and request UUID, report observed server IDs separately,
and provide ordinary explicit-project list/show guidance. Echo equality is not a
confirmation condition. There is no replay, replacement ID or public request-ID
flag. Once a full receipt is confirmed, later cleanup/render/output failure keeps
that confirmed fact and identity, with nonzero exit; output failure may leave
partial stdout. The [Steps contract](../../docs/spec/daynight-task-steps.md#cli-添加与结果确认)
owns these outcome rules and the server guide maps installed Add verification.

### Update content or status

```bash
daynight task step update <task-id> <step-id> --title "Review round 2" --description "Findings and [result](result.md)" --project <project-id>
daynight task step update <task-id> <step-id> --description="" --if-version <observed-version> --json --project <project-id>
daynight task step set-status <task-id> <step-id> skipped --if-version <observed-version> --json --project <project-id>
```

Update requires --title or --description and saves both atomically when supplied.
Omitted fields keep their values; an empty description explicitly clears it. Titles
require a non-Unicode-White_Space character, including a valid standalone U+FEFF;
standalone U+0085 is invalid. All text is preserved without trimming. Status uses
the separate set-status command and accepts any of the four states directly,
including the current state, independently from Task status or other Steps.

An explicit project/version sends exactly one PATCH for content or one PUT to
/status. Without --if-version, the command reads complete Steps once before that
single write; failed pre-read prevents submission. Versions retain exact int64
digits, and requests share Add's 1 MiB JSON bound and operation budgets.

A complete valid 200 receipt must match scope, target ID and explicitly submitted
fields, with parent version unchanged or increased by one. When a pre-read exists,
confirmation also checks omitted fields, collection order, all non-target fields
and target creation time. Equal values require unchanged version and timestamps;
actual changes require version +1 and a changed target update time. An explicit
version adds no hidden GET and cannot prove old values that were never read.
Readable success prefixes the confirmed collection with `Step updated. ID: <id>`
or `Step status set. ID: <id>`; --json prints only the complete resource and LF.

These operations share Add's refusal, capacity-details, unknown-result and
confirmed-local-failure handling. Stale versions are never replayed, and a later
current-facts read cannot confirm the historical mutation. The
[update contract](../../docs/spec/daynight-task-steps.md#cli-更新与状态确认)
owns the complete confirmation rules.

### Move a Step

```bash
daynight task step move <task-id> <step-id> --first --project <project-id>
daynight task step move <task-id> <step-id> --after <anchor-id> --if-version <observed-version> --json --project <project-id>
```

Exactly one of `--before`, `--after`, `--first` or `--last` is required. Target
and anchor IDs are complete Task-local eight-hex values, normalized to lowercase
with leading zeros preserved. A relative anchor must be another Step in the same
Task. Invalid combinations and self-reference fail before configuration or network
access. Movement preserves every Step's identity, content, status and timestamps.
Moving to the current position is a no-op; it still checks the submitted version.

Explicit project/version sends one PUT to the target's position resource. Without
`--if-version`, one complete Steps GET supplies the version before one PUT; failed
pre-read prevents submission. Confirmation requires a complete valid resource,
matching requested position and either the submitted version or version +1.
With an actual pre-read, confirmation also checks every record and its times,
all surviving relative order, and exactly no-op versus +1. Explicit versions
retain the one-write budget and cannot compare an unobserved earlier collection.

Readable success prints `Step moved. ID: <id>` and the service-confirmed order;
`--json` emits only the complete resource and LF. Known refusals preserve service
codes, request IDs and capacity details. Unknown Move results retain the original
Project/Task/Step identity and request UUID, use at most one same-live-operation
`.r1` GET to report current facts, and remain unknown with exit 1 and empty
success stdout. No PUT is replayed. Cancellation or exhausted operation budgets
prevent detached recovery; confirmed local output/cleanup failures retain the
confirmed result and nonzero exit, as with Add.

### Delete a Step

```bash
daynight task step delete <task-id> <step-id> --project <project-id>
daynight task step delete <task-id> 00ABCDEF --if-version <observed-version> --json --project <project-id>
```

Delete removes the specified Task-local record and description in any Step
status. Referenced attachments, PRs, Sessions and other materials remain; there
is no history or restore command. IDs normalize case while preserving leading
zeros. Explicit project/version sends one JSON DELETE whose body contains only
version. Without --if-version, one complete Steps GET supplies the version;
a failed pre-read prevents DELETE.

A complete valid 200 receipt must confirm scope, principal, version +1 and target
absence. With a real pre-read, all remaining records must retain their fields,
times and relative order. Explicit versions do not add a hidden baseline read.
Readable output is `Step deleted. ID: <id>` plus the full confirmed remaining
collection; --json prints only the complete resource and LF. Deleting the last
record returns steps: []. Repeated deletion, a deleted parent, version conflict
and version exhaustion remain visible errors.

Delete shares Add's request identity, refusal, unknown, cancellation and confirmed
local-failure handling. Its one eligible read reports current found/absent facts;
absence does not prove that the unknown request deleted the original record,
and a current same-ID record need not be that original record. No DELETE is
replayed. The [deletion contract](../../docs/spec/daynight-task-steps.md#cli-删除与结果确认)
owns these guarantees.

## Task deletion

Read the task and use its observed version when deleting it:

```bash
daynight task show <task-id> --json
daynight task properties <task-id> --json
daynight task properties --schema --json
daynight task set-property <task-id> pullRequests '[{"url":"https://github.com/owner/repo/pull/123","title":"Fix synchronization"}]' --if-version <observed-version>
daynight task remove-property <task-id> pullRequests --if-version <observed-version>
daynight task delete <task-id> --if-version <version>
```

Deletion removes the task from normal queries and prevents later reads and
changes. Stored task data, its own prerequisite references and attachment files
remain. An active worker claim on the target prevents deletion. Without
`--remove-depends`, an undeleted task depending on the target also prevents it.

To explicitly remove every other task's ordinary and external dependencies on
the target in the same transaction, use:

```bash
daynight task delete <task-id> --remove-depends --if-version <version>
```

This includes references added before that transaction executes and may make
affected tasks ready. Each changed dependency owner receives a new version;
its status, timing and other data stay unchanged. Deletion requires explicit
authorization for the target; removing other tasks' dependencies requires that
additional authorization.

Without `--if-version`, the CLI reads the current version immediately before the
write. Conflicts and failed writes are not retried. After an interrupted or lost
response, read the task to reconcile before considering another request. An
authorized read returning `410 task_deleted` confirms deletion; a live resource
requires a new decision, while a permission or transport failure leaves the
outcome unknown. The [deletion requirements](../../docs/spec/daynight-task-deletion.md)
and [design](../../docs/design/daynight-task-deletion.md) own retained history,
reference removal and cache invalidation.

## Task discussion threads

```bash
daynight task thread read <task-id>
daynight task thread read <task-id> --after-id <last-read-message-id> --count=20
daynight task thread read <task-id> --before-id <first-shown-message-id> --count=20
daynight task thread read <task-id> --details --project <project-id>
daynight task thread post <task-id> --body 'What should the retry policy be?'
daynight task thread post <task-id> --body 'Use an explicit retry decision.' --reply-to <message-id>
daynight task thread post <task-id> --body 'The check passed.' --claim-id <active-claim-id>
```

A Thread holds durable discussion independently of task execution. Reads and
posts work before execution, while its original environment is offline, and
after completion. Messages are immutable and replies refer to messages in the
selected task. Posting neither changes task metadata nor wakes an Agent.
Descriptions and attachments remain the owners of effective requirements,
solutions and formal results; Sessions hold execution content.

Read fetches one page, defaulting to the latest messages. `--count=N` accepts
1 through 100 and defaults to 20; the CLI always sends that value explicitly.
`--before-id` and `--after-id` are mutually exclusive. Messages display from old
to new with complete Id, Author and account Id, millisecond UTC CreatedAt,
optional ReplyTo, and complete Message. Agent authors also have `Agent: True`.
`--details` expands verified claim, worker and provider attribution. Thread
commands provide readable text and do not accept `--json`.

`... Has more messages before` appears above a page with earlier messages;
`Has more messages after...` appears below a page with later messages. Continue
history with the first displayed Id and incremental reading with the last
fully consumed displayed Id. The 256 KiB output budget can reduce the page
below its requested count; complete messages remain contiguous and bodies are
never truncated. A post receipt cannot advance the read position: after reading
A, another person's B and a local post C must still be read from A.

Post requires nonblank `--body`, preserving its original whitespace. For text
beginning with a dash, use `--body=-example`. The service generates the message
Id and authenticates the author. Omit `--claim-id` for an ordinary account post;
provide a current claim explicitly for verified Agent attribution. The CLI does
not infer a claim or accept a client message Id, version or submission token.
`--reply-to` is optional and must identify a message in the same task.

Terminal text escapes dangerous controls. Multiline Message lines are indented,
retain LF and TAB, and encode literal backslashes before visible control
escapes; DEL is `\x7f`, CR is `\r`, and other unsafe controls use `\uXXXX`.
The representation preserves the full body without executing terminal escapes.
Success prints `Message posted.`, the complete Id and optional ReplyTo, without
repeating the body. An uncertain post exits with a clear unknown-outcome message.
Read the Thread before deciding whether to send again; equal text cannot prove
that a particular request succeeded. The CLI never automatically repeats POST.

The [Thread requirements](../../docs/spec/daynight-task-thread.md) own the
service contract; the [CLI design](../../docs/design/task-thread-cli.md) owns
source validation, rendering and submission confirmation. Explicit `--project`
uses the supplied UUID directly for the Thread request; otherwise the existing
Git binding resolves the project. Origin and credential remain fixed for one
invocation. Argument errors exit 2 before configuration or network access;
other failures exit 1. Diagnostics remain on stderr and exclude message bodies
and untrusted server text. A confirmed post followed by a local receipt-output
or cleanup failure retains its confirmed message Id and is not reported as an
unknown remote result.

## Task attachments

Attachment commands use the existing project selection and server configuration:

```bash
daynight task attachment put <task-id> ./design.md --path docs/design.md
daynight task attachment put <task-id> ./mockup.html --path mockup/index.html
daynight task attachment list <task-id> --tree
daynight task attachment list <task-id> --json
daynight task attachment read <task-id> docs/design.md
daynight task attachment read <task-id> images/mockup.png > ./mockup.png
daynight task attachment remove <task-id> docs/design.md
```

Each upload accepts one local regular file. Without `--path`, its basename is the
target path; the same complete task-relative path is overwritten. Names preserve
case and Unicode spelling, with `/` separators and no absolute or dot-segment
paths. The content type comes from the target path's extension, even when it
differs from the local filename; unknown extensions use
`application/octet-stream`. Uploads and deletions affect one file at a time.

`list` reads every page before emitting its complete metadata result. `--tree`
and `--json` select mutually exclusive formats. `read` writes the original bytes
without labels, decoding or an added newline. Diagnostics remain on stderr;
a failed transfer can leave incomplete stdout and exits nonzero. File transfers
stream with backpressure and retain the shared deadlines and cancellation;
metadata JSON keeps its existing byte budgets. Use `--` for a dash-prefixed
positional path, for example:

```bash
daynight task attachment put --project <project-id> <task-id> -- -design.md
daynight task attachment read --project <project-id> <task-id> -- -design.md
```

Failed writes are not retried. File storage and PostgreSQL metadata are not
atomic; an unsuccessful operation may already have changed storage. The
[attachment requirements](../../docs/spec/daynight-task-attachments.md) define this
known issue and the trusted same-origin preview model. The
[authentication architecture](../../docs/design/daynight-auth.md) defines the required
authentication and project-membership checks for attachment requests. Trusted
executable HTML retains the application origin. The
[CLI delivery decision](../../.agents/notes/archived/feature/2026-10-21-task-attachment-cli.md)
records binary transport and output ownership.

## Bot management

Bot commands use the configured server and signed-in account. They work in an
ordinary directory without Git or a Project and do not accept `--project`.

```bash
daynight bot list --json
daynight bot create --name "Planning assistant" --json
daynight bot show <bot-id> --json
daynight bot delete <bot-id> --if-version <observed-version> --json
```

Creation needs only `--name`. Optional `--worker`, `--cwd` and `--agent` preserve
explicit choices; the service resolves and freezes omitted settings. The
specified directory belongs to the target Worker, may be outside a repository,
and must be an absolute path for that machine. The CLI does not create it or
substitute the local working directory. A successful response reports the actual
`startupResult`: accepting a `pending` definition does not establish a running
or ready assistant. An existing `ready` result is a startup observation, not a
promise that its Worker is currently online.

Creation and deletion accept `--request-id <uuid>`. When omitted, the CLI generates
the UUID before sending the write. For creation it is the Bot ID; for deletion
it is the `deletionId`, while `<bot-id>` still identifies the Bot. Keep the
original identity and payload when checking an uncertain response. The CLI never
retries a write automatically or generates a replacement ID after a failure.
Use `daynight bot show <bot-id> --json` to read current facts before deciding
whether another write is appropriate.

Deletion requires the exact observed `--if-version`; the CLI does not fetch a
new version to replace it. Bot versions, creation order and requested deletion
versions are positive int64 decimal strings in JSON, including values beyond
JavaScript's safe integer range. A version conflict remains an error. Read the
current Bot and reassess the deletion instead of blindly resubmitting it.

Deletion output retains the original request identity and both `workerCleanup`
and `serverCleanup` results. A pending stage means cleanup is unfinished; only
both stages completed establish completion. A failed stage retains its error
code. Deleted definitions disappear from `bot list`, while `bot show` returns
only their minimal deletion responsibility. List disappearance is not proof of
process termination or history removal. The current service accepts deletion
intents only for Bots without a bound Session and refuses bound Bots; full
Worker stopping and conversation cleanup remain separate capabilities. The CLI
entry points do not enable the complete assistant UI or establish complete
Bot hosting.

All four commands support `--json`. `list` emits an array; `show`, `create` and
`delete` emit a Bot resource. Lists follow every page and produce output only
after all pages succeed; a later-page error is not an empty or partial success.
Operation failures exit 1. With `--json`, stderr contains one
`{ "error": { ... } }` object with `operation`, available `botId`, `requestId`,
`phase`, HTTP `status`, `code` and `serverRequestId`, plus `outcomeUnconfirmed`.
Known configuration failures and request conflicts also include an actionable `reason`; missing authentication reports `login_required`.
An unknown write also supplies `reconcile`, containing the original Bot's show
command. The client `requestId` identifies the creation or deletion request;
`serverRequestId` correlates the response. HTTP 401, 403, 404 and 409 remain
failures. Diagnostics do not print credentials, raw transport causes or server
error bodies. Invalid command syntax retains the normal text diagnostic and
exit 2 even when `--json` is present.

The [assistant requirements](../../docs/spec/assistant.md) define management and
lifecycle behavior; the [design](../../docs/design/assistant.md) explains identity,
version and deletion ownership.

## Remote Worker queries

```bash
daynight worker list --json
daynight worker show <worker-id> --json
```

These commands read the current account's remote observations without a Project,
Git repository or local Worker configuration. They neither start a Worker nor
take its local runtime lock. `worker repo list` separately lists repositories
configured on this machine.

`worker list --json` returns `{observedAt,items}` after every page succeeds.
`worker show --json` returns `{observedAt,worker}`. The service includes Workers
reported within the last 72 hours; an older, missing or inaccessible Worker is
not a current detail result. `observedAt` is server time, and `lastReportedAt`
identifies the retained report. Human-readable online/offline state compares
those timestamps using the 120-second threshold; it does not reserve capacity
or prove a Provider can start.

Task observations remain distinct from connection state. `unavailable` inventory
has null `activeTaskCount` and `taskObservedAt`, not zero tasks; `stale` retains
an earlier observation. Detail includes task identities, resource probes, their
sample times and errors, and optional `assistantHost` observations. A missing
assistantHost means hosting support has not been reported. Offline Workers,
failed probes and unknown inventories are never reported as idle capacity.
Read or later-page failures remain errors rather than an empty success.
With `--json`, operation failures print one `error` object on stderr with the
operation, optional Worker ID, phase, HTTP status, code and response request ID.
No raw transport cause or server error body is printed; missing authentication
reports `reason: "login_required"`. Failed reads exit 1.

## Worker configuration and startup

`daynight worker run` is a foreground reconciler. It claims eligible ready tasks
assigned to its authenticated account across configured repositories, runs native agents through the claim's Herdr or
Web backend, and stops executions when the original claim leaves its complete
inventory. Resource deletion also requires the backend's cleanup and archive
conditions. The agent owns delivery, acceptance, evidence and final claim-bound
completion. Worker follows the CLI platform support policy: Linux, Windows and
Apple Silicon (ARM64) macOS.

The running worker reports an account-owned runtime snapshot immediately after
identity and authentication are ready, every 30 seconds, and after complete task
inventory or a confirmed new claim. Reporting remains independent of execution
polling, including idle periods, full capacity and long task operations. The
service uses its last valid report time for the 120-second offline threshold and
72-hour recent-worker window; observation does not release claims or change
task status.

Snapshots include actual OS, logical CPU count and utilization, memory usage,
and available/total space for the filesystem containing the directory where
`worker run` started. They also include the running Daynight version, a read-only
private Herdr version observation, and Codex/Copilot installation and versions.
Native CLI results are cached for at most 60 seconds with their original check
time. Reporting does not run launch preflight or repair integrations; a pure-Web
worker does not start Herdr to collect its version. Unknown task inventory and
observed idleness remain distinct, and individual probe errors remain explicit.
The [reporting requirements](../../docs/spec/daynight-worker-reporting.md) and
[design](../../docs/design/daynight-worker-reporting.md) define sampling,
bounded attempts, cancellation and sanitized diagnostics. Reporting uses the
existing service credentials and stable worker identity, with no separate
command or configuration switch.

Start with interactive setup:

```bash
daynight login
daynight worker setup
daynight worker run
```

`setup` requires terminal input and stderr. It reports environment checks and
repair instructions, asks which native agent should execute tasks, then lists
existing accessible Projects with names, UUIDs and repository URLs. Select at
least one Project. Current Projects are preselected on repeat setup. The final
selection replaces the acquisition list, and the chosen agent applies to every
selected Project.

Matching registrations keep exact transport URLs and local paths. Compatible
models and arguments survive; switching agent clears incompatible global and
per-Project values. Setup previews Projects, paths, removed registrations and
native-setting resets before confirmation, then atomically saves agent settings
and the complete selection. Cancellation, invalid choices, inaccessible Project
inventory, related concurrent changes and write failures leave configuration
unchanged.

Local diagnostics inspect tools and integration settings without starting Herdr
or native agents. Missing prerequisites are reported together; selected-agent
checks use effective retained native arguments in the setup launch directory.
Missing native dependencies allow saving with a repair-needed result. Versions,
fixed launch-argument capabilities and hook configuration do not prove provider
authentication, hook execution, live Herdr protocol, Git access or completed
delivery.
Setup does not install tools, edit provider configuration, sign in, clone, open
worker state or acquire tasks. Unconfirmed probe-process cleanup is a failure,
including during cancellation.

Herdr mode requires Git, Herdr 0.9.5 or newer with protocol 22 capabilities, and the selected
native agent on PATH and configure native/provider credentials. Before each
fresh or resumed native launch, runtime preflight reads the selected agent's
official integration through the private daemon. A `current` integration causes
no installation write. Only `not_installed` or `outdated` triggers the official
`integration.install` RPC with `{target: agent}`; preflight then reads the state
again and requires `current`. Missing, duplicate, malformed or unknown integration
metadata fails without repair. Each launch makes its own integration requests to
the private daemon, whose official handler performs the installation.

The official installer can update native configuration and hook assets in the
provider home used by the private daemon. Codex repair requires a live private
daemon started by the current worker, so its native environment matches the
configuration being checked. An adopted daemon's environment cannot be verified
through the API; stop and restart the worker normally before attempting Codex
repair in that case. Repair also requires the audited Herdr 0.9.5 installer and
checks its projected TOML edit without writing files.
The original and projected configurations must parse and differ only by enabling
`features.hooks` and removing the deprecated integration key
`features.codex_hooks`. Configurations containing date/time values or parser
constructs whose exact semantics cannot be compared are refused. Inline, dotted
or quoted feature layouts and multiline strings that this installer would damage
fail before `integration.install`;
reformat the affected configuration or use an integration installed safely by
its owner before retrying. Unknown installer versions also fail before repair;
already-current integrations keep their ordinary verification path. The check
compares configuration values; it does not preserve comments or lock out external
configuration edits between inspection and installation.

Preflight still verifies effective hooks and the SessionStart command in the
actual task directory before launch; installation success alone is insufficient. Installation, verification and
cancellation failures remain visible and prevent that native launch. An uncertain
installation outcome is not automatically replayed; a later attempt first reads
current state. Setup retains its read-only inspection and repair instructions.
Inspect shell-side integration with `herdr integration status`; its environment
can differ from the running private daemon's.

Codex must be 0.135 or newer and support hooks, `--no-daemon` and the fixed
full-access/hook-trust flags. Unix hooks need bash and python3, while Windows
hooks need PowerShell. Native capability and launch failures remain visible.
Git transport and task tools, such as authenticated GitHub CLI for PR delivery,
must be ready.

Manage individual Project registrations with:

```bash
daynight worker repo add
daynight worker repo list
daynight worker repo remove
```

Add and remove offer multiselection with each Project's name, complete UUID and
repoUrl. New entries save projectId, the original repository URL and an absolute
local path. Matching existing entries retain their transport URL, path and
agent settings; remote-only entries gain only projectId. Remove changes future
acquisition scope and preserves clones, claims, worktrees and native history.
For scripts, select one Project explicitly:

```bash
daynight worker repo add --project PROJECT_UUID
daynight worker repo remove --project PROJECT_UUID
daynight worker repo list --json
```

List reads local registrations. Add and remove use existing remote Projects;
they do not create Projects, clone repositories, acquire tasks or start Herdr.
Cancellation, empty selection, failed remote reads and save errors leave the
selection unchanged.

With an empty repository list, interactive run guides the same selection before
starting tasks. Noninteractive startup requires a configured repository and
prints `worker repo add --project PROJECT_UUID` guidance. Service credentials
and selected worker settings come from one captured configuration source;
changed credentials require restarting the command. Startup resolves configured
Projects into the local projects table before reading claim inventory, including
when the state database is empty.

`worker.repositoryRoot` defaults to `~/daynights`, independently of review's
root. New registration expands the actual home shortcut or resolves a path
relative to config.yml; existing paths are retained when the root changes.
Ordinary repositories use `<root>/<host>/<owner>/<repo>`; generic transport,
user, port and nested-path identities use distinct encoded coordinates.

Network and prompts hold no configuration lock. The atomic writer rereads YAML,
preserves comments and unrelated edits, and refuses changed worker root,
repository selection or service credentials. Setup also protects observed global
agent/model/args values and saves those fields with the selected Projects. Repo
commands only own repositories; neither operation changes repositoryRoot. Shared aliases that would alter
unrelated effective settings are rejected; unaffected aliases remain valid.
Repository identities, Project IDs and physical paths must remain distinct,
including the Daynight state directory.

For explicit paths and runtime overrides, retain the shared service and review
settings and configure worker directly:

```yaml
worker:
  repositoryRoot: ~/daynights
  maxConcurrent: 1
  pollIntervalMs: 60000
  recoveryLimit: 3
  agentControlMode: herdr
  agent: copilot
  model: null
  args: []
  repositories:
    - remote: https://github.com/OWNER/REPO.git
      path: ../code/repo
    - remote: https://github.com/OWNER/OTHER.git
      path: ../code/other
      agent: codex
      model: null
      args: []
```

These are the defaults for optional runtime fields. A missing file, omitted
worker mapping and `worker: {}` use the same defaults; omitted repositories is
an empty list. Worker never infers repositories from review. Reads do not create
or rewrite configuration. Unknown root, worker and repository-entry fields are
ignored at runtime and preserved during configuration edits. Known non-nullable
fields still reject explicit null, invalid types or values; malformed YAML,
filesystem failures and cancellation remain errors. model:null clears the model
setting.

Each repository requires remote/path and may specify projectId or agent/model/args.
The service Project must already exist and match the repository; use projectId
when remote discovery is ambiguous. Missing local repositories are cloned;
existing roots and origins are verified without resetting files or branches.
Credentials belong in native authentication configuration, outside repository
URLs and argument lists.

Entry paths are absolute or relative to the configuration directory, never the
launch directory. They do not expand tilde or accept Windows drive-relative
paths. Duplicate repositories/Projects and overlapping repository/state paths
are errors. maxConcurrent is positive, recoveryLimit is nonnegative, and
pollIntervalMs is a positive safe integer within the timer range. After each
reconciliation round completes, the worker waits this interval (60 seconds by
default). Explicit values, including 5000 for a 5-second wait, remain unchanged.

Repository agent settings override fields independently for the same type.
Explicit null model or [] args clears that field; switching type clears omitted
model/args, and args replaces the list. Worker owns cwd/session/model/mode
arguments and the fixed full-access policy; conflicting arguments are rejected
before launch. Configuration loads at startup without hot reload. Each claim
retains its recorded agent type and native session ID; a restarted agent uses the
current settings appropriate to that type. Settings for another type are not
applied to it.

New tasks have automatic execution disabled. Enable it explicitly through the
normal task update workflow after reading the current task and version. Worker
only acquires ready, permitted tasks compatible with its actual platform; WSL is
Linux. It never enables permission itself. Released tasks wait for explicit resume.

```bash
daynight worker run
```

First use generates and atomically saves stable root workerId. One instance owns
`worker/` state under the selected configuration root (default `~/.daynight/worker/`), its SQLite, lock, logs, temporary resources and
private Herdr resources. On macOS, each actual run has its own existing Herdr
daemon and durable lifecycle record; Linux and Windows use the shared private
daemon. Each task uses branch `daynight/<task-id>` and directory
`<repository>/.worktrees/daynight/<task-id>`. Valid claims retain their dirty
worktree; task branches and commits remain after terminal cleanup.

A workspace label starts with the task title and ends with its full stable owner:

```text
Fix worker startup | daynight:{"projectId":"…","taskId":"…","claimId":"…","worktreeId":"…"}
```

The title is display text. Ownership checks and the managed agent name use only
those four canonical UUIDs; renaming a task does not change its claim, worktree,
agent name or native conversation. Herdr and Git ownership markers share that
four-field identity. The configured service address remains available to API
requests and the managed assignment; the macOS lifecycle journal additionally
binds the service, Worker and authenticated owner to the original runtime. One retained
worker state directory belongs to one configured service.

The next successful complete claim inventory supplies the latest task title.
Changed names are synchronized through Herdr in the task's existing serialized
operation, including when execution recovery has reached its limit. An unchanged
name sends no rename request. A naming RPC failure reports `workspace-name-error`
without spending execution recovery budget or restarting a healthy agent; an
unknown result is observed again before a later decision. Ownership, binding and
cancellation failures retain their lifecycle semantics. Titles may contain the
label delimiter because parsing uses the final owner suffix. Control characters,
line separators and bidirectional display controls are escaped as visible text;
Unicode titles and emoji remain readable. Full titles and owner IDs are retained,
with Herdr responsible for fitting the label into its current terminal width.

The local claim index has these business fields:

```text
projects(project_id, repo_url, local_path)
tasks(project_id, task_id, claim_id, status, agent, session_id, agent_control_mode)
```

A separate `cleanup_schedules` table binds terminal cleanup responsibility to
the original Project/task/claim/worktree. It retains the first deadline, failure
count, next retry time, stage and error. It contains no notification-progress or
resource-completion flags.
These records preserve responsibility; they do not prove that resources stopped
or disappeared. A cleanup target without a known worktree ID keeps its existing
claim-index row and uses process-local backoff while rereading authoritative
resources. It never invents an ID or another ledger. An ended row with no globally
observed resources still enters a serialized cleanup job, which verifies actual
absence and removes only an empty unregistered reservation. A recognized resource
for another claim of that task remains untouched.

Status is pending, active or done. Pending is an actual acquired claim waiting
for startup; active owns startup, running, recovery or cleanup responsibility;
done means the claim's local execution has ended. macOS Herdr may still retain
its worktree and separate archive responsibility. Completed rows remain,
and at most one claim for the same Project/task can be active. A removed config
entry stops new acquisition but its saved Project mapping continues reconciliation.
Mappings with unfinished tasks or actual managed resources cannot be rebound.

The state directory belongs to the configured single service, Daynight account
and workerId. Finish old executions before changing those identities and
rebuilding local state. The running process pins its startup authenticated user;
the claim-index database does not retain prior-service or prior-account recovery
scopes. macOS Herdr execution evidence lives separately in
`worker/herdr-executions.sqlite`, with original run/process identities, Session
registration and connection state, input admission, stop journal and segment
boundaries. Missing evidence does not authorize recreation. An existing
unversioned or incompatible lifecycle journal is retained and rejected, not
reset. The claim index and cleanup schedule share `user_version=7`; upgrading
version 5 preserves its Project and task rows, while version 6 to 7 removes
notification submission flags and preserves the remaining cleanup schedule. The five non-lifecycle business databases
reset `user_version=0` after their ownership checks: the original schema and data
are discarded, then the baseline and numbered upgrades rebuild the current
format. This includes existing empty files and query access. Known valid nonzero
migrations preserve data; detailed worker formats 1–4 remain unsupported and are
retained on refusal. Stop the old worker and remove that unsupported database
yourself before new-schema startup. Keep workerId and native history. Each business database owns
its migration sequence; the [SQLite migration requirements](../../docs/spec/cli-sqlite-migrations.md)
define atomicity, ownership blockers and supported starting formats.

Each reconciliation obtains the complete own-claim inventory for configured and
saved Projects using only workerId. Assignment does not filter this inventory:
existing executions retain their recovery and cleanup authority. New candidates
combine assignedTo=me, ready, automatic permission and actual platform before
server pagination; the claim transaction rechecks the assignee against the
authenticated user ID. Unassigned tasks and tasks assigned to another account
are ineligible for automatic acquisition. Explicit manual resume retains its
original execution-owner/admin rules. Still-owned local active tasks are queued for fresh target
observation and recovery before global Git discovery, so a sibling checkout's
filesystem error does not block an already-reserved task. New pending startup
and new claims still require complete global resource discovery. Failed or
partial reads are errors, not an empty inventory. Resources from unqueried or
unmapped Projects are preserved with a diagnostic.

Capacity is the claim-deduplicated union of active rows, actual owned resources,
already selected cleanup responsibilities and adapter stop confirmations still
pending. An orphan keeps its slot and same-task barrier until all cleanup has
finished, even without a local row or after its pane has closed. On macOS, a
confirmed Herdr stop with closed segments and an acknowledged ledger releases
the execution slot while its retained worktree keeps the same-task barrier. A
queued recovery still reserves a slot. Git
markers identify a claim rather than a worker. A Git-only resource must be tied
to a local row, the private Herdr instance or a current own claim before this
worker can clean it; otherwise it is reported and preserved.

A candidate with retained same-task resources is skipped before remote claim.
An unknown claim response emits Warning and creates no resources. The worker
finds the actual grant in a later complete inventory instead of replaying the
request. A late grant can remain pending while local active slots are full. On
macOS, only a grant confirmed in its original acquisition or manual resume
operation can register fresh launch provenance. An inventory-recovered claim
without that durable record remains unknown; empty remote summaries cannot
authorize another launch.

Each reconciliation round acquires at most one new task across all configured
Projects, even when more slots remain free or the granted task must stay pending.
The next acquisition waits until the next round after `pollIntervalMs`, continuing
Project rotation and preserving server ready order within each Project. Empty
Projects are skipped. Existing pending rows have startup priority, with stable
task-ID order inside each Project; they can use multiple free slots in one round,
rotating Projects after each successful slot allocation.

macOS Herdr recovery uses the original lifecycle journal:

| State | Action |
|---|---|
| Matching original run is alive | Reconnect the same Session, advance only its connection epoch, and open a segment with an explicit restart gap. Do not resend the assignment. |
| Original run is confirmed stopped, its native ID and first-input result are known, and its claim remains valid | Resume the same native conversation in the next execution generation. |
| Launch, input or stop evidence is unknown, or a possibly launched run has no native ID | Retain responsibility and the worktree; do not create another conversation. |

Native launch and initial input are separate. The original daemon, shell and
agent identities must be durably recorded before input admission. The native
session ID can arrive after the first input. Before the native mutation, the
adapter rechecks the original claim, pause state, process identities and
admission. Unknown input outcomes are not replayed across restart.

On Linux and Windows, when a native Agent exits unexpectedly and current
resources confirm its pane is inactive, normal patrol automatically stops/closes that workspace and creates
a new one with the current native environment and an empty pane-level session
reference. Herdr restore can retain the old native reference while restoring the
shell without its extra launch environment. The saved SQLite session_id selects
resume or fresh startup; an inactive pane's retained reference is not saved as a
newly observed session ID. A live agent keeps its current connection.

A replacement shell can still be initializing when Herdr rejects `agent.start`
with `agent_pane_busy`. The adapter retries this explicit rejection for at most
two seconds while the original workspace, pane, terminal and cwd remain owned,
no Agent has appeared, and foreground process evidence confirms shell
initialization. Cancellation and the original operation deadline still apply.
Recovery within that call does not consume an execution failure attempt. Busy
foreground programs, missing process evidence, changed identities and unknown
launch outcomes remain visible errors; unknown launches are observed before
another decision.

On macOS, shell-readiness retries stay inside the same durable launch intent.
They do not create another generation or send the assignment. A successful
launch still requires durable native process identity before input admission;
an unknown response or a crash cannot authorize another launch or replay.

Startup, recovery and continuation prompts require autonomous decisions within
the task scope and existing authorization. Human intervention requires specific
information, a decision, authorization or an action that the agent cannot supply
within that scope and authority. Before waiting for that intervention, the
managed agent sets its own task's `paused` property to true with an observed
exact version and confirms the same assignment and pause before waiting. It
reports the issue and retains session context; the user chooses how to respond.
After verifying resolution, the original assignment and permission to resume,
it clears the pause and confirms false or absence before continuing. Independent
user restrictions still apply. The [managed workflow](src/commands/skill/skills/using-daynight/references/autopilot-managed-task.md#request-user-interaction)
owns readback, failure and conflict handling.

Pending PR review, required reviewer approval and CI remain ongoing execution,
including reviews performed by a person. Pending results and polling timeouts
do not justify setting `properties.paused=true`, requesting user intervention
or ending the turn. The agent monitors results and continues delivery while
honoring independent user pauses, restrictions and revocations. Fixed native
full access and folder trust apply to every fresh/resumed process; task delivery
remains within its business authorization.

For a still-owned active claim, each patrol observes the live agent. An
interactive-ready agent that is not launching and has no first input pending
receives a continuation ping when idle or done and its task is not paused.
Working, blocked, unknown and not-ready agents remain under observation. The
entire ping is enclosed in literal `<system remider>` and `</system remider>`
tags and preserves the original task, claim, worktree and authorization; idle or
done does not complete the business task. The driver retains the last input observation in memory and suppresses
repeated input while it is unchanged. Unknown submission results require
observation before another decision, without blind replay. Terminal cleanup
suppresses business pings.

Before a periodic ping reaches the native agent, the worker rereads the task
from the service after workspace serialization and native readiness checks,
verifies the original active claim, worker and worktree, and checks
`properties.paused`. A true value skips that input without advancing its
submission baseline. Setting false or removing the property therefore permits
a later ping even when native observation counters have not changed. Read
failures remain visible and send no ping. The last service read and native
submission are separate operations; pausing does not retract input already sent.
The legacy path applies this property to periodic continuation. The macOS
durable path also checks it before initial, deferred and resumed automatic
input. Observation, original-run stopping and human attach remain available;
pausing does not terminate a native process. Web execution currently sends no
such periodic pings.

A non-NULL saved session ID remains the recovery identity. A different native
ID reported during startup, live reconnection or before deferred input is an
error: the saved ID is retained and that input is not sent. A genuine live
agent's ID may fill a NULL record; inactive pane references remain excluded.

The legacy NULL rule covers interruption before a newly started native ID was
saved. On macOS that window is protected by the lifecycle journal: missing
identity or an unconfirmed launch cannot authorize a replacement. Recovery
counts and current model/args selection remain process-local; reaching
recoveryLimit preserves responsibility and reports an error. Retrying or
restarting does not bypass durable unknown-input or stop restrictions. Terminal cleanup retains its separate persistent
resource identity, original deadline and retry schedule across restart. A failed
resume of a known ID remains an error. Web recovery follows the persistent
rules below.

For human input, use another interactive terminal:

```bash
daynight worker attach
```

Attach needs no Daynight credential or service request and does not take the
worker lock or start a replacement daemon. On macOS with a lifecycle journal,
it reads the current schema without migration or recovery, selects among
unfinished recorded runs, and verifies the original daemon plus both socket
peers before connecting. Paused tasks remain attachable. An unreadable journal
or missing runtime is an error; only installations without a journal use the
legacy shared session. Detaching preserves execution. Task panes retain their
native XDG and private HISTFILE; client routing uses the original instance's
attachment descriptor.

Every fresh or resumed native process uses fixed full access and task-folder
trust. Copilot receives `--allow-all --no-ask-user --no-sandbox` and per-workspace
`COPILOT_ALLOW_ALL=true`, `COPILOT_ASSISTED_APPROVAL=false`, overriding inherited
values. Codex receives `--no-daemon`,
`--dangerously-bypass-approvals-and-sandbox`,
`--dangerously-bypass-hook-trust`, `-c check_for_update_on_startup=false` and a
final `-c` trusted-project override for the task's canonical path, using Codex's
normalized Windows trust keys. The update setting follows configured arguments,
so startup update checks and their interactive prompts stay disabled for fresh
and resumed Codex processes. Herdr receives the option and its value as separate
arguments; task input is submitted separately. These invocation settings require
no native tool, folder or hook permission confirmation and are not optional
configuration.

Copilot arguments that enable assisted approval or sandboxing, deny tools/URLs,
or restrict available tools are rejected. Codex approval/sandbox controls and
duplicate worker-owned bypass flags are rejected. Ordinary model, reasoning,
logging and additional configuration arguments remain supported. Setup and
runtime use read-only native argument-capability probes; unsupported flags or
versions fail explicitly.

The policy applies only to native invocations and task workspaces. Global native
configuration, credentials and organization/OS policies keep their existing
owners; task delivery still follows its business authorization. Input-readiness
and supported Codex composer checks remain. Unknown layouts, missing credentials,
integration failures and launch errors stay visible. Use attach for business
input. Reconnecting an already alive agent does not promise to resend an input
lost across a process interruption.

When the original claim is absent from a successful complete inventory, the
backend owns terminal resource cleanup. macOS Herdr writes its stop intent and
close request before controlled stopping. It checks original process birth and
audit identities, stops only its isolated runtime, persists the stop proof,
closes segments and confirms the same-generation ledger with the service.
Unknown identity, replacement or stop outcomes retain responsibility and block
new runs. A journal write failure permits only an unconfirmed best-effort stop;
pane disappearance cannot prove success after restart.

Herdr lifecycle registration advertises `observe=false`, `control=false` and
`archive=false`. Terminal recording, browser control and archive finalization
are not enabled. Consequently macOS Herdr terminal cleanup retains its worktree
and separate archive responsibility even after confirmed stopping. A durable
input arbiter revokes control before cleanup; it sends one bounded advisory
prompt only from safe automation with no manual draft or unknown input. Other
states skip the prompt and proceed with controlled stopping. No final ready
archive is claimed. A terminal run can mark
its local execution row done and release its slot after segment and ledger
confirmation, while
the retained worktree continues to block another claim for the same task.

For Linux/Windows legacy Herdr and Web, when the original claim is absent from a
successful complete inventory, the worker asks its agent to release attributable
temporary files, services and processes outside the worktree. It gives the
original agent an advisory cleanup opportunity until fresh observations permit
stopping or the original ten-minute deadline expires, then stops the agent,
closes its workspace and reconciles the matching worktree. Actual resource
absence permits marking the local row done. Done, release and force withdrawal have the same terminal
resource rule. Cleanup observations, notification, stop/close, and worktree
verification and deletion each have a five-minute operation budget, including
their RPC, cleanup provenance HTTP verification, Controller cleanup requests
and Git commands. Notification and
Controller cleanup-response waits are also capped by the remaining ten-minute
agent deadline. Ordinary execution keeps its existing operation budgets. Failed
stop or deletion retains responsibility and the error.

Known-target cleanup observes that Herdr execution directly; worktree deletion
validates only its target Git registration and directory. Shutdown proves the
original processes stopped without depending on Git discovery or cleanup retry
backoff. Unrelated repository or sibling-worktree registration errors are
reported separately and do not prevent a healthy agent from stopping.

Each bounded legacy Herdr cleanup call sends one advisory message to the still-live
original agent, then reads fresh snapshots until idle permits stopping, resources
disappear, or the original deadline expires. Sequence counters and interactive
readiness are not required. Failed or unknown notification results retain their
error and the same deadline without replay inside that call. Herdr provides no
queryable per-input operation ID, so interruption or restart can notify the
still-live agent again. The Worker keeps no notification progress ledger. Idle
selects when to stop; only current process and workspace absence establishes
resource cleanup. It does not complete the business task.

Terminal cleanup responsibility is recorded before notification or resource
removal. The original resource identity, deadline and retry policy survive
failure, cancellation and restart. Resource completion is always observed from
Herdr, the Controller journal, OS process instances, Git and the filesystem.
A missing worktree directory is already removed; its owned Git administration
is a separate remaining resource. Empty reservations and final-unlink residues
can be removed nonrecursively, while unattributable nonempty directories remain
protected. Worktree preparation can likewise remove an empty unregistered
reservation left before Git add and then create the intended checkout. Such stray
directories do not invalidate repository-wide discovery.
Restart resumes the same claim's remaining resources without starting business
execution. Previously confirmed cleanup responsibility can continue during later
service-read failures.

Failed claims retry independently after 1, 2, 4, 8, 16, 32 and then at most 60
seconds, when normal reconciliation next observes eligibility. Backoff does not
spend execution recovery budget or release a capacity slot. Other eligible
cleanup and healthy execution continue under the existing capacity limit. Errors
identify the failed stage and next retry time, distinguishing unconfirmed native
stop from a stopped agent awaiting backend closure, archive upload or worktree
removal. If a retry-state write fails, the current process retains bounded
backoff and both errors without claiming that the latest decision is durable.

Ctrl+C stops acquisition and scheduling, cancels all running jobs including
terminal cleanup, and joins them before directly stopping agents and closing
their workspaces. Process exit sends no cleanup prompt, does not wait for a
cleanup turn or retry backoff, and does not repeat archive upload or worktree
removal. It preserves claims, worktrees, native session IDs, unfinished
active/pending rows and existing terminal cleanup schedules, including ended
claims. The next run restores each saved responsibility and original deadline, then
verifies remaining resources. A retained Herdr cleanup
still requires its original backend even if current configuration uses Web;
backend initialization and retries remain local to that cleanup job and cannot
block unrelated Web execution. External temporary resources may remain after
direct interruption.
Normal completion, release, withdrawal and manual-control cleanup use their
backend's observed resource targets; the advisory notification applies to legacy
Herdr and Web. On macOS, shutdown closes the original run and segments without
finalizing the Session; recovery requires the original durable stop and native ID. Pending stop confirmations must settle before the private
Herdr instance stops; stop errors remain visible, and uncertain stopping retains
that instance and the affected resources. Before closing a verified orphan
workspace with no local task row, cleanup and exit save its observed native
agent and any live session ID in the existing pending claim index. Restart can
then remove its retained worktree and unblock a later claim for the same task.
An unknown original agent type retains the workspace with a visible error;
current configuration does not establish that historical type. Unproven Git-only
resources remain untouched.

The [Herdr input design](../../docs/design/herdr-input-arbitration.md) defines
`worker/herdr-inputs.sqlite`, strict terminal transport, retained operation IDs,
manual leases and explicit handback. Native idle and Detach do not resume
automation. Unknown inputs are never automatically replayed; an explicit initial
delivery disposition remains distinct from a provider acknowledgement. Strict
input currently requires the validated Herdr 0.9.5 protocol profile.

The [Herdr lifecycle design](../../docs/design/herdr-worker-lifecycle.md) defines
the persisted identities, crash boundaries and supported macOS process scope;
it does not promise to stop arbitrary detached background services.

stderr and JSONL logs identify worker, platform, Project/task/claim, agent and
known session ID. After credential redaction, the terminal renderer shortens each
full hyphenated GUID in context, messages and error chains to its first eight
hexadecimal characters, preserving case. Other text stays unchanged. JSONL keeps
complete IDs in fields, messages and errors for precise lookup. Startup prints
the log location and attach guidance. Routine observations report the first
connection and changes to a claim’s waiting or executing phase, terminal or native
session. Unchanged polls stay quiet, including
the first poll after a successful start. Claims are tracked independently.
Resource-preservation warnings appear once while continuously observed and
appear again if they clear and return. Actual starts, recoveries, cleanup, manual
operations and failed attempts remain visible. This reporting state lasts for
the current process. Logs are diagnostic only; they do not supply a second
recovery ledger. The
[worker requirements](../../docs/spec/daynight-worker.md) and
[design](../../docs/design/daynight-worker.md) own full behavior and validation.

## Web worker sessions

Set `worker.agentControlMode: web` and select `worker.agent: codex`, `claude` or
`copilot` in `~/.daynight/config.yml`. The default mode is `herdr`. The mode is
worker-wide, frozen by the service on each claim, and cannot be changed through
summary updates. Older service records without a mode mean Herdr. Changing
configuration affects new claims; existing work stays with its original backend.

Web execution does not initialize, start or probe Herdr. Independent runtime
reporting only reads the private endpoint for its version and does not initialize
the Herdr execution backend. Codex uses a private app-server over stdio, Claude
uses the bundled Agent SDK, and Copilot uses the bundled SDK with
its own headless runtime. Provider arguments are checked for that backend before
claiming. The service must advertise the matching Session protocol and provider.
Keep authentication in the native provider profile; credentials never enter a
Session URL. Open the task's Session tab for messages, tools, model and permission
settings, supported slash commands, native steer, interrupt and current approvals.
Unsupported native controls remain unavailable.

Copilot Web bundles SDK 1.0.11 and the `@github/copilot` 1.0.83 package, with token-authenticated loopback
transport to its private runtime. `COPILOT_HOME` chooses the native profile;
`model: null` and `args: []` preserve native defaults. Web arguments accept
`--effort low|medium|high|xhigh`. Plan approval supports exit-only, interactive
or reject with optional feedback. Unknown send results are not replayed or
resolved by matching historical text. Provider-specific runtime evidence is
required separately from protocol tests.

The primary worker database retains its claim and native-session index. Web
execution state lives separately in `~/.daynight/worker/web-executions.sqlite`
with its own format version 2. The version 1 upgrade removes redundant cleanup
input/results and stopped/closed/deleted flags, preserving cleanup intent,
identity and deadline. Version 0 resets its schema and data through the common
SQLite policy. Private launch tickets and Controller
journals live under `~/.daynight/controller/`; journals retain their independent
format version 6. Both Worker stores must open successfully before scheduling.
Web restart reconnects to a surviving Controller. Starting a new generation
requires proof that the original native processes stopped and the exact native
session ID. A missing journal or ID cannot authorize a replacement conversation.
Unknown initial inputs and operations are reconciled without replay.

Web recovery counts and diagnostic pause reasons persist across worker restarts.
Exhausted automatic recovery or the execution failure threshold pauses the
original execution before worktree preparation, Controller initialization,
launch or native input. An older exhausted stopped record without a pause reason
or orderly-shutdown provenance is reconciled from its journal and complete
process-stop proof before any launch;
uncertain stop evidence retains a diagnostic wait. A healthy final recovery
and its orderly shutdown restart are not paused merely because the count has
reached its limit.

A paused execution keeps its active claim, native session ID, worktree and
capacity slot. The worker continues publishing `waiting` with `herdr:null` even
when execution is blocked. A failed summary update is retried using a newly read
task version without consuming native recovery budget; an unchanged confirmed
summary is not written again. Ordinary restart and shutdown cannot clear this
pause. It is separate from `task.properties.paused`, which controls Herdr
continuation pings.

Normal Web terminal cleanup keeps its original cleanup operation identity and
deadline. Every attempt reads its operation receipt from the original Controller
journal, checks original process instances against the OS, reconciles the IPC
endpoint and remaining Git resources, and uses the resulting current observations
to determine completion. A recorded done status never suppresses these checks.
Native stop and the service's ready archive receipt precede worktree removal. Worker shutdown stops
owned processes while preserving unfinished claims, worktrees and native history.
The [session design](../../docs/design/task-session-protocol.md) owns stopping,
recovery and relay details. Herdr uses the separate platform-specific lifecycle
described above and never adopts Web Controller tickets as execution evidence.
Both modes retain terminal cleanup responsibility, its original deadline and
retry policy in the independent schedule, without resource-completion flags.

The worker starts `daynight controller codex|claude|copilot --launch-id <uuid>`
from a private immutable launch ticket. Its cwd, profile, claim, generation,
credentials and initial operation come from that ticket. This internal mode
cannot be combined with standalone prompt or provider options.

## Standalone Controller sessions

Start a Test Session in the current directory with the configured Daynight
service:

```bash
daynight controller codex
daynight controller claude
daynight controller copilot
daynight controller codex "Explain this project"
```

The optional prompt is submitted once. Without one, the browser composer accepts
the first message after initialization and synchronization. Provider creation
options use their native names where the adapter supports them; unsupported
options are rejected rather than ignored. Use the provider subcommand's help
for its supported options. These commands do not implement a native TUI or change
`worker.agentControlMode`.

The command prints the Test Session URL and remains in the foreground. Sign in
to Daynight as the account that started it; the URL itself grants no access.
The service's `/test-sessions` page lists that account's online Test Sessions.
Completed history is available through the original URL after its file archive
is ready. Native resume creates a separate execution. Use the sidebar or the
Session page's back link to return to the list; session IDs do not need to be
copied manually.
The page, history, resources, WebSocket and commands all enforce that ownership.
An expired or revoked credential cannot continue authorizing access. Tokens stay
in private local files and never appear in the URL.

Task and Test pages share the same timeline, composer and interaction handling.
Refreshing or closing a browser does not create or stop an Agent. Ctrl+C stops
the owned execution. Once the service confirms shutdown, the launcher uploads
its recorded timeline and resources to file storage for read-only access. The
service database stores archive metadata, not conversation payloads. Service
unavailability does not prevent local process cleanup; failed uploads retain
their private local source. The current directory and user files are never
removed by the launcher.

Retry a failed upload without starting or resuming the Agent:

```sh
daynight controller codex archive <test-session-id>
```

The same command supports `claude` and `copilot`. It verifies the original local
execution and stop evidence, and does not require the old working directory to
still exist. Use `-- archive` to send the literal word as an initial prompt.
Archives are limited to 64 MiB including resource encoding, with at most 8 MiB
per resource; incomplete or oversized archives fail explicitly and retain their
source. Completed pages disable all Agent controls.

Resume a stopped Test Session with its native context:

```bash
daynight controller codex resume
daynight controller claude resume <test-session-id>
daynight controller copilot resume <test-session-id>
```

Omitting the ID opens a terminal picker limited to the current directory,
provider and service. Noninteractive calls require the ID. Resume verifies local
ownership, native history and stopped-process evidence, then prints a new Test
Session URL with the same native conversation. It restores history without
replaying the original prompt or unknown operations. The old URL stays archived.
An active or uncertain native writer is refused; resume does not take control
of another process.

Standalone sessions do not create tasks, claims or worktrees, and do not provide
a background daemon, automatic recovery scheduler or arbitrary native-session
adoption. Worker lifecycle checks remain separate. The
[Test Session requirements](../../docs/spec/controller-test-sessions.md) describe
the supported behavior and verification boundary.

## Worker manual management

Stop `daynight worker run` before retry, release or resume. Each command
acquires the same instance lock and synchronously handles one specified claim;
an occupied lock returns an instruction to stop the runner. Management does not
write a durable intent or coordinate through a background request queue.

Retry performs one attempt for an active claim still owned by this worker:

```bash
daynight worker retry <task-id> --claim-id <claim-id> --project <project-id>
```

In Herdr mode, retry connects the live agent or resumes its recorded native
session. On macOS, missing launch provenance, unknown stop/input outcomes or a
missing original native ID after launch block replacement. The Linux/Windows
legacy NULL-ID path starts fresh in the same task worktree with an `info` event. Its extra attempt and recovery count remain process-local.

In Web mode, retry persists one authorization to recover the original native
session. It still requires the original active claim, matching generation and
complete proof that the old processes stopped. Missing native identity or stop
evidence cannot authorize a replacement conversation or a repeated initial
assignment. Authorization does not report successful execution: the summary
remains waiting through initialization until a ready or working observation, and failure
pauses again. The attempt remains bound to that generation across ticks and
worker restarts; initialization cannot authorize another generation.

Both modes retain the claim and agent type; pending rows are started through
normal run scheduling. After the attempt, run reconciles the actual surviving
resource and any persistent Web pause.

Release validates current Project access, source owner/admin, original claim
and exact supplied version. Its ordering is:

```text
notify and stop agent → close workspace → submit remote change
→ confirm source ownership ended → delete worktree → local done
```

macOS Herdr release instead confirms the durable original stop without a
cleanup prompt, submits the remote change, and retains the worktree until
archive finalization is available. The ordering above applies to legacy Herdr;
Web also applies its own archive gate. The worktree is retained until remote
confirmation. A refusal leaves it available
for original execution recovery; success followed by local deletion failure is
finished by the next run's ordinary absent-claim cleanup. Stopping failure cannot
supply stoppedConfirmed. Explicit --if-version is never replaced during cleanup.

```bash
daynight worker release <task-id> --claim-id <claim-id> --if-version <version> \
  --project <project-id>
```

Release returns the task to todo and clears its execution interval. Ordinary
automatic acquisition skips released tasks until explicitly resumed:

```bash
daynight worker resume <task-id> --claim-id <released-claim-id> --if-version <version> \
  --project <project-id>
```

Resume requires the previous released claim, ready task and original owner/admin.
Remote Worker control reads the caller's current `/projects/{id}/access`
projection for administrator authority and verifies its project/principal binding;
member profile reads retain their separate directory responsibility. Grant
versions preserve the full positive int64 range.
An original Herdr archive/worktree reservation rejects resume before a remote
claim is submitted. Otherwise it preserves the explicit manual
permission/platform exception, obtains fresh
claim/worktree identities with current settings, and registers pending with a
NULL native session ID. On macOS, the confirmed new grant also records fresh
launch provenance; any retained old worktree still blocks replacement until its
cleanup conditions are met. Start run to execute an eligible pending claim.

Web task details show the current claiming user, machine, agent and phase. The
original owner or a project admin can confirm **Force withdraw** for active or
released ownership. This submits the reviewed claim ID and exact version,
atomically clears worker ownership, returns the task to `todo`, clears both
execution timestamps and sets `allowAgents=false`. Other task materials remain.
It requires no stopped confirmation and does not guarantee that the remote agent
stops immediately. On its next successful complete own-claim inventory, the
original worker discovers its claim is absent and starts terminal cleanup.
Automatic selection stays disabled until explicitly enabled again. There is no
CLI withdrawal command or target-execution handoff.

Fresh IDs are generated and printed before remote submission. An unknown response
is reconciled by GET without replaying the write. If the result remains unknown
or the command is interrupted, inspect the remote task and claim before starting
run again; management has no cross-process intent continuation. A definite refusal
allows a new explicit decision with a freshly observed exact version.

## Review configuration and startup

Register a repository explicitly, or let the first review operation guide registration:

```text
daynight review add-repo https://github.com/OWNER/REPO.git
daynight review add-repo git@github.com:OWNER/OTHER.git --path ./review-other
daynight review run
```

For a local build, run `pnpm daynight review run` from the repository root.
These commands select `config.yml` under the [configuration root](#configuration-root). `review add-repo`
creates the configuration when absent. It reads, validates and saves configuration;
cloning, authentication checks, GitHub calls, SQLite initialization and PR boundary
selection belong to review startup. An already running reviewer keeps its loaded
configuration until its next startup.

All review settings belong under the `review` mapping. The same YAML also
accepts the server client's `serverUrl` and optional `serverToken` fields, the
`worker` mapping and generated `workerId`. Review validates its own fields
independently of server business values. The server projection requires a valid HTTP(S) origin and
validates any configured token and its transport. The shared parser rejects invalid YAML, duplicate keys and a non-mapping root.
Unknown fields at the root, inside `review` or `worker`, and in their repository
entries are ignored by runtime projections and preserved by configuration edits.
Known fields retain their type and value validation. Registration can add the
first review repository to a server-only file while preserving its settings and
comments. Flat review settings are ignored; move `repositoryRoot`, `repositories`,
numeric options and Copilot options under `review` to use them. The CLI does not
migrate these fields.

A configuration with an explicit addition root is:

```yaml
review:
  repositoryRoot: ~/daynights
  copilotModel: auto
  copilotReasoningEffort: high
  repositories:
    - remote: https://github.com/OWNER/REPO.git
      path: ../daynights/github.com/owner/repo
```

`copilotModel` and `copilotReasoningEffort` are independent optional fields for
all review repositories in the running process. Each configured value must be a
string containing non-whitespace text and no NUL; null and other value types are
rejected. Accepted strings are preserved exactly. Copilot owns model availability,
effort levels and model/effort compatibility; Daynight maintains no static lists.
`auto` delegates model selection to Copilot. Omitting either field sends no
corresponding override and preserves Copilot's choice, so neither, either or both
may be configured. Changes take effect on the next `review run` startup. Guided configuration
and repository registration preserve both fields and YAML comments. The server
configuration projection recognizes the `review` section without validating its
review-owned values.

`review.repositoryRoot` defaults to `~/daynights`. It is used only when
`add-repo` has no `--path`: the command derives filesystem-safe components from the normalized
host/owner/name and saves the resulting absolute repository path. A configured
root may be absolute, config-directory-relative, or begin with `~` for the current
OS user's home. Other users' tilde forms are rejected. Changing the root affects
future additions only. An explicit `--path` resolves against the command's working
directory and is also saved as an absolute path. Manually written repository paths
remain absolute or config-directory-relative and do not expand `~`; every repository
entry requires its own `path`.

Adding an existing normalized repository without `--path` reuses its saved path
and succeeds without rewriting configuration, even after the root changes.
An explicit path to the same actual location is also idempotent; an explicit
different path for that repository is an error.
Existing YAML settings and comments survive additions. The command validates the
complete resulting configuration before replacing the file atomically. Validation
and pre-replacement write failures preserve the original configuration; cleanup
errors after replacement remain visible. A separate
`~/.daynight/config.yml.lock` excludes another configuration writer and fails
clearly when occupied; it is independent of the review instance lock. After an
abnormal exit, confirm no configuration writer remains before removing this lock.
Configuration mutation rejects symlinks and nonregular files. A resulting
configuration containing `serverToken` uses POSIX mode `0600`; without a token,
existing file-mode behavior is preserved.

Numeric options use the documented [configuration defaults](../../docs/design/daynight-review.md#使用方式与配置)
when omitted. Explicit invalid values for known fields, duplicate YAML keys and
malformed documents produce nonzero exits with useful errors. Missing configuration
triggers the [configuration setup](#configuration-setup) rules before review
startup. Duplicate repository identities,
duplicate local paths, paths overlapping the retained state directory, and paths
with an existing nondirectory component are rejected. Missing clone directories
remain valid for later repository creation. Existing paths are compared by
filesystem identity. Missing destinations with the same existing ancestor and
component count are compared by temporarily creating one candidate's directory
names inside a unique probe directory there and looking up the other spelling.
This observes actual case and Unicode rules. Validation removes only the
directories it created, using nonrecursive removal. Probe permission, inspection,
or cleanup failures stop validation with an error.

The selected retained-state location is `DN_CONFIG_DIR` (default `~/.daynight/`) for SQLite, sessions,
locks, logs, cache, and temporary files. PR worktrees belong to each monitored
repository root's `.worktrees/` directory. `maxConcurrentWorker` limits concurrent
review preparation and execution. Startup acquires an exclusive instance lock,
opens SQLite and prepares the configured clones. Each repository is polled
independently; access failures retain its last complete observation and remain
visible in diagnostics. The
[repository registration decision](../../.agents/notes/archived/feature/2026-10-18-add-repo-configuration.md)
records the fixed-path and configuration-only choices.

## Review status listing

Print the configured repositories' locally tracked open PRs, including Draft PRs:

```text
daynight review list
daynight review ls
```

Both forms use the same persisted-snapshot operation and print repositories in
configuration order, with PRs ordered numerically. The columns are `PR`,
`PR STATE`, `REVIEW` and `ATTEMPTS`. Completed or failed reviews remain listed while their PR is open;
closed PRs and history belonging to removed configuration entries are omitted.

The output identifies its local snapshot source and each repository's
`Last observed` successful complete poll and saved poll error when present.
PRs at or below the permanent tracking boundary are not stored individually and
cannot appear in the listing. `No tracked ongoing PRs.` describes an initialized
repository with no saved open PRs above the boundary; `Not initialized.` describes
a missing database, an unregistered repository or an incomplete initialization.
The listing makes no claim about GitHub changes since the saved observation.

Review states are `Preparing`, `Running`, `Pending`, `Retry waiting`, `Completed`,
`Failed`, `Interrupted` and `Paused` for Draft PRs. `Running` is a saved state,
not proof that a process remains alive. Retry deadlines and saved errors appear
under the corresponding row. A newer desired revision remains `Pending` while an
older revision is active; the older revision's recorded state, attempt budget,
retry deadline and error are printed separately. The current row's attempt count
always belongs to its own desired revision, head and target branch. A base-tip
change alone does not invalidate a completed review.

Pending worktree cleanup is a separate saved resource barrier, including after a
PR reopens. Such rows show `Worktree cleanup: Pending` and any saved cleanup error.
With no current review, an open non-Draft row shows `Pending (cleanup blocked)`;
Draft remains `Paused`. Older active reviews retain their separate details. The
listing reports the barrier without attempting cleanup or recovery.

The command loads the current configuration and reads a consistent SQLite
snapshot. A current-format database is opened read-only without an instance lock
or additional migration write permission. If the existing database needs an
upgrade, the command closes that read connection, obtains a maintenance permit,
upgrades through a short writable connection, then reopens and checks the current
read-only snapshot before querying. Any existing instance lock blocks this pure
maintenance operation, including a dead or uncertain owner; it is retained.

Listing needs no Git, GitHub CLI or Copilot execution, clone or review startup.
It does not create an absent database, recover interrupted work or change review
business state. SQLite may create or update its WAL coordination sidecar files
while reading an existing database. Missing or invalid configuration, unreadable
or corrupt state, uninitialized existing files, unsupported versions and real
upgrade blockers fail visibly. The
[listing decision](../../.agents/notes/archived/feature/2026-10-18-review-status-listing.md)
records status attribution and snapshot limits.

## Durable review state

The command and source layout preserve existing YAML fields, retained-state
locations and resource identities. Runtime opening explicitly migrates earlier
SQLite state to retain verified review publications and conversation follow-ups;
existing cutoffs, revision budgets, sessions, process evidence and worktrees remain
owned by their original records. Listing automatically migrates a supported older
format before reading, while current version 2 remains read-only. The review
module owns its domain types independently of its SQLite implementation.

The SQLite module keeps repository identity, the permanent startup PR boundary,
observed PRs, captured review targets, completion revisions, sessions, worktree
registration, retry state, and verified GitHub review/thread identities. Repository
identity includes the GitHub host and stable repository ID. Completing a captured
revision leaves later observations pending; retries retain their original review
identity and consumed budget. Each successful comment result arms one durable
follow-up that is consumed once when conversations are resolved, even at the same
commit. A verified approval settles its current target; description edits retain
that approval. Reusing a stored approval to settle a pending target requires a
fresh snapshot confirming that exact remote review is still `APPROVED`, with the
captured actor, commit and stable identity. A dismissed historical review cannot
suppress that pending work.

Runtime database opening applies the database's independent 1→2 migration and
enables WAL with FULL synchronization and a bounded busy timeout. Listing uses
the same format definition, upgrades version 1 when permitted and reads current
version 2 in one consistent snapshot. Query migration never takes over a retained
instance lock. The ordinary runtime instance lock checks whether its recorded CLI
owner still exists; that check does not establish whether its agents
or tools have stopped. Interrupted reviews and pending cleanup remain blocked
after automatic lock recovery until process exclusion is explicitly confirmed.
Database state does not replace physical Git/worktree or session-history
verification.

Each store's baseline and SQL conversions ship as `.sql` resources with the
installed dist tree. Top-level SQL files in that store's directory run in lexical
filename order: the first is its baseline, and consecutive numeric prefixes set
later versions. Five baselines and six upgrades form the current SQL inventory.
TypeScript keeps JSON conversion, ownership checks and the atomic version-0 reset;
ordinary non-SQL subdirectories do not enter the normal chain. Resource loading and
sequence validation finish before user-database access; package checks compare
source and installed resources. The shared
[SQLite migration design](../../docs/design/cli-sqlite-migrations.md) explains
per-store resources, versions, connection lifecycle and failure handling. See the
[review architecture](../../docs/design/daynight-review.md) for transitions and the
[state decision](../../.agents/notes/archived/architecture/2026-10-17-durable-review-state.md)
for persistence choices. The coordinator opens this state before scheduling work
and advances only the revision captured by each completed attempt.

## GitHub observations

The GitHub module reads one repository pass through authenticated `gh api` GET
requests. Initialization scans every page and PR state before committing the
permanent cutoff. Later passes track open PRs, including Draft, and confirm
missing tracked PRs individually before recording closure.

Failed pages, malformed responses, and failed closure confirmations preserve
the previous repository observation. A completed pass commits its observations
and success time atomically. Rate-limit failures expose the server's retry
deadline and block later same-host calls in that client; the coordinator schedules
the next pass after the applicable deadline.
The [observation decision](../../.agents/notes/archived/architecture/2026-10-17-github-observation.md)
records pagination and failure handling.

CI admission uses a read-only GraphQL query for the current PR head and
available test-merge commit. It combines GitHub's check/status rollups with
registered workflow suites, including approval-blocked workflows without jobs.
All reported CI must finish successfully; GitHub's `success`, `skipped` and
`neutral` outcomes pass. No CI allows immediate review. API errors and partial
results keep the PR waiting. Latest workflow runs replace historical attempts;
waiting or failing workflows do not consume review capacity.

Fresh review also requires a complete, paginated review snapshot with no unresolved
native `PullRequestReviewThread` from any author. Outdated threads still block
until resolved. Threads proven to belong to unpublished `PENDING` reviews are
excluded from this author-facing gate; unknown ownership cannot imply resolution.
Review summaries and ordinary PR comments have no resolution state. A pending round and no active or uncertain execution are also required, so
repeated passing-CI/zero-thread observations do not repeatedly review a settled
target. CI and conversation waiting consume no review Worker or model attempt.
API failure or incomplete data cannot prove that no conversations remain.

## Repository clones and worktrees

The Git module creates missing clones and validates existing repository identity.
Prepared GitHub CLI authentication supplies command-scoped HTTPS credentials,
including repositories configured with SSH addresses or API ports. Existing
checkout files, origin configuration, branches, remote-tracking refs, and
FETCH_HEAD remain untouched by review preparation.

Configured clones and their PR worktrees are dedicated to this system. Each PR
uses its fixed repository-local `.worktrees/pr-<number>/` directory. Physical
root/common-directory checks, validated linked administration and backpointers,
and a session-labelled Git lock establish the target before destructive reuse
or removal. Initial preparation and new revisions provide a complete checkout
even when the base checkout uses sparse settings. Confirmation retries retain
local context. Files, nested clones and administration inside the owned PR
worktree are disposable; cleanup does not inventory their external consumers.
Other PR worktrees and retained sessions remain separate. Cleanup rechecks remote
closure before removal. The [exclusive-environment decision](../../.agents/notes/archived/architecture/2026-10-17-exclusive-review-environment.md)
records the choice of this ownership boundary.

The [review architecture](../../docs/design/daynight-review.md#worktree-生命周期)
defines target validation and recovery boundaries; the
[worktree ownership decision](../../.agents/notes/archived/architecture/2026-10-17-owned-review-worktrees.md)
records their rationale.

## Copilot execution

The review module ships `daynight-review` under its own `skills/` directory.
After taking the instance lock, the daemon captures the installed bundle once
and prepares an immutable content-addressed snapshot under
`~/.daynight/cache/review-skills/`. Package updates cannot replace the content
used by that running daemon. Snapshots remain available for retained sessions
and uncertain executions; automatic collection is not provided.

Each attempt first runs native Copilot skill discovery in the prepared PR
worktree. A single `--plugin-dir=<snapshot root>` argument supplies a generated
local plugin wrapper containing `plugin.json` and `skills/daynight-review/`.
This preserves paths containing commas, spaces and Unicode; inherited
`COPILOT_SKILLS_DIRS` variables are removed from the child environment.
Exactly one enabled `daynight-review` must resolve to that snapshot's directory;
a disabled skill, project override or malformed response fails the attempt.
The review prompt explicitly invokes the skill and identifies its current
absolute entrypoint and digest on both new sessions and resume. The bundled
skill owns review methodology; the prompt owns the immutable target, publication
eligibility, retry reconciliation and completion protocol. The prompt also
explicitly requests the skill's native subagent delegation and synthesis when
fresh review is required; confirming a valid matching submitted result retains
its reconciliation exception.

The Copilot adapter then launches the review child in that same worktree and
environment. It selects the persisted per-PR UUID on first launch and explicitly resumes that
same session thereafter. An interrupted first launch also resumes existing
history; missing established history is an error. Only opaque session-directory
presence is inspected. Copilot history and agent JSONL are not parsed.

Every review child receives configured `copilotModel` as separate `--model` and
value arguments, and configured `copilotReasoningEffort` as separate
`--reasoning-effort` and value arguments. New sessions, resumes, retries and later
PR revisions use the same construction. Skill discovery receives neither override.
Values pass through the existing `shell: false` execution path; unsupported or
unavailable models, effort levels or combinations retain Copilot's normal failure
result and the existing attempt/error handling. The
[model options decision](../../.agents/notes/implemented/feature/2026-10-22-review-copilot-model.md)
records the validation and default-selection choices.

Prompts travel through stdin in noninteractive mode. `cross-spawn` handles native
commands and Windows command shims; prompt text is not embedded in shell code or
command arguments. Runtime paths contain Copilot state, cache, temporary files
and per-attempt diagnostics. Existing GitHub CLI authentication remains available
through Copilot's supported fallback. Discovery and review are sequential phases
of one persisted attempt, sharing one retry budget and timeout deadline. The
discovery child must be excluded before its exact persisted PID and identity are
cleared and a review child can start. Cancellation, timeout or uncertain process
exclusion prevents that next launch. Discovery stdout and stderr stream to
separate `skill-list` logs and never enter completion-marker parsing.

The agent reads the current PR title, description and linked scope requirements,
then checks the complete captured diff against one concrete problem and outcome.
A clear description and changes within the original scope are independent
approval gates. Independent objectives, an unreviewable combined PR or unrelated
changes block approval even without a Critical/Major code defect. Necessary
implementation, structural changes, tests and documentation for the same outcome
remain in scope; fixed line or file counts do not decide reviewability. Expanding
the description alone cannot justify unrelated work.

For every fresh review, the main agent first inspects that complete fixed diff,
then chooses at least two complementary perspectives based on the PR's actual
changes, contracts and risks. It invokes independent subagents, preferably in
parallel, with exact head/base/merge-base context, scope, applicable repository
instructions, evidence standards and shared worktree, temporary-file and process
rules. Source and Git state remain read-only; subagents return findings and
coverage limits to the main agent without publishing or emitting completion
markers. The main agent waits for all required perspectives, verifies candidates,
resolves disagreements and deduplicates root causes. It records the perspective
rationale, completed coverage, limits, fix/defer/reject dispositions and confirmed
blockers in attempt output, while GitHub comments contain concise findings only.
An unavailable tool, failed child or incomplete required perspective is an
operational failure; retries or reassignment stay within the attempt's existing
budget. An incomplete review publishes neither a result nor a completion marker.

These subagents belong to one attempt within the daemon-managed main review
session; they do not create more review Workers, PR sessions or worktrees.
Reconciliation of a valid matching submitted result confirms that result without
repeating delegation. The selected questions must fit each PR, including
documentation-only changes.

Before new publication, the agent rereads the current PR information and
reevaluates those gates. A successful review either approves or publishes
`COMMENT` with at least one actual resolvable review thread. Suitable code findings
use diff lines. Description and other PR-level blockers use a clearly labeled
file-level conversation on the principal changed file; a review summary alone
cannot satisfy this requirement. `REQUEST_CHANGES` remains unused. The reviewer
must verify corrections after authors resolve feedback; resolution is a request
for rereview, not evidence that the issue was fixed. Operational failures retain
bounded retries and cannot be represented as quality findings.

The daemon verifies remote publication using its stable review identity, captured
commit and publishing actor, without interpreting the quality judgment or parsing
findings. Marker acceptance is persisted before this read-only verification; API
errors retry verification across restart without another model attempt. A complete
lookup with no valid matching publication is a protocol failure and uses the
remaining bounded model retry budget. A verified `COMMENT` records its real
review/thread IDs and arms exactly one follow-up. Once
all submitted native conversations are resolved and the current CI passes, that follow-up
runs even without new commits or metadata edits. New targets and feedback wakeups
coalesce. Same-round confirmation can proceed through open conversations only
when exact-round remote evidence proves an approval, commented review with owned
threads, or a recoverable matching pending draft under the captured publisher. A
failed attempt alone supplies no exemption. If the authenticated reader changes,
it can confirm the captured actor's submitted result; an unpublished result or
pending draft waits for that actor without consuming model attempts. Verified
approval settles the current target, and
description edits do not revoke it or start another round.

The adapter streams separate stdout/stderr logs and accepts only normal zero
exit, complete capture and the exact final nonempty stdout line
`PR N Review Completed`. Incomplete output, timeout, cancellation and logging
errors cannot assert execution completion. A marker alone is insufficient: the
coordinator verifies the corresponding remote approval or resolvable feedback
before completing the round. It owns scheduling and final state transitions;
runtime process supervision supplies evidence under the foreground execution
contract.

The [execution decision](../../.agents/notes/archived/architecture/2026-10-17-copilot-session-execution.md)
records process and publication boundaries; the
[PR-quality decision](../../.agents/notes/archived/process/2026-10-21-review-pr-quality-gates.md)
records the approval policy, and the
[multi-perspective decision](../../.agents/notes/implemented/process/2026-10-22-pr-specific-review-perspectives.md)
records delegation and synthesis. The
[conversation-cycle decision](../../.agents/notes/archived/architecture/2026-10-21-review-conversation-cycle.md)
records durable follow-ups and publication verification. The
[skill design](../../docs/design/daynight-review-skill.md) owns packaging, snapshots and
loading, with rationale in the
[bundled-skill decision](../../.agents/notes/archived/architecture/2026-10-20-bundled-review-skill.md).
Native probes with Copilot CLI 1.0.100 verify actual bundled-skill activation and
changed-bundle resume with the same UUID, including comma, space and Unicode
paths. The bundled-skill decision records the probe's conditions and limits.
Live Copilot/GitHub publication acceptance
remains separate from those probes and controlled subprocess tests.

## Coordination and shutdown

A FIFO pending queue coalesces observations for each PR while preventing a
frequently updated PR from starving other repositories or PRs. One reservation
spans preparation, execution and cleanup for each PR. Fresh-round CI and
conversation admission precedes that reservation and is refreshed at
`pollIntervalMs`; waiting candidates retain their queue position without blocking
ready PRs. Admission evidence is kept in memory for the exact revision, head and
base branch and is refreshed after restart. New review launches recheck PR state,
CI and conversations after worktree preparation. Same-round reconciliation can
confirm proven exact-round publication while its own feedback remains open;
matching pending drafts require the captured publishing actor. An unsuccessful
attempt without publication still waits for unrelated open conversations. A regression
defers fresh preparation without consuming an attempt or losing the retained
session. CI changes alone do not retrigger completed revisions.
Readiness is a launch-time observation; later CI registration or reruns do not
automatically cancel an active agent.

Cleanup does not consume a review worker slot, but cannot overlap another
operation on the same worktree. Draft/closure observations cancel active work; head changes wait for the current
attempt and remain pending. Failed revisions retain their exhausted budget.

Ctrl+C stops new work and polling, terminates current managed execution, waits
for operations and closes SQLite before releasing the instance lock. Agents must
run tools in the foreground and stop their services before returning. Normal
unforced exit and drained streams are evidence under that contract. POSIX uses
current process groups; Windows cancels live trees with `taskkill /T /F`.
Uncertain termination retains the lock and interrupted state.

Startup checks the PID in an existing `~/.daynight/instance.lock` with a
signal-zero probe. A live owner, permission denial, invalid lock metadata or an
unclassified probe error preserves the lock and stops startup. Only an explicit
no-such-process result permits automatic replacement of a dead owner's lock.
Competing starts and releases serialize through `instance.lock.sqlite`; this
guard database remains in place and must not be deleted while a CLI can use it.
Lock age never establishes that an owner has stopped. PID reuse conservatively
blocks startup until the recorded owner can be inspected.

A crash with no unresolved review or cleanup can therefore restart directly.
When interrupted reviews exist, automatic lock recovery blocks their PRs.
Pending cleanup remains recorded with its error even if the PR reopens; only
conclusively stopped cleanup operations and excluded agents allow that state to
clear. Automatic recovery blocks only each affected PR's cleanup and reuse;
polling and other PRs in the same repository continue normally, as do other
repositories. Uncertain
resources retain the lock on shutdown. After stopping the daemon, confirm that
the previous CLI and all its agents/tools have stopped, then remove only
`instance.lock` and restart. Keep `instance.lock.sqlite`, SQLite state, sessions
and logs. That explicitly confirmed restart reconciles interrupted work with
the same captured target and session; it never declares a saved running attempt
complete or kills a saved process ID.

The [coordination decision](../../.agents/notes/archived/architecture/2026-10-17-foreground-review-coordination.md)
explains scheduling and the foreground execution boundary. The
[stale-lock recovery decision](../../.agents/notes/archived/bug-fix/2026-10-18-stale-instance-lock-recovery.md)
records owner-liveness checks and the separate process-exclusion requirement.
