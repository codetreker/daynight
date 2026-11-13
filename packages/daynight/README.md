# Daynight CLI

The `@codetreker/daynight` package provides the `daynight` command and its `dn`
alias. Use it to manage server-backed projects, tasks, discussion threads,
attachments, Webhooks and Bot definitions, inspect remote Workers, install the
`using-daynight` skill for coding agents, run foreground task workers through
Herdr or browser-connected native Controllers, and run a local GitHub PR reviewer
through Copilot CLI. Both command names share configuration and behavior. Supported native platforms are Linux, Windows
and Apple Silicon (ARM64) macOS. Intel macOS is unsupported.

See the [project overview](../../README.md) for the browser workspace and service,
and the [development guide](../../docs/development.md) for source builds,
validation, package versions and npm publication. The
[CLI test isolation guide](../../docs/development.md#cli-test-isolation) describes
the private test home and parent/child protection of real Daynight state
(`~/.daynight` and the inherited `DN_CONFIG_DIR`) against writes and cleanup,
including symbolic-link aliases. Ordinary test and installed acceptance suites exclude stress
workloads. From this package, `pnpm test:stress` builds the CLI and runs the
rendering, Session-v2 archive and Controller capacity/transport `.stress.ts` suites. The command is local-only
and refuses CI. The [local stress guide](../../docs/development.md#local-stress-validation) owns
selection and evidence interpretation. Each command's `--help` owns its exact
usage. Review execution additionally requires Git, an authenticated
GitHub CLI and Copilot CLI on `PATH`.

- [Install and update](#install-and-update)
- [Configuration root](#configuration-root)
- [Client commands](#client-commands)
- [CLI usage manual](#cli-usage-manual)
- [Agent skill installation](#agent-skill-installation)
- [Shell completion](#shell-completion)
- [Configuration setup](#configuration-setup)
- [Project management](#project-management)
- [Project tag catalog](#project-tag-catalog)
- [Task management](#task-management)
- [Task deletion](#task-deletion)
- [Task discussion threads](#task-discussion-threads)
- [Task attachments](#task-attachments)
- [Webhook management](#webhook-management)
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
daynight --skill                    # Print the CLI usage manual
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
daynight worker resources list       # Inspect retained Herdr recordings and stop evidence
daynight worker retry <task-id> --claim-id <claim-id> [--project <project-id>]
daynight worker release <task-id> --claim-id <claim-id> --if-version <version> [--project <project-id>]
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
daynight project create <name> [--repo <repo>] [--team <uuid|personal>] [--confirm]
daynight project list [--json]
daynight project show <project-id> [--json]
daynight project transfer --to-team <uuid|same-service-link> [--project <uuid>] [--if-version <version>] [--confirm] [--json]
daynight project delete [--project <uuid>] [--confirm] [--json]
daynight tag list [--query <query>] [--limit <1-100>] [--cursor <cursor>] [--project <project-id>] [--json]
daynight tag show <tag-id> [--project <project-id>] [--json]
daynight tag create <name> [--project <project-id>] [--json]
daynight tag rename <tag-id> <name> [--if-version <version>] [--project <project-id>] [--json]
daynight tag delete <tag-id> [--if-version <version>] [--confirm] [--project <project-id>] [--json]
daynight team list [--json]
daynight team show [--team <uuid|personal>] [--json]
daynight team create <name> [--confirm] [--json]
daynight team rename <name> [--team <uuid|personal>] [--if-version <version>] [--confirm] [--json]
daynight team delete [--team <uuid|personal>] [--if-version <version>] [--confirm] [--json]
daynight team invitation create [--team <uuid|personal>] [--confirm] [--json]
daynight team invitation list [--team <uuid|personal>] [--json]
daynight team invitation revoke <invite-id> [--team <uuid|personal>] [--confirm] [--json]
daynight team member list [--team <uuid|personal>] [--json]
daynight team member set-role <user-id> <member|admin> [--team <uuid|personal>] [--if-version <version>] [--confirm] [--json]
daynight team member remove <user-id> [--team <uuid|personal>] [--if-version <version>] [--confirm] [--json]
daynight team leave [--team <uuid|personal>] [--if-version <version>] [--confirm] [--json]
daynight team projects [--team <uuid|personal>] [--json]
daynight team default show [--json]
daynight team default set <uuid|personal> [--confirm] [--json]
daynight invitation inspect [--stdin] [--json]
daynight invitation accept [--stdin] [--confirm] [--json]
daynight webhook                         # Show Webhook help
daynight webhook catalog [--json]
daynight webhook list --personal [--json]
daynight webhook show <endpoint-id> --team <team-id> [--json]
daynight webhook create --personal --file <path> --confirm [--json]
daynight webhook subscription --help
daynight webhook secret --help
daynight webhook delivery --help
daynight webhook attempt --help
daynight webhook operation --help
daynight bot list [--json]
daynight bot show <bot-id> [--json]
daynight bot create --name <name> [--worker <worker-id>] [--cwd <path>] [--agent <codex|claude|copilot>] [--request-id <uuid>] [--json]
daynight bot delete <bot-id> --if-version <version> [--request-id <uuid>] [--json]
daynight task
daynight task create --title <title> [options]
daynight task list [--all | --status <status>] [--ready] [--assigned-to <assignee>] [--tag <tag-id> ...] [--tag-match <all|any>] [--untagged] [--json] [--project <project-id>]
daynight task list --status in_progress --group-by chain [--assigned-to <uuid|me>] [--limit <1-50>] [--cursor <cursor> | --group-id <group-id> --targets-cursor <cursor>] [--json] [--project <project-id>]
daynight task search <expression> [--status <status>] [--assigned-to <assignee>] [--ready] [--allow-agents <true|false>] [--compatible-platform <platform>] [--tag <tag-id> ...] [--tag-match <all|any>] [--untagged] [--json] [--project <project-id>]
daynight task ready [--limit <N>] [--tag <tag-id> ...] [--tag-match <all|any>] [--untagged] [--json] [--project <project-id>]
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
daynight task tag add <task-id> <tag-id> [--if-version <version>] [--project <project-id>]
daynight task tag remove <task-id> <tag-id> [--if-version <version>] [--project <project-id>]
daynight task set-status <task-id> <status> [--claim-id <claim-id>] [--if-version <version>] [--force] [--project <project-id>]
daynight task delete <task-id> [--remove-depends] [--if-version <version>] [--force] [--project <project-id>]
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
exit with status 1 and retain their cause. Task reads with partial Session
observations print the available result and exit with status 3. Explicit Session
read commands exit 130 on user signal cancellation. The old `--daemon-review` and root
`add-repo` forms are invalid. The
[client design](../../docs/design/daynight.md) owns command composition and lazy loading;
the [composition decision](../../.agents/notes/archived/architecture/2026-10-20-client-command-composition.md)
records module ownership and the preserved data layout.

## CLI usage manual

```bash
daynight --skill
dn --skill
```

`--skill` prints the complete standalone English CLI usage manual from the
current package. The build generates it from the same topic sources installed
with `using-daynight`, in a fixed order with topic and section links converted
to internal anchors. It covers connection and Projects, Tasks, Steps, materials,
write safety, Session reads and messages, Webhooks and Worker operations. Exact
arguments remain in each subcommand's help.
The materials topic defines Goal-owned shared specifications, architecture,
breakdowns, conclusions and overall progress, alongside each child Task's own
results and evidence. The output preserves the generated
artifact's bytes, including YAML frontmatter and the final newline. The document
has no package-relative references to read separately and requires no installed
skill or individual topic files.

The option must be the sole argument. Extra arguments or another option exit
with status 2 and empty stdout before the manual is read. A missing file, read
failure, blank content or invalid UTF-8 exits with status 1 and retains its cause. Reading and
validation complete before output; an output failure can leave partial stdout.
The command requires no login, Git repository, configuration, launcher or
interactive terminal, and creates no files.

The topic files are the only edited product-manual source; there is no separately
maintained aggregate. Repository workflow and Worker execution constraints remain
separate from this manual.

## Agent skill installation

The public skill contains a short navigation entry and independently readable
topic files. The entry directs an Agent to the files needed for its requested
operation; writes also require the common write-safety rules and the target
resource's conditions and recovery rules. `daynight --skill` exposes the complete
generated manual offline. Installation validates every required topic and its
internal file and section links before replacing a target. Whole-directory
replacement removes obsolete references as well as local edits.

The Worker supplies its execution constraints and original assignment in its
prompt; each repository's rules and actual authorization govern delivery.

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
[`config.example.yml`](config.example.yml) covers service access, Team defaults, review and worker
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
[device-login decision](../../.agents/notes/archived/architecture/2026-10-25-cli-device-login.md) records the rationale for the default service, explicit login/logout and credential lifecycle. The
[top-level setup removal decision](../../.agents/notes/archived/simplification/2026-10-25-remove-top-level-setup.md)
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
daynight project create "Example" --repo https://github.com/OWNER/REPO.git --team personal --confirm
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

Creation first scans every accessible project page and compares canonical repository
identities. With one match it reports `Project already exists.` and the existing
project, without resolving a Team, confirming or writing. Multiple matches fail
with their IDs. With no match, `--team <uuid|personal>` selects the target; without
it, the CLI uses the configured default for the current service and account, or
Personal when no default is configured. An invalid or inaccessible default fails
without falling back. The target must be accessible to the current user.

Creation requires confirmation: `--confirm` skips the interactive prompt, and a
noninteractive invocation without it fails before writing. The CLI binds the
request and response to the current user and submits the original name and
repository address. The creator receives a direct admin grant. An unknown write is
not automatically replayed. Lookup failures and exhausted command budgets stop
before creation.
This client preflight does not provide atomic uniqueness against concurrent
creators, and the service continues to allow duplicate repository registrations.
Project commands do not write repository bindings or ignore rules. Lists traverse
all pages. Human output uses complete labeled project blocks with visible
terminal-control escapes. JSON preserves resource fields and nanosecond timestamp
strings; a later-page failure produces an error with empty stdout. The
[project/task requirements](../../docs/spec/daynight-project-task.md) own the complete
behavior and remaining task-command scope.

`project transfer` moves a Project to a Team identified by UUID or a same-service
`/teams/<uuid>` link. It resolves the explicit Project or current repository
without changing its binding or default Team. Only the current owner Team admin
can transfer; destination membership is not required. The preview identifies the
source, destination and expected access before confirmation. `--confirm` skips
the prompt but retains the preview's exact versions and identity checks. An
optional `--if-version` rejects a preview with a different ownership version.
A successful receipt may report no remaining access. Conflicts require a fresh
preview and decision; a lost receipt remains unknown even if a later read is 404.
Project grants and invitations are preserved.

`project delete` selects an explicit Project or the current repository's Project,
then reads the complete deletion preview. Only an administrator of the current
owner Team can delete it. The Project becomes unavailable without a product
recovery option; server history and files are retained. Active Worker claims
block deletion. Interactive use requires the displayed JSON string literal of the
Project name, even with `--confirm`; noninteractive use requires `--confirm`.
The preview is an observation, not a condition on the deletion. JSON output
contains only the confirmed receipt; preview text goes to stderr. An unknown
outcome is never automatically retried, and a later 404 cannot prove success.

## Project tag catalog

`tag` manages the selected Project's catalog using stable Tag UUIDs. Select a
Project with `--project`, or resolve it from the current Git repository as for
Task commands. `list` traverses all pages with the same query and limit; JSON
returns the collected items and catalog epoch. An empty catalog and an empty
query result are distinct in text output. An empty result starting from a cursor
only describes the remaining pages. A failed page produces an error without
publishing a partial list.

`show`, `create` and `rename` return the complete Tag, including its version and
visible Task and Goal usage. Rename uses the supplied `--if-version` exactly; if
omitted, the CLI reads the current version before submitting. Versions are
positive decimal int64 values and retain every digit. Name validation and project
access are enforced by the service.

`delete` reads the Tag's name, version and visible usage before confirmation.
Interactive deletion requires the displayed JSON string literal of the name,
even with `--confirm`; noninteractive deletion requires `--confirm`. The counts
are a preview: confirmation covers all associations at deletion, including any
added after the preview. An explicit `--if-version` is preserved; otherwise the
preview version is used. Cancellation sends no DELETE. Successful JSON output is
the service's deletion receipt. Refusals and unknown outcomes are reported; a
mutation with an unknown result is never automatically replayed.

## Team context

`team list` reads all Teams joined by the current account. `team show` and
`team projects` use `--team <uuid|personal>` when supplied; otherwise they use
the configured `teamDefaults` entry for the normalized service origin and current
account, or the account's Personal Team when that entry is absent. `team default
show` verifies and displays the resolved target. An invalid or inaccessible
configured target fails explicitly; `team list` and an explicit `--team` remain
available. These read commands do not change configuration or remote resources.
Lists finish and validate every page before producing output. Use `--json` for
complete resources. Project discovery and `project list` still use all accessible
projects, independently of this default.

`team default set <uuid|personal>` validates the target and current membership,
then saves it for the current service and account. It does not depend on the old
default, so it can repair an invalid or inaccessible selection. `personal` saves
the account's actual Personal Team UUID. Without `--confirm`, an interactive
confirmation shows the target and role; non-interactive calls fail before writing.
Cancellation or an identity mismatch leaves the configuration unchanged. The
command does not alter remote preferences or repository bindings.

The saved map uses canonical UUIDs and the normalized service origin as keys:

```yaml
teamDefaults:
  https://daynight.cc:
    80be22c3-96d8-4ed1-bcd3-b820f2508c62: b95baeff-1522-4d99-a9b4-dfcb58392eca
```

`team default show --json` and `team default set --json` return `configured`
(the saved ID, or `null` for an absent entry on show) and the verified `team`
resource. A token rotation for the same account retains its selection; other
accounts and services have independent entries. The write preserves comments,
unknown fields and other entries. It refuses to overwrite a changed credential
or current entry, or to change unrelated settings through YAML aliases. Resolve
the conflict or separate the aliases before retrying. When a local replacement
result is uncertain, the command reads the current entry and does not replay the
write automatically.

`team create` creates an ordinary Team, `team rename` changes its name, and
`team delete` removes an empty ordinary Team. Names preserve their original
characters and whitespace and may be duplicated. Rename and delete resolve the
explicit or default Team and use an observed version; `--if-version` retains the
specified positive int64 version, rejecting a mismatch with the observed version
before submission. Personal Teams cannot be renamed or deleted.

Each write requires interactive confirmation or the boolean `--confirm` flag.
Without it, non-interactive calls fail before writing. Delete prompts for the
displayed JSON string literal and compares its decoded value exactly with the
raw Team name; create and rename accept `y` or `yes` case-insensitively.
Cancellation, refusal or a mismatch does not submit. Even with
`--confirm`, delete sends the real name and version; the service still checks
identity, authority and preconditions. Success uses the validated receipt;
conflicts require a fresh decision, and unknown outcomes are never replayed.
Reading current facts does not recover a lost receipt. A later output or cleanup
failure retains a confirmed receipt. Use `--json` for the confirmed resource or
deletion receipt.

`team invitation create` creates a single-use link for an ordinary Team. The
link is disclosed once on stdout; save it securely before sharing it. Listing
invitations returns metadata only and cannot recover the link. `revoke` disables
an invitation; an unchanged receipt can also mean it was already revoked,
consumed, or absent. Create
and revoke require confirmation or `--confirm`, and use the explicit or default
Team context. Personal Teams cannot have invitations. An unknown create result
does not cause a replacement invitation to be created automatically.
`team member list` reads the selected Team's complete member directory, including
nullable profile fields, roles and membership versions. `team member set-role`
changes an existing member's role; `team member remove` removes one, and `team
leave` removes the current user. Only a Team admin can manage other members or
change roles; any member can leave. Personal membership is immutable and an
ordinary Team must retain an admin. These operations do not change Project grants
or the configured default Team.

Membership writes use the target member's observed positive int64 membership
version, not the Team or Project grant version. Supply its exact digits with
`--if-version` to retain an earlier decision; a mismatch with the current
observation is rejected before submission. Writes require interactive confirmation
or `--confirm`, and bind the current user to the request and response. A validated
receipt reports the actor's remaining Team role, including `null` after leaving;
a successful self-exit uses that receipt without a follow-up Team read. Unknown
outcomes are not automatically replayed. A later read only establishes current
facts and cannot recover a lost receipt.

## Accept an invitation

Use `invitation inspect` to preview a Project or Team invitation without
consuming it. Use `invitation accept` to accept for the currently signed-in
account; neither command resolves the configured default Team. Supply the
same-service invitation link through the hidden terminal prompt, or through
standard input with `--stdin`. Standard input is read to EOF, accepts up to
4096 bytes and may end in one LF or CRLF. Do not put links or tokens in
arguments, flags, shell history, or logs. The CLI does not persist the secret.
The link fragment is sent only in the request body.

Acceptance displays the target and current account for confirmation. A
non-interactive acceptance requires `--confirm`; without confirmation it does
not write. An existing direct Project grant or Team membership retains its
role and does not consume the invitation. Inherited-only Project access does
not replace a direct grant: accepting creates a direct member grant. Invalid,
expired, revoked, consumed or deleted-target invitations are unavailable.

Identity mismatch is a refusal. A lost or malformed acceptance response may
follow a commit and is reported as an unknown outcome; the CLI does not replay
it automatically. Reading current membership cannot recover the original
receipt. Use `--json` for the validated preview or acceptance receipt.

## Webhook management

`webhook` manages event types, endpoints, subscriptions, signing secrets,
delivery history, payloads, redelivery and operation receipts through the
authenticated service. Run `daynight webhook --help` and each leaf's `--help`
for the complete command and option list. The `dn` alias has the same commands.

Every leaf except `catalog` requires exactly one explicit owner: `--personal`
selects the authenticated User, and `--team <team-id>` selects a Team UUID.
The current Git directory and default Team do not select an owner; `--team personal`
is not accepted. The CLI verifies the authenticated user once and
checks the response identity throughout the command. IDs are canonical UUIDs;
versions and generations are positive decimal int64 values, preserved exactly.

```bash
daynight webhook catalog --json
daynight webhook list --personal --json
daynight webhook create --personal --file ./endpoint.json --confirm --json
daynight webhook update <endpoint-id> --team <team-id> --if-version <version> --file ./patch.json --confirm --json
daynight webhook subscription reconfirm <endpoint-id> --personal --if-version <version> --project <project-id> --confirm
daynight webhook secret show <endpoint-id> --personal --reveal
daynight webhook delivery list <endpoint-id> --personal --limit 50 --json
daynight webhook delivery payload <endpoint-id> <delivery-id> --personal --output ./payload.json
daynight webhook delivery redeliver <endpoint-id> <delivery-id> --personal --if-version <version> --if-generation <generation> --confirm --json
daynight webhook operation show <operation-id> --personal --json
```

Create, update and subscription replacement take exactly one of `--file` or
`--stdin`. Inputs are strict UTF-8 JSON with no duplicate or unknown keys,
at most 32 levels and 256 KiB; the final request including control fields is
also limited to 256 KiB. Files must be regular files. Supply URL and adapter
configuration in the JSON, not command arguments. Update is a nonempty partial
object; subscription replacement is a complete array. Reconfirmation accepts
one or more distinct `--project` values. All writes except create require the
observed `--if-version`; redelivery also requires `--if-generation`. No write
implicitly reads the latest version or retries a conflict. Noninteractive and
stdin writes require `--confirm`; an interactive confirmation contains only
the owner, operation, opaque targets and versions.

Writes preserve an operation ID and original issued time. Supply both
`--operation-id` and `--issued-at`, or let the CLI generate both after
confirmation. `--operation-out <path>` exclusively creates a private prepared
record before sending; it contains the scope, versions and request hash, but no
body, URL, credentials or secret. Private prepared-file creation is unavailable
on Windows and fails before sending. An unknown result retains the original
identity and is never automatically replayed. Inspect the original receipt with
`operation show`; current resource values or a missing receipt do not establish
the original outcome. To resume, use `--resume-operation <path>` on the original
write command and supply the same owner, targets, versions, mode and input. It
verifies the record and exact request hash before reading the receipt. A matching
receipt confirms the original operation without another write. The CLI rejects a
receipt whose expiry is at or before the local clock. The service also enforces
expiry with its database clock: expired receipt reads return `404 not_found`,
and matching retained expired replays return `410 operation_expired`. Rotation
receipts retain their original `keyId` and nullable `overlapUntil` even after
later rotations or endpoint deletion. A missing receipt
permits at most one identical submission only with `--confirm`, complete original
input and an issued time within the service's admission window (five minutes
past and sixty seconds future). An inaccessible receipt or expired window leaves
the outcome unknown. A prepared record alone cannot reconstruct the body.

Endpoint list validates every page before producing a complete result; delivery
and attempt lists return one page, defaulting to 50 items, with `--limit` from 1
to 100 and an explicit `--cursor` for continuation. History can be incomplete
because of retention. Secret show reports metadata unless `--reveal` is explicitly
requested; rotation does not reveal the new secret. A successful redelivery only
registers it and does not mean delivery has completed.

Payload output defaults to the exact original bytes without an added newline.
`--json` returns its validated Base64 wrapper; `--output <path>` writes a private
file after validation and never overwrites an existing target. File publication
requires Linux with procfs and glibc; it fails when inode-bound publication is unavailable.
These two options are mutually exclusive. Payload access and retention are independently enforced
by the service. Normal JSON output is one value followed by LF. Runtime errors
with `--json` go to stderr and distinguish invocation from original operation
outcomes; a confirmed write remains confirmed if local output fails. Exit status
is 0 for success, 2 for usage errors and 1 for runtime failures or unknown results.

## Task management

`daynight task search <expression>` searches Task IDs, complete titles and Markdown
descriptions in one project, including completed Tasks by default. Supply the
entire expression as one shell argument; `--` permits an expression beginning
with a dash. For example:

```bash
daynight task search 'title:缓存 AND NOT description:废弃' --status done
daynight task search -- '-worker'
```

Words and quoted phrases match literal substrings, with ASCII case folding. ID
queries match the canonical hyphenated UUID, including prefixes and middle fragments.
A positive exact full ID match ranks before a title match; fragments do not.
Uppercase `NOT`, `AND`, and `OR`, parentheses, implicit AND, and the `id:`,
`title:` and `description:` fields form expressions. Inside quotes, `\"` and `\\`
escape a quote and a backslash. `--status`, `--assigned-to`, `--ready`,
`--allow-agents`, `--compatible-platform`, `--type`, `--parent` and tag filters intersect the expression; search
does not accept `--all`. Explicit `--project` searches that project directly;
otherwise the current repository resolves the project.

Search reads and validates every page before producing output, preserving the
server's order. Text shows the full Task ID and title, type, parent, tags, status, actual
parent Goal or `none`, positive match fields, and a description snippet when present. A
negative-only match is identified as such; text escapes terminal controls.
`--json` emits one newline-terminated array whose entries contain only `id`,
`type`, `parentId`, `projectId`, `title`, `tags`, `status`, `cancelledAt`, `context`, and `match`. Both formats omit the
assignee and update time; use `task show` for complete Task details. An empty
result is `No matching tasks.` in text or `[]` in JSON. Invalid arguments and
expression syntax exit 2; read, permission, protocol, cancellation, budget and
`search_changed` failures exit 1. Errors go to stderr, and a failed search emits
no partial results on stdout. A changed search must be started again.

Task commands use the same `serverUrl` configuration as project commands:

```bash
daynight task create --title "Implement sign-in" --description '## Sign-in

Implement OAuth sign-in for the web workspace. Deliver the callback flow and
visible failure recovery; preserve the existing session and provider rules.
Complete when a valid login opens the workspace and a rejected login can retry.'
daynight task create --title "Build the sign-in page" --depends-on <design-task-id> --external-depends-on <authentication-task-id>
daynight task create --type goal --title "Improve installation" --tag <tag-id>
daynight task create --type goal --title "Unassigned Goal" --clear-assigned-to
daynight task create --title "Document prerequisites" --parent <goal-id> --status todo
daynight task ready
daynight task ready --parent <goal-id> --limit 5 --json
daynight task ready --allow-agents true --compatible-platform linux --json
daynight task ready --tag <tag-id> --limit 5 --json
daynight task list --allow-agents false --ready
daynight task list --ready
daynight task list --all --json
daynight task list --type goal --json
daynight task list --parent none --json
daynight task list --tag <tag-id> --tag <another-tag-id> --tag-match any --json
daynight task list --untagged --json
daynight task search 'title:cache' --tag <tag-id> --json
daynight task list --status in_progress --json
daynight task list --status in_progress --group-by chain --assigned-to me --json
daynight task list --ready --assigned-to me --json
daynight task list --assigned-to unassigned --json
daynight task show <task-id> --json
daynight task properties <task-id> --json
daynight task properties --schema --json
daynight task set-property <task-id> pullRequests '[{"url":"https://github.com/owner/repo/pull/123","title":"Fix synchronization"}]' --if-version <observed-version>
daynight task remove-property <task-id> pullRequests --if-version <observed-version>
daynight task update <task-id> --parent <goal-id> --if-version <version>
daynight task update <task-id> --parent none --if-version <version>
daynight task update <task-id> --description=
daynight task update <task-id> --tag <tag-id> --tag <another-tag-id> --if-version <version>
daynight task update <task-id> --clear-tags --if-version <version>
daynight task tag add <task-id> <tag-id> --if-version <version>
daynight task tag remove <task-id> <tag-id> --if-version <version>
daynight task update <task-id> --allow-agents true --if-version <version>
daynight task create --title "Check Windows build" --required-platform windows
daynight task update <task-id> --required-platform macos --if-version <version>
daynight task update <task-id> --clear-required-platform --if-version <version>
daynight task create --title "Review installation" --assigned-to <user-uuid>
daynight task update <task-id> --assigned-to <user-uuid> --if-version <version>
daynight task update <task-id> --clear-assigned-to --if-version <version>
daynight task set-status <task-id> <status> [--claim-id <claim-id>] [--if-version <version>] [--force] [--project <project-id>]
daynight task update <task-id> --depends-on <task-a> --depends-on <task-b>
daynight task update <task-id> --clear-dependencies
daynight task graph <task-id> --json
daynight task graph <task-id> --depends-only
daynight task graph <task-id> --depends-only --json
```

Task and Goal creation accepts repeated `--tag <UUID>` and writes the selected
set atomically with the other fields; omission creates an entry without tags.
Update accepts repeated `--tag` to replace the complete set, or `--clear-tags`
to empty it. These options conflict; omitting both preserves the existing set.
IDs are normalized, deduplicated and sorted. Tags belong to the selected Project;
parent and child associations are independent.

`task tag add` and `remove` read the current set and submit its replacement with
the original Task version, even when the resulting set is unchanged. An explicit
`--if-version` must match the read and is never replaced by a newer version;
otherwise the read version is used. A conflict requires a fresh decision. If a
write times out or its outcome is unknown, read the Task to inspect its current
state; the command does not replay the write or assume rollback. Successful
receipts are checked against the submitted tag IDs.

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
nodes, compact node facts and each node's Session observation. `relation` marks
ordinary members and external context; `sessionSummary` aggregates only
in-progress ordinary members. Its observation time is independent of the graph
snapshot's `observedAt`. `--depends-only` does not request Session observations;
it uses the same tasks but prints
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

Task resources require `type` (`task` or `goal`) and a nullable `parentId`. Create,
list and search default to `task`; `--type goal` selects a Goal. List, search and
ready accept `--parent <goal-id|none>`: omission does not filter by parent, `none`
selects Tasks without a Goal, and a Goal UUID selects its direct children. Filters apply
before pagination and persist across pages. Create defaults to no parent; on update,
omission preserves the current parent. `--parent none` sends null, and a Goal UUID
sets the parent. A Goal cannot have a parent. Membership does not change Task
identity, status, assignee, materials, dependencies or their classifications.

A Goal uses `todo`, `in_progress`, `done` or `cancelled` and is never ready. Full
Goal reads include progress; its Session registration is `not_applicable`. Graph
nodes are ordinary Tasks, and dependency IDs may refer to unavailable resources
without exposing their details. Ready remains a dependency fact; it does not apply
the additional parent-state restrictions used for automatic claims.

Before creating a Goal in `done` or `cancelled`, or setting a Goal to either status, the CLI explains on stderr that child Task states are retained and future automatic claims are excluded. Before deleting a Goal, it explains that the Goal and all its Tasks become invisible, membership remains, and running Tasks stop through the existing process after a successful observation. Confirm interactively or supply `--force`; noninteractive calls without it do not submit. Status and delete read the target type and identity even with `--if-version`, and retain the caller’s exact version for the write. `--force` skips only the Goal prompt; the service still applies its business and version checks.

Ordinary Task creation defaults to `proposed`; `--status proposed|todo` explicitly
selects the initial state, so confirmed internal multi-step work can start in todo.
Goal creation defaults to `todo` and accepts `todo`, `in_progress`, `done` and
`cancelled`. Both default to the signed-in assignee; `--assigned-to <user-uuid>`
overrides it, and `--clear-assigned-to` explicitly creates an unassigned resource.
These two options conflict.
Ordinary creation uses `allowAgents=false` and unrestricted `requiredPlatform=null`
unless explicitly set. Goal execution fields are not applicable. Unset properties remain absent;
creation does not inject a PR array or worker null. `task set-status <id> <status>`
sets `proposed`, `todo`, `in_progress`, `done` or `cancelled` for ordinary Tasks. The nonterminal states and done allow direct setting without a mandatory proposed or todo stage, retaining
reopening and direct completion; ordinary Task cancellation is irreversible and does not prove
delivery. Goal-specific lifecycle effects remain subject to the service's business checks. Cancelled records and materials remain readable unless effective parent deletion hides them.
Every project member may use ordinary status setting. Active worker completion
requires the current owner and an explicit `--claim-id <claim-id>` with target
`done`; the CLI uses the existing typed completion operation. The option is
validated before configuration or network access, is rejected for other targets,
and is never inferred from a task or environment. Without it, ordinary status
setting is unchanged. Release uses its protected operation; a later execution uses ordinary claim eligibility. Status does not grant execution or delivery authority. Generic updates cannot write status; old lifecycle commands and routes
are removed without aliases. `--if-version` uses the exact reviewed int64 value;
without it, the CLI reads the target before submitting. No write retries
occur. A controller-bounded worker assignment executes its supplied claim in the
provided worktree, finishes with the explicit claim ID after delivery, and leaves
system worktree cleanup and next-task selection to its controller. Version is
checked before same-state handling: current same-state keeps
version, update time and timing unchanged; actual changes increment once.
Actual cancellation records required nullable `cancelledAt`, preserves existing
execution times and materials, and satisfies dependencies without deleting edges.
Active ownership must first be released; cancelled tasks cannot be claimed or
withdrawn back to todo.

Entering in_progress or done requires all direct prerequisites, ordinary and
external, to be done or cancelled. Reopening done requires no direct in-progress or done
dependents; cancelled dependents do not add a reopen restriction. Refusals return sorted blocking task IDs without cascading changes.
The project transaction serializes status and dependency writes and preserves
materials, assignedTo, properties/PRs, permission, both dependency sets and attachments.

Migration `014_task_status_assignment.sql` converts historical proposed rows
to todo, increments only those versions and updates their update time while
preserving every other field, including requiredPlatform and historical execution timestamps. Default,
data, CHECK and ledger change atomically. Other rows and applied migrations remain
unchanged; restart does not repeat the conversion. A subsequent migration restores proposed as a current status and the creation default without changing existing rows or historical migrations.

Task resources expose required nullable startedAt, completedAt and cancelledAt.
Cancellation preserves both execution endpoints and records its own database
time; a cancelled task never resumes execution or starts a new duration. Actual entry
into in_progress starts a new interval and clears the end; return to proposed or todo clears
both. In-progress to done preserves a nullable start and records a real end;
proposed/todo to done records only an end, leaving duration unknown. Metadata and same-state
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


The Web shared status row offers todo, in progress, done and cancelled on every
material tab. Cancelled tasks retain readable status and materials without
reopen, resume or withdraw actions. The current original-state item remains
selectable. Cancellation uses the existing confirmation with the task name,
transition, irreversibility, retained readability and dependency consequence.
Active claims mark cancellation unavailable and expose the existing release
requirement on hover or keyboard focus without submitting. Dismissing the
confirmation or pressing Escape sends no write.

Status, **Automatic execution / 自动执行** and platform confirmation share one
per-task mutation owner. Pending, stale or unknown results block conflicting
writes. Current-version same-state responses confirm no stored change; actual
cancellation requires cancelledAt and preserves both execution endpoints and
other Task fields. Confirmed changes refresh the normal graph, retaining the
cancelled node and materials. Unknown outcomes use GET-only reconciliation,
preserving errors and never attributing observed state to the uncertain request.
Closing details does not roll back a submission.

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
The [confirmed platform control decision](../../.agents/notes/archived/simplification/2026-10-24-task-platform-confirmation-control.md)
records its allocation and focus behavior.

The permission switch has confirmation in both directions, remains false by
default and is locked against actual changes while in_progress. It governs
automatic discovery; explicit task execution may use either value. Rows and graph
nodes display each task's own permission. Permission does not control worker
ownership; ordinary status setting cannot release active execution. Claim-bound done validates ownership. None of these
operations stops a remote process or replaces PR review and delivery authority.
The [status decision](../../.agents/notes/archived/architecture/2026-10-24-task-status-assignment.md)
records migration and shared-session trade-offs.

`task ready` selects up to 10 actionable tasks by
default; `--limit <N>` accepts decimal integers from 1 through 100. It makes one
task-list request with `ready=true`, the chosen limit and optional
`--allow-agents true|false` and `--compatible-platform windows|linux|macos`
filters, without fetching later pages. Compatibility includes unrestricted tasks
and tasks requiring that platform. The service applies all filters before
pagination and binds them to the cursor. The service orders results by creation time and then task ID, both
ascending. A ready task is `todo` with all direct dependencies done or cancelled. This
bounded selection supports choosing the next work without retrieving the whole
project; `task graph <task-id>` provides the selected chain and one layer of
external prerequisites. Ordinary `task list`
reads every matching page, including with `--ready`, and excludes done and cancelled by
default. `--all` includes every status; `--status <status>` selects one status,
including `done`. These two options conflict. `--ready` intersects the selected
statuses and can be combined with `--all`. List results place `in_progress`
first, then ready tasks, other todo tasks, and terminal done/cancelled; each group retains
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
[self-assigned acquisition decision](../../.agents/notes/archived/architecture/2026-11-03-worker-self-assigned-claims.md) records the rationale for the runtime rule.

Ordinary list, ready and search accept repeated `--tag <tag-id>` UUIDs. IDs are
canonicalized, deduplicated and sorted. `--tag-match all` (the default) requires
every selected tag; `--tag-match any` requires at least one. `--untagged` selects
entries with no tags and conflicts with a nonempty tag selection. With neither
selected IDs nor `--untagged`, there is no tag predicate. The service combines
the predicate with the other filters before pagination or the ready limit. Each
Task or Goal is matched on its own tags; a Goal's tags do not match its children.
Search still requires a nonempty expression and does not search tag names; use
list to filter only by tags. Invalid UUIDs or incompatible options are rejected,
and the service rejects unknown, deleted or cross-project tags as
`invalid_tag_filter`. Failures do not become empty or partial results. The same
normalized selection is sent on every page, subject to existing request and
cursor size limits; oversized inputs are rejected rather than truncated.

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

`task list --status in_progress --group-by chain` reads one work-overview page.
It defaults to `--assigned-to me`; an explicit user UUID is supported, while
`unassigned`, `--all`, readiness, permission, platform and tag filters are rejected.
Each ordinary dependency component appears once when it contains a matching
in-progress task, including when its root is done. External prerequisites do
not expand a group. Independent tasks are groups with `kind=task`.

The default page has at most 20 groups; `--limit` accepts 1 through 50.
`--cursor` continues groups. `--group-id` and `--targets-cursor` must be supplied
together, without `--cursor`, to continue one group's in-progress targets.
Each group previews at most five roots and 20 targets. Target pages remain
limited to 20 regardless of `--limit`. Group summaries cover all accessible
in-progress ordinary members, including other assignees; `matchesAssignee`,
`matchedCount`, `memberCount`, `inProgressCount` and `aggregationScope` make that
scope explicit. A group has no aggregate Session ID or send permission.

Grouped JSON is `{groups,nextCursor,observedAt,partial}`. The complete response
is bounded to 256 KiB and returns continuation cursors when more data remains.
Task graph changes invalidate a cursor with `reset_required`; restart the
group query. Session activity changes do not change pagination membership.
Each page observes activity separately, so its counts and indicators may differ
from an earlier page. Use `task graph <displayTaskId>` for complete membership.

Updates preserve omitted fields; an empty description clears it. Repeated
`--depends-on` and `--external-depends-on` declare the complete ordinary and
external sets. Either option replaces all relationships and classifications;
ordinary-only makes every supplied edge ordinary, while external-only leaves
only those external edges. IDs are canonicalized and sorted; malformed and
case-equivalent duplicate/cross-declared UUIDs fail before configuration or
network access. `--clear-dependencies` sends two empty sets and conflicts with
either dependency option. An update needs at least one mutable
field. Create/update accept `--assigned-to <user-uuid>` or `--clear-assigned-to`
to send null. Ordinary Task creation with neither option reads the signed-in
account through `/me` and submits its UUID; a failed or cancelled lookup prevents
creation. Goal creation with neither option omits `assignedTo`, and the service
defaults it to the caller. An explicit UUID or null skips the lookup. Update
omission preserves the existing assignee. Direct API ordinary Task creation may
omit `assignedTo` or send null to create an unassigned Task; Goal creation uses
explicit null for that result. The set/clear options conflict, and invalid UUIDs or combinations fail before
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
literal property/value positionals; search accepts it for an expression beginning with a dash.
Other operations retain their declared syntax.

The internal typed ApiClient accepts optional `assignedTo` and `workerId` on
TaskFilters and TaskPageQuery. Assignment selectors accept `me`, `unassigned` or
a user UUID; the worker uses `me` for new candidates across every page. With
workerId, the client requests only the authenticated user/worker active claims
and validates active state and matching worker ID in responses. `listTasks` returns
only after every page succeeds; `listTaskPage` remains partial. A workerId-only
traversal across all relevant projects provides ownership inventory; extra filters
or incomplete pages cannot authorize cleanup. These filters are not public task
CLI options.

Human task lists use labeled blocks containing ID, project, title, tags, complete
properties, status, readiness, automatic-execution permission, required platform,
assignee, dependencies, blocking and Session observations. Property rows are ordered by name and rendered as
terminal-safe JSON; missing keys are not replaced with default values.
Task and Goal text displays each own tag name on a separate line, or `Tags: none`.
Their JSON includes `tags` as an array of `{id,name}` references; `[]` means no
tags. The same references appear in details, ready results and Task receipts.
Missing or invalid references are protocol errors. Graph nodes do not include tags.
Description, version and Task timestamps
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

### Task Session observations

Ordinary `task list`, `task show` and `task graph` negotiate `include=session`
and preserve their Task data. A versioned `session` object carries registration,
platform and native Session identities, execution fence, mode, provider,
activity, connection, lifecycle, current turn, indicator and caller-specific
`send` eligibility. Generations and connection epochs are decimal strings;
absent facts remain explicit nulls. The client does not derive activity from
Task status, inspect Worker files, load message history or send input.

The indicator and ordinary-message eligibility answer different questions.
`warning` can mean an idle Session whose owner may start a turn; `working` can
allow steering. `notice` may require an approval that an ordinary message
cannot answer. Check `send.allowed`, `send.mode` and `send.reason` independently
of color and Task status. An observation does not authorize a later write.
Herdr observations describe terminal execution and do not imply Web message
support.

Use `observedAt`, `lastSeenAt` and `freshUntil` to assess freshness. Ordinary
lists retrieve all Task pages before printing, so their observations need not
describe one instant and may already be stale. Refresh with the same query.
An unavailable observation retains the Task with an explicit reason/error and
unknown send eligibility. Such partial results print to stdout, report a
diagnostic on stderr and exit 3; malformed responses, authorization and
transport failures exit 1. An old service yields `unsupported` and an upgrade
instruction, with at most one plain Task traversal after an explicit
negotiation refusal. `task ready`, `graph --depends-only`, write preflight and
mutation receipts retain their original reads and output.

### Inspect and read a Task Session

```bash
daynight task session current TASK --project PROJECT --json
daynight task session list TASK --project PROJECT --limit 20 --json
daynight task session show TASK SESSION --project PROJECT --json
daynight task session read TASK SESSION --project PROJECT --json
daynight task session read TASK SESSION --project PROJECT --before TOKEN --conversation --json
daynight task session entry TASK SESSION --project PROJECT --cursor TOKEN --json
```

`SESSION` is the Daynight platform UUID, distinct from a native Provider ID.
`current` returns the current association or explicit unregistered/not-applicable
state; it never substitutes the latest historical Session. `list` returns one
directory page with execution and archive facts, `currentBinding`, and
`nextCursor` for an explicit `--cursor` continuation. `show` uses the selected
Session's inspection, including its original fence, readable live/archive source
and independent observation and send eligibility. A changed Task claim does not
redirect a historical read.

`read` returns the latest 20 timeline entries by default, with a 1–200 limit.
Entries include tools and interactions, and are ordered oldest to newest within
each page. `--before` consumes `beforeCursor` to move toward earlier history.
`--conversation` filters only the selected page to user and assistant messages;
an empty result retains the original continuation rather than fetching older
pages to fill the limit. No command automatically follows a cursor. Timestamps
remain null where the source has none.

Message pages and entry blocks have a dedicated 256 KiB complete encoded HTTP
response limit. Oversized entries provide `body=null`, `truncated=true` and a
`contentRef` containing a cursor, SHA256 and UTF-8 byte length. `entry` reads at
most 32 KiB of canonical JSON fragment, on UTF-8 code-point boundaries. In JSON,
concatenate `fragment` values in `offset` order while the Session, source, epoch,
entry, revision, hash and length remain equal, then verify the complete length
and SHA256. Use each `nextCursor` explicitly until `eof=true`. Text output escapes
terminal controls and is unsuitable for byte reconstruction. Resource metadata
contains references only; these commands do not emit media bytes or base64.

Valid archives remain readable while the original Worker is offline. `coverage`
preserves visible gaps in original entries, resources or archives; `complete`
does not prove exhaustive native history capture. Pending/unavailable history,
corrupt archives and empty history are distinct results. Every page and block is reauthorized.
`reset_required` rejects changed epochs or live/archive sources;
`content_changed` rejects changed entry content. Discard the old continuation
and explicitly read the same Session again. The CLI never switches targets or
silently joins different versions. `contentReadVersion` reports the current live
Controller connection's complete-content support; old Controllers may read
short entries, but display-budget placeholders return `upgrade_required`.
Herdr remains `terminal_recording` and does not provide chat messages.

Complete queries exit 0. Partial observations or history pages print their data
and exit 3; definite failures, including timeouts, exit 1 and usage errors exit 2.
User signal cancellation exits 130. JSON retains the
original body or explicit content reference; text retains readable line breaks
while escaping terminal controls. Session reads do not execute message content,
start Agents, change claims or grant sending permission. The bundled
[Session inspection guide](src/commands/skill/skills/using-daynight/references/session-reads.md)
describes the Agent workflow and equivalent MCP read tools.

### Task Session messages and recovery

Send an authorized ordinary message to the selected Web Session, or query its
original operation:

```bash
daynight task session send <task-id> <session-id> --project <project-id> --text 'Please inspect the failing test.' --json
daynight task session send <task-id> <session-id> --project <project-id> --file ./message.txt --wait-seconds 0 --json
daynight task session send <task-id> <session-id> --project <project-id> --stdin --json < ./message.txt
daynight task session operation <task-id> <session-id> <operation-id> --project <project-id> --json
daynight task session operation --operation-id <operation-id> --json
```

Choose exactly one of `--text`, `--file` and `--stdin`. Files must be regular
files. Input preserves Unicode, BOM, LF/CRLF and trailing newlines. NUL,
malformed Unicode, whitespace-only text, more than 1 MiB of UTF-8 text or more
than 2 MiB of the complete command JSON fails before saving or submitting.
Slash-prefixed text stays ordinary text. The command does not answer approvals,
write Herdr terminal keys, cancel, queue, create or retarget a Session.

The first send observes the explicit Session and freezes its execution fence and
expectedTurnId. Idle uses null; working requires actual steer support and the
same current turn. Session owner, credentials, connection and execution are
checked again when accepting and dispatching. Inspection connectionEpoch remains
a connection observation, not an additional command precondition.

A private recovery record under
`DN_CONFIG_DIR/session-operations/<originHash>/<actorId>/<operationId>.json`
retains identity, intent hash and operation facts without the body or token.
Real private permissions, a cross-process lock, file synchronization, atomic
replacement and parent-directory synchronization precede POST. Any failure
refuses before sending. The record is durably marked dispatch_unknown before
the single POST; a crash before actual dispatch can therefore leave an operation
unknown that was never sent. This conservative result does not permit replay.

Every existing local record makes a repeated send verify the original target
and body hash, then query only. It never refreshes current to reconstruct the
turn. With no record, `--operation-id` is only for an explicitly chosen first
submission: an existing receipt returns query guidance without accepting the new
body. A prior unknown result or cross-machine recovery must use the explicit
operation query. not_found does not prove unsent. The short operation form uses
only the current actor and service's local record; another machine needs the
original resource IDs. Historical receipts remain queryable under current
permissions after a new claim, without restoring a queue.

Wait defaults to 30 seconds, accepts 0–60, and polls only the original operation.
accepted/offered/dispatching and unknown/not_found/wait expiry exit 3;
provider_accepted/confirmed exit 0; rejected/failed/expired or
protocol/authentication/output failures exit 1; invalid arguments exit 2; user
interruption exits 130. Pending and interrupted operations retain their original
identity in bounded output. Provider acceptance and confirmation do not mean the
Agent completed the requested work. Local receipt-save or output failure does
not undo service acceptance or authorize another POST.

The [Session intervention reference](src/commands/skill/skills/using-daynight/references/session-messages.md)
describes authorized use, unknown recovery and the corresponding MCP tools.

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
write values remain service 400 invalid_input failures. Stored properties are
read as canonical values without repeated normalization or capacity checks;
natural decoding, database and internal faults retain their causes.

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
The client Steps body safety cap is 64 MiB, inclusive, and is combined with the
configured response budget by taking the smaller bound. Server reads use pure
field projection and ordinary encoding without repeating write-candidate
capacity checks. Stricter configured limits still
win, total-operation bytes remain charged, and shared defaults do not change;
no partial resource reaches stdout before full validation and rendering. An
output failure can still leave partial stdout and is reported as a failure.
Errors go to stderr with exit status 1; argument errors use 2 and success uses 0.
A 401 includes `daynight login` guidance without automatic login or retry.
Help, Bash/zsh completion and the standalone manual expose the delivered
list/show/add/update/set-status/move/delete commands. CLI module tests own read
and write behavior; installed-package checks verify the launchers and resources.

### Add a Step

```bash
daynight task step add <task-id> --title "Coding round 2" --description "Review findings" --project <project-id>
daynight task step add <task-id> --title "Review round 2" --id 00abcdef --status todo --after <step-id> --if-version <observed-version> --json --project <project-id>
```

Add requires a raw nonblank title. Description may be empty; omitted description
and status mean empty text and todo. Before/after are mutually exclusive Task-local
anchors; omitting both appends. Input IDs normalize without losing leading zeros.
The service admits at most 1024 UTF-8 bytes for the title and 65536 for the
description; the complete encoded collection must also fit its 64 MiB limit.
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
The service applies Add's text limits to the complete target, including omitted
fields, and reports a field limit violation as a confirmed `invalid_input` refusal.

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
fully consumed displayed Id. The CLI prints every message selected by the
server count page, with direction notices taken directly from the server. There
is no Thread-specific read-byte admission or stdout prefix trimming. Shared
operation transport limits still apply, and complete bodies are never truncated. A post receipt cannot advance the read position: after reading
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
metadata JSON keeps the shared client response and aggregate transport budgets. Use `--` for a dash-prefixed
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

Open **Assistants** in the Web workspace to create a named assistant, switch
conversations, inspect its Worker/directory/Agent, or close and reopen its chat.
The shared Session View provides conversation/standard modes, full screen and
native interactions. Closing a chat or browser only closes the view.

Run `daynight worker run` with a valid service login and a supported native Agent.
It hosts assistants independently of task slots, including with no registered
repositories. The Worker's actual startup directory is the default cwd. Its
current global native configuration supplies the default Agent/model/arguments;
per-project task configuration does not configure assistants. The default cwd
must exist, and choosing a different directory never creates it automatically.
Only fresh compatible hosting reports are eligible for default selection; an
online older Worker without `assistantHost` is unsupported. Native preflight
reports tool availability, not successful future authentication or execution.

Worker execution remains foreground; keep the process and machine online. Normal
shutdown stops owned native execution and retains recovery data. Restart uses
the same Bot, Session, frozen role and native identity when verified stop evidence
permits recovery. Missing native identity or uncertain stopping remains an error,
without creating a blank replacement or resending a previous request. Bots use
Web sessions even when task execution uses Herdr, and do not consume task
`maxConcurrent` slots; their processes still consume machine resources.

The assistant receives additional native role instructions and uses the normal
Daynight CLI for queries and authorized operations. Its capabilities follow CLI
permissions, without an assistant-specific action allowlist. A query needs no
Goal; a delivery request follows the existing requirements, design, execution and
acceptance workflow. `task list`, `task show`, dependency reads and `worker
list/show` report separate status, pause, readiness and resource observations.
The Bot's directory grants no additional project access.

Bot commands use the configured server and signed-in account. They work in an
ordinary directory without Git or a Project and do not accept `--project`.

```bash
daynight bot list --json
daynight bot create --name "Planning assistant" --json
daynight bot show <bot-id> --json
daynight bot delete <bot-id> --if-version <observed-version> --json
```

`bot list` requests 100 items per page and prints results only after every page
succeeds. Its per-response limit uses the existing 256 MiB aggregate response
budget; all pages together still have that same 256 MiB limit. A later page or
budget failure produces an error without partial output. `bot show`, `bot create`
and `bot delete` retain the default 128 MiB per-response limit. Existing operation
and request deadlines continue to apply. These client transport limits are
independent of the server's item-count pagination. The foreground Worker's Bot
inventory reader separately uses its existing 64 MiB aggregate budget for both
a single response and all pages of one read operation.

Creation needs only `--name`. Optional `--worker`, `--cwd`, `--agent`, `--model` and
`--reasoning-effort` preserve explicit choices; the service resolves and freezes omitted settings. The
specified directory belongs to the target Worker, may be outside a repository,
and must be an absolute path for that machine. The CLI does not create it or
substitute the local working directory. An active response reports the actual
`startupResult`: accepting a `pending` definition does not establish a running
or ready assistant. An existing `ready` result is a startup observation, not a
promise that its Worker is currently online. Replaying the original creation
request after deletion returns the minimal deletion responsibility and its actual
cleanup stages, without recreating the definition or claiming startup.

Model and reasoning effort choices require a Worker that advertises creation
configuration version 1. Use `--worker` to bind choices made from a machine-specific preview. Without it,
the service selects and freezes the actual Worker during creation.
The service validates the selected model and effort against that Worker's native
capabilities. Unsupported explicit choices fail; stale successful preferences
fall back to valid defaults. Successful first startup remembers only explicit
fields, with separate creation-order watermarks. Existing assistants and native
session model changes do not update these defaults.

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
process termination or history removal. The service commits a deletion barrier
before cleanup, and requires the bound Worker's verified stop receipt before
server history cleanup can complete. The CLI consumes those stages; it does not
stop native processes or generate cleanup receipts. The bound Worker owns those
operations and retains failed cleanup responsibility for later reconciliation.

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

The Worker provides a [versioned assistant role and CLI environment helpers](../../docs/design/bot-role-environment.md)
for hosting consumers. Role selection preserves the server-frozen text and
revision, retains an unconfirmed local preparation, and rejects disagreements.
Environment preparation uses the target Worker's `DN_CONFIG_DIR` and normal CLI
credential, checks its server and current account, and probes the effective CLI
in the Bot's ordinary directory. It preserves native homes and existing alias
rules; Controller relay credentials are not CLI credentials. The caller owns
durable preparation, registration, startup and release of its prepared aliases.
The Worker hosting composition invokes these helpers for new and recovered
execution; native approvals remain in force. Deletion clears Daynight-managed
conversation data and private execution files after verified stopping. It never
removes the ordinary cwd, independent tasks/worktrees, shared native homes or
Provider-owned history. Webhook/MCP, automatic migration, high availability and
OS service installation are outside this feature. Existing Test Sessions remain
independent and are never imported automatically.

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

Current execution monitoring is reported separately every 30 seconds. It shows
observed scheduling, activities, capacity and bounded failure summaries. Claim failures with trusted bindings may include a project-relative worktree location or a fixed unavailable reason; unknown
or stale data does not mean the Worker is idle. Monitoring failures do not stop
heartbeats or task execution. The [monitoring contract](../../docs/spec/daynight-worker-monitoring.md)
defines its freshness, permissions and retention.

Snapshots include actual OS, logical CPU count and utilization, memory usage,
and available/total space for the filesystem containing the directory where
`worker run` started. They also include the running Daynight version, a read-only
private Herdr version observation, and observed Codex/Copilot tool versions.
An unchecked tool is not reported as installed or missing. Standalone native CLI
results are cached for at most 60 seconds with their original check time; the
composed Worker reads the tool manager snapshot without another version probe.
Reporting does not run launch preflight or repair integrations; a pure-Web worker
does not start Herdr to collect its version. Unknown task inventory and
observed idleness remain distinct, and individual probe errors remain explicit.
The [reporting requirements](../../docs/spec/daynight-worker-reporting.md) and
[design](../../docs/design/daynight-worker-reporting.md) define sampling,
bounded attempts, cancellation and sanitized diagnostics. Reporting uses the
existing service credentials and stable worker identity, with no separate
command or configuration switch. Configuration reports use a 9 MiB UTF-8 JSON
body limit; ordinary reports retain 1 MiB. Optional observations are fitted to
the selected limit without truncating required inventory or configuration. Deploy
servers and ingress that accept 9 MiB before upgrading Workers. A 413 from an
older server or ingress is a capacity or version mismatch, not confirmation.

The cloud target owns concurrency, polling and recovery limits, platform-specific
acquisition preference, control mode, Project selection, and global/per-Project
Agent, model and arguments. Repository roots, local paths, service credentials,
Worker identity, and optional
`agentModel` / `agentReasoningEffort` overrides stay local. An authenticated
configuration read or matching report receipt installs the complete current cloud
target and observation baseline, including lower counters, different content at
the same revision, or an uninitialized target. Local cached or pending targets
cannot override that authority. Each installation renews a local generation while
matching application records and jobs retain their identities. An unsupported
cloud target remains visible as authority with new admission closed until a valid
target arrives. Configuration enrollment does not depend on active claims or
alter task/claim formats, permission or recovery rules.

When the cloud target is uninitialized, including after an initialized target
becomes null, the Worker automatically prepares a candidate from one consistent
snapshot of the current local file. Its separate mode and tool adoption fields
come from that same complete candidate. Without a complete candidate, independent
capability adoption keeps the startup local choices. The running service,
credential, Worker identity and local execution
overrides remain fixed; a file that names another service or Worker is rejected.
A root-owned preparation pass has a 60-second budget, independently of a report
waiter's cancellation. Successful Project resolutions may be reused only for the
same source hash and authenticated identity; explicit candidate rejection
invalidates them, and the service still checks permissions. Later null cycles
read cloud state before joining or preparing the candidate. A competing cloud
target wins and cancels and drains the candidate. Unknown import results require
a read before a new report. Reimport establishes the current local candidate,
without promising to reconstruct the cloud target that was lost.

Startup identity reads retry temporary network failures under the original
instance lock at 5, 10, 20, 40 and capped 60-second intervals. No account-scoped
cache or execution is admitted before identity verification. A temporary initial
configuration read failure remains unread and is retried by report preparation;
authentication, protocol and format errors remain explicit failures.

My Workers → Configuration → Control mode selects `herdr` or `web`. A new local
configuration defaults to `herdr`; an existing local `web` setting is adopted
when its cloud target has not yet acquired a mode. Explicit cloud choices win
over later bootstrap candidates. Both service and CLI must support the separate
`Daynight-Worker-Control-Mode: 1` capability; older services keep local mode.
Applying a mode validates it together with global native settings and publishes
the pair only after persistence. Project native settings are revalidated for that
mode. Existing claims retain their frozen mode, native settings, sessions and
worktrees. Failed application keeps the previous effective pair and reports the
failure; saving a target alone does not confirm application.

Set `worker.agentModel` and/or `worker.agentReasoningEffort` to override only
those settings for new executions, even after enrollment. Each field independently
uses its local explicit value, then the effective cloud value (including native
arguments), then the Agent default. Remove a field and restart the Worker to
restore inheritance. Empty strings and explicit null are invalid. Legacy
`worker.model` keeps its first-import semantics; a nonempty legacy value must
agree with `agentModel` when both are present, while `model: null` permits it.

Model and effort arguments are normalized for the effective Provider and mode;
unrelated arguments keep their existing validation. These overrides do not edit
native configuration files or write local values into cloud desired state.
Telemetry reports `runtimeConfiguration` schema version 1 with each effective
model/effort value and its `local`, `cloud`, or `native` source. A null value with
`native` means Daynight leaves that setting to the Agent, not that Daynight has
observed its resolved native value. Existing claims and assistants retain their
frozen native settings; new defaults do not restart or reconfigure them.
Deploy a server that supports the optional report field before using this client;
older stored reports remain readable, but older servers reject unknown fields.

Setting either local override enables native model/effort validation for the first
launch. An unresolved Copilot default model or Codex OSS/local-provider catalog
cannot be validated and fails explicitly. Existing native sessions resume with
their preserved settings.

For a Worker that has not enrolled, optional interactive setup prepares its local
candidate:

```bash
daynight login
daynight worker setup
daynight worker run
```

A local candidate can have no Projects. Normal `worker run` authenticates and
queries cloud configuration before managed local values, repository selection,
repository preparation or business backend initialization. An existing target
bypasses stale local managed fields. Empty cloud Projects keeps the Worker
running and reporting; it does not open a picker or require `repo add`.

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
unchanged. Once a cloud target exists, local setup and managed-field writes
require changing those values in the cloud instead. Writers check enrollment
before interaction and final persistence; a missing local cache does not mean
the Worker is unenrolled.

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

Before enrollment, manage individual local Project registrations with:

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

Service credentials, local repository root, mode and the first-import candidate
come from one captured source; changed credentials require restarting the
command. Cloud lookup and reporting do not wait for Project preparation or task inventory.
Selected Projects use existing local bindings or are prepared under
`worker.repositoryRoot`; only confirmed prepared Projects can execute. A failed
preparation does not block independent healthy Projects. Removing a Project
excludes it from scheduling and stops its executions while retaining their
claims, worktrees and session history. Unconfirmed stops continue to occupy
capacity; stopped retained worktrees do not permanently occupy a slot. Project
failures are reported and retried. Persistent local mappings remain available
to ownership inventory and resource discovery independently of the selection.

`worker.repositoryRoot` defaults to `~/daynights`, independently of review's
root. New registration expands the actual home shortcut or resolves a path
relative to config.yml; existing paths are retained when the root changes.
Ordinary repositories use `<root>/<host>/<owner>/<repo>`; generic transport,
user, port and nested-path identities use distinct encoded coordinates.

Network and prompts hold no configuration lock. The final cloud ownership check
runs immediately before taking that lock; the atomic writer then rereads YAML,
preserves comments and unrelated edits, and refuses changed Worker identity,
worker root, repository selection or service credentials. Setup also protects observed global
agent/model/args values and saves those fields with the selected Projects. Repo
commands only own repositories; neither operation changes repositoryRoot. Shared aliases that would alter
unrelated effective settings are rejected; unaffected aliases remain valid.
Repository identities, Project IDs and physical paths must remain distinct,
including the Daynight state directory.

For explicit local paths and an initial runtime candidate, retain shared service
and review settings and configure worker directly. After enrollment, edit the
managed runtime fields in the cloud:

```yaml
worker:
  repositoryRoot: ~/daynights
  maxConcurrent: 1
  pollIntervalMs: 60000
  recoveryLimit: 3
  preferPlatformSpecificTasks: false
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

These are the defaults for the initial candidate. A missing file, omitted worker
mapping and `worker: {}` use the same defaults; omitted repositories is an empty
list. Worker never infers repositories from review. Reads do not create or
rewrite configuration. Unknown root, worker and repository-entry fields are
ignored during projection and preserved during configuration edits. Local fields
and an initial candidate still reject invalid known values; malformed YAML,
filesystem failures and cancellation remain errors. Existing cloud targets do
not require parsing stale managed YAML values. `model: null` clears the model;
omitted Project override fields preserve inheritance, while `args: []` clears
arguments explicitly.

`worker.toolPaths` accepts local selections for `codex`, `copilot` and `herdr`.
The parser returns a complete choice for all three tools; an omitted mapping,
omitted tool or per-tool `null` selects automatic discovery. An empty or
whitespace-only string is invalid. The mapping itself must be an object and
rejects other tool names. For example:

```yaml
worker:
  toolPaths:
    codex: /Users/example/.nvm/versions/node/v24.22.1/bin/codex
    copilot: null
    herdr: /opt/homebrew/bin/herdr
```

Cloud configuration exchanges these choices when the server negotiates tool-path
support. Web Codex/Copilot Task and Bot launches, version/host checks and model
discovery consume one verified selection; saving a target does not establish that
it is applied. Background Copilot preparation runs when the effective global or
any Project agent is Copilot, or this Worker has a non-deleted Copilot Bot
definition, including pending, failed and recoverable definitions. With no such
demand, background cycles do not resolve or probe Copilot; an existing successful
selection and inspection proof may still be read for the complete assistant-host report. Without
that proof, the Copilot entry is unavailable without an issue. Explicit Copilot
model discovery and execution continue to prepare it on demand. A tool path or
previous success alone does not create background demand.

Herdr Codex/Copilot executions freeze both the Agent and Herdr
recipes; controlled pane mappings preserve the original kind and logical argv.
macOS retains per-run instances. Linux/Windows shared instances keep new targets
pending until the original daemon, endpoints and all old process responsibilities
are confirmed closed. Explicit paths must be absolute on
the Worker platform, at most 4096 UTF-8 bytes, valid Unicode and free of control
characters. Windows paths need a drive or complete UNC share. Values retain all
spaces and punctuation: the parser does not trim, normalize, expand `~` or
environment variables, split arguments, or access the filesystem. Provide one
complete file path; native arguments remain in their existing configuration.
The shared resolver owns existence, executable format and interpreter checks.

For resolver callers, automatic Codex and Herdr selection searches the captured
Worker PATH. Automatic Copilot selects the bundled native runtime in Web context
and the captured PATH in Herdr context; explicit choices select only that entry's
installation. Node entries use the frozen Worker Node executable. npm Node shims
are mapped to their target from a bounded snapshot without executing shell text;
comments and harmless formatting changes do not require a registered template.
Official Copilot entries resolve the native package within that installation.
Codex JavaScript entries run as ordinary Node scripts; the loader selects its own
native program. Actual file, permission, launch and protocol failures remain visible.

When a cached candidate's identity changes, a new preparation or execution first
reconciles the previous probe's cleanup, then resolves and probes the current
choice within the same operation. Unconfirmed cleanup blocks the new probe. This
refresh does not replace the frozen recipe of an existing execution.

New executions freeze the complete tool recipe and its observed version before
submission. Target or PATH changes affect future executions. Recovery verifies the
original files and reports `tool_identity_changed` when a dependency is missing or
changed; it never substitutes another installation. Restore the original matching
installation to recover that recipe. Input, stop and archive operations on an
existing live process retain its original process identity. Old submitted records
without a frozen identity report `legacy_tool_identity_missing`; they cannot start
a replacement. Never-submitted legacy tickets can acquire a private, immutable
selection sidecar bound to the original ticket, without replaying initial input.

Herdr startup verifies the original shell, helper/native process tree, launch
receipt, binding and readiness before a single initial input. Startup succeeds
only after the official integration reports the original native Session to the
same pane. Missing or unknown results never permit replay or a replacement
Session. Original-claim recovery and attach keep their frozen recipes. Windows
uses system PowerShell 5 as the root shell with owned ExternalScript mappings;
PowerShell 7 is not supported by this path. See the
[Herdr tool launch design](../../docs/design/herdr-tool-launch.md).

The supported Web Copilot image-authority profile freezes its source SEA, Worker
Node, preload closure and a complete private extracted distribution. Its public
paths distinguish the selected source, actual JS entry and Node interpreter.
Unknown builds keep the ordinary runtime. A known profile's preparation failure
is an error rather than a silent fallback. Published distributions remain under
`worker/tool-runtimes` with Worker state after normal shutdown. Their 2 GiB storage
budget includes a durable 512 MiB reservation for each unresolved extraction;
capacity exhaustion refuses new materialization and retains old execution data.
Provider shutdown does not delete these durable dependencies.

Resolution starts no process and does not validate the tool's version or protocol. The
[Worker design](../../docs/design/daynight-worker.md#本地工具路径选择) describes
the launch identity and verification responsibilities.

The initial candidate resolves each repository remote and optional projectId to
an existing service Project, preserving native override intent. Use projectId
when remote discovery is ambiguous. A local binding requires a valid path when
used; selected existing bindings use the normal clone/origin checks without
resetting files or branches. A Project without a prepared binding stays pending.
Credentials belong in native authentication configuration, outside repository
URLs and argument lists.

Repository entry paths are absolute or relative to the configuration directory, never the
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
before application.

Foreground reporting and configuration-dependent management paths share one
exchange sequence: persistence readiness, authority/candidate preparation, fresh
telemetry collection, capture, generation check, one send, and durable receipt
acceptance. A changed generation discards the old sample. Normal synchronized
cycles add no configuration GET; startup, unknown results, 400/protocol failures
and capability discovery read first. Reporting keeps its 30-second single-flight
scheduler, merged triggers and finite prompt batches.

The Worker stores configuration facts in one schema 5
`worker/configuration.json`, scoped to the service origin, authenticated user and
Worker ID. Its authority contains the target, observation revision and a local
generation UUID. Current records describe the target's application and verification;
retained records preserve original work, stops, unknown outcomes, unacknowledged
failures and necessary actual values. Each record has a stable `recordId` and
immutable `origin`. Reused actual values keep their observed source; schema 4
history with a lost successful revision remains explicitly unknown.

Versions 1–4 upgrade through the strict migration owner, preserving original
values, mode, backoff, failure identity, started removals and observation facts.
Version 1 retains its platform-preference migration. Current-format missing
fields, invalid scope and corrupt data remain failures. Genuine file I/O failures
wait in the original storage scope and recover automatically; they do not
initialize an empty cache. Cache
reads and atomic writes process JSON in chunks using the pinned
`@discoveryjs/json-ext` dependency and a cache-specific syntax guard. Total file
size is not limited by one JSON string; individual tokens and retained domain
objects still consume their corresponding memory. Historical structurally valid
values are read without applying newer per-item limits.

One FIFO persistence owner merges target receives, application outcomes and
acknowledgments from the last durable state. It calculates and freezes each head
once, then retries the same encoding plan with a fresh iterator and temporary
file at 5, 10, 20, 40 and capped 60-second intervals. Only its successful atomic
commit publishes the immutable effective view. Completed apply/stop effects and
trusted receipts remain owned while persistence is unavailable; write retries
do not execute their effects again. Ordinary receive/read operations wait on
shared readiness, preventing duplicate inputs from accumulating while blocked. A cancelled or expired
Operation removes its waiter without cancelling the owned result or reclassifying
a known remote response. Closing begins manager drain before joining any reporter or initialization work
that can wait for the checkpoint. Its five-second window stops further retry
scheduling; an active read/write/rename still owns its file operation and the
Worker instance lock until it actually ends. Unsaved results fail with original
errors and record identities. Restart checks the durable started state and original
resources; an unsaved side effect is not assumed absent.

Native qualification belongs to this process and its
record identity, mode and relevant tool selections. Matching proof follows the
previous current or retained record supplying an inherited value when a target
changes, independently of that value's historical source. Proof expires with its record owner; a mode change revokes every project
proof before inheritance. Historical source references grant no qualification.
A new runtime checks the current target first; only a failed target permits validation of compatible
historical settings. Migrated version 1/2 history has no recorded mode and is
revalidated under the local compatibility mode; that mode is not historical proof.
Cached `applied` text grants no execution qualification. Result publication checks
the original record binding, intended content and current proof.
Unvalidated history remains unavailable during target validation; values already
validated in this runtime remain usable during later updates. Original stops keep
their identity and revision. Current stop verification waits for the original job
to end, checks the resources again through the same adapter, and blocks new Project
preparation and readiness until that verification completes. Initial retained
Project coverage counts only after the manager accepts it under usable
authenticated authority. Unread, null or unsupported authority leaves that
verification pending; recovery rechecks it, and cached success cannot replace
resource observation by the current coordinator.

Heartbeats exchange targets and a bounded batch of complete current observations;
native and Project operations run outside the report and commit queues. At most
16 asynchronous configuration jobs run, rotating by record identity; scalar state
transitions use no asynchronous job slot. Independent successful items stay applied
when another item fails. Failed application attempts use 5, 10, 20, 40 and then
60-second backoff. Storage failures retain the original error and do not publish
uncommitted results. The last committed target, effective values and Project view
remain available; storage readiness closes new execution admission without
manufacturing a removed-Project target. An uninitialized, unread or unsupported
target also closes new Task and Bot admission while the original coordinator
resource view remains available; a local bootstrap candidate grants no execution
qualification. After a cold restart, that recovery view uses actual registered
Project IDs, the original frozen native tuple and any retained, genuinely applied
recovery limit. The limit is exposed separately from effective admission values;
missing facts remain unknown and are not filled from a local candidate or default.
Task configurationComplete and Bot canAdmitNewExecution are checked after awaited
preparation and before the first intent, registration and dispatch. Original
submitted/unknown execution and frozen native recovery/input/stop keep their
original identities and permissions.

Each observation batch fits at most 1025 non-mode items and 1026 total items when
mode is negotiated, the 4 MiB Go-encoded storage budget with 512 bytes reserved
for its wrapper, and the 9 MiB configuration request budget. One real unfinished
or failed removal verification has a fixed slot; the other eligible records form
a continuous prefix after the durable `projectionCursor`. The first item that
cannot fit starts the next batch, so large valid items are not skipped to fill
later small ones. Capture sizes the actual report sample used by send, including
optional telemetry preparation. Only an accepted matching capture advances the
current generation's cursor and acknowledges its exact
`sourceRecordId`/`failureId` pairs. The local token includes a random report ID,
generation, exact base, observation and sent record identities. A stale-generation
receipt cannot change the current target, baseline, failures or cursor. A matching
rejected observation adopts the receipt's canonical state and produces a new
report; false for a null observation is a normal receipt with no observation to
confirm. New or unsent failures remain owned locally; a failure without a current
carrier is not invented as a new Project target.

The server replaces the most recently accepted observation batch without merging
older batches. Missing target items mean unobserved/pending, while the complete
local facts remain durable. Application history is not deleted to make a report
fit, and a task inventory remains complete. The [Worker requirements](../../docs/spec/daynight-worker.md)
and [configuration contract](../../docs/spec/daynight-worker-configuration.md)
own these guarantees; the [fact separation decision](../../.agents/notes/implemented/architecture/2026-11-12-worker-configuration-fact-separation.md)
records their representation and reporting trade-offs.

The coordinator reads current successful concurrency, polling, recovery, platform
preference and native values. Lowering concurrency does not stop existing tasks;
new starts wait until usage is below the limit. The next post-round polling wait
uses the applied interval. Running native processes retain their launch
arguments. Each claim retains its recorded agent type and native session ID;
Herdr restarts preserve the claim’s frozen native settings, while Web recovery
keeps its existing frozen execution configuration. Settings for another type are
not applied to it. A running disconnected Worker retains successful values;
restart checks the cloud before normal scheduling. Task inventory or backend
preparation failures do not disable configuration exchange.

`preferPlatformSpecificTasks` defaults to false. Enable it separately for selected
Workers in My Workers; local YAML supplies it only for the first cloud import.
When enabled, new acquisition first scans all selected, eligible Projects for
tasks explicitly requiring the actual host platform, then considers unrestricted
tasks. Each category retains its own Project rotation and creation-time/ID order
within a Project, across every candidate page. Preferred scans and claims do not
advance the unrestricted category's rotation. Applied changes affect later acquisition;
existing claims and pending startup retain their current lifecycle. A confirmed
false application value means disabled; null means no confirmed application.

New tasks have automatic execution disabled. Enable it explicitly through the
normal task update workflow after reading the current task and version. Worker
only acquires ready, permitted tasks compatible with its actual platform; WSL is
Linux. It never enables permission itself. Released tasks return to ordinary acquisition. The original Worker remains subject to its own retained
resource barriers.

```bash
daynight worker run
```

First use generates and atomically saves stable root workerId. One instance owns
`worker/` state under the selected configuration root (default `~/.daynight/worker/`), its configuration cache, SQLite, lock, logs, temporary resources and
private Herdr resources. On macOS, each actual run has its own existing Herdr
daemon and durable lifecycle record; Linux and Windows use the shared private
daemon. Each task uses branch `daynight/<task-id>` and directory
`<repository>/.worktrees/daynight/<worktree-id>`. Migrated claims retain their original task-id directory and cwd. Valid claims retain their dirty
worktree; task branches and commits remain after terminal cleanup. Repository
preparation migrates only worktrees associated with existing resource records,
manifests or Worker Git registrations. Unrelated directories under
`.worktrees/daynight/`, including `.tmp`, remain untouched and do not block preparation.

A workspace label starts with the task title and ends with its full stable owner:

```text
Fix worker startup | daynight:{"projectId":"…","taskId":"…","claimId":"…","worktreeId":"…"}
```

The title is display text. Ownership checks and the managed agent name use only
those four canonical UUIDs; renaming a task does not change its claim, worktree,
agent name or native conversation. Herdr labels and worktree manifests share that four-field identity. The configured service address remains available to API
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
and at most one claim for the same Project/task can be active. A removed Project
is excluded from automatic execution and its saved mapping continues reconciliation.
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
are ineligible for automatic acquisition. Still-owned local active tasks are
queued for fresh target observation and recovery before global Git discovery, so
a sibling checkout's filesystem error does not block an already-reserved task.
New pending startup and new claims require complete claim inventory, target
repository discovery and a reliable execution-capacity observation. A localized
format failure closes that repository's file gate while independent prepared
repositories remain eligible. Failed or partial reads are errors, not an empty
inventory. Resources from unqueried or unmapped Projects are preserved with a
diagnostic.

Capacity is the claim-deduplicated union of active rows, actual owned resources,
already selected cleanup responsibilities and adapter stop confirmations still
pending. An orphan retains its same-task barrier until cleanup finishes. Confirmed stop
of the original execution releases its execution slot independently of archive
and file cleanup. A queued recovery still reserves a slot. Worktree manifests
identify a claim rather than a worker. A Git-only resource must be tied
to a local row, the private Herdr instance or a current own claim before this
worker can clean it; otherwise it is reported and preserved.

A candidate with retained same-task resources is skipped before remote claim.
An unknown claim response emits Warning and creates no resources. The worker
finds the actual grant in a later complete inventory instead of replaying the
request. A late grant can remain pending while local active slots are full. On
macOS, only a grant confirmed in its original acquisition can register fresh
launch provenance. An inventory-recovered claim without that durable record remains unknown; empty remote summaries cannot
authorize another launch.

Each reconciliation round acquires at most one new task across all configured
Projects, even when more slots remain free or the granted task must stay pending.
The next acquisition waits until the next round after `pollIntervalMs`, continuing
the selected category's independent Project rotation and preserving server
creation-time/ID order within each Project. With the preference disabled, the
original mixed compatible category shares the unrestricted category's rotation. Empty Projects are skipped. Existing
pending rows have startup priority, with stable task-ID order inside each Project; they can use multiple free slots in one round,
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

Workspace creation supplies the shell's initial cwd. Before every fresh
`agent.start` attempt, after caller admission, the original pane's current cwd
must canonical-match the task worktree. Herdr writes argv into the existing
shell, whose startup scripts may have changed directories; native trust
arguments do not set cwd. A mismatch fails as definitely not-submitted without
starting the native agent. Reconnecting to an existing live agent returns
before this launch-only check.

A replacement shell can still be initializing when Herdr rejects `agent.start`
with `agent_pane_busy`. The adapter retries this explicit rejection for at most
two seconds while the original workspace, pane and terminal remain owned,
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

The full startup prompt states that the task has sufficient authorization for
completion and instructs the agent not to ask again about procedural authorization,
such as whether merging the PR is authorized. Task scope, independent pauses or
revocations, and CI, review and merge gates still apply.

Startup, macOS recovery or continuation, and periodic ping prompts share an
autonomous execution policy. The agent checks the task, repository constraints
and evidence, adjusts its approach, steps and task decisions, investigates failed
approaches and chooses feasible alternatives, and records significant deviations
and their reasons. It preserves confirmed business goals, scope, acceptance,
external commitments and authorization. Ordinary information gaps, unavailable
tools, failed approaches, recoverable errors and obsolete steps alone do not
trigger a pause.

A request for a specific human decision requires an evidenced severe design
conflict: confirmed requirements or architecture constraints cannot all be met,
no feasible compatible alternative exists, and resolution requires changing a
confirmed constraint. Before waiting, the agent records the evidence, affected
requirements, alternatives considered and decision needed, then sets its own
task's `paused` property to true with an observed exact version and confirms the
same assignment and pause. It retains session context; the user chooses how to
respond. After verifying resolution, the original assignment and permission to
resume, it clears the pause and confirms false or absence before continuing.
Independent user pauses, restrictions and revocations, `allowAgents=false`, and
claim or assignment changes remain binding. The [Worker execution contract](../../docs/spec/daynight-worker.md)
owns readback, failure and conflict handling.

The Worker appends the latest confirmed personal user, project and Worker prompt
texts to newly assembled startup, recovery and continuation inputs, in that
order. It receives them through the existing configuration report and keeps them
only in memory. An unknown or oversized input waits without consuming recovery
attempts or changing the claim; a later configuration update can make it ready.
Already assembled inputs retain their original delivery identity. See the
[prompt contract](../../docs/spec/worker-prompts.md#worker-输入) for the text,
synchronization and input limits.

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
from the service after workspace serialization, native readiness and known
input-blocker checks,
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
or missing runtime is an error. Without a lifecycle journal, attach reads the
shared instance journal. Both paths verify and use the original frozen Herdr
client recipe; missing historical identity or changed files prohibit a new client.
Detaching preserves execution. Task panes retain their
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
owners; task delivery still follows its business authorization. Automatic input
uses Herdr's structured agent identity, readiness, launch and blocked states.
For Codex and Claude, it then reads the bound pane's complete visible text only
to reject explicit known menu or disabled-input patterns. Normal composers,
status bars, directory displays, placeholders and borders are not required.
Customized or unknown normal layouts proceed immediately after readiness; there
is no layout whitelist or unknown-layout wait. Any supplied final task
authorization guard runs after the read and binding/state recheck. Known blockers retain the
pending initial input or continuation opportunity without advancing its submitted
baseline or consuming execution recovery attempts; closing them permits a later
patrol to continue. Failed, malformed or truncated reads remain unsent errors.
The blocker set does not claim to recognize every future native screen. On macOS,
`automatic` and `cleanup` inspection report composer evidence as unavailable;
`manual` permits its lease holder to operate menus. Explicit handback and clean
orderly recovery use the separate `resume` purpose: Codex and Claude require
ANSI-preserved empty-field evidence without optional model, cwd or status-bar
requirements. Codex placeholder words alone are insufficient: DIM renderer
attributes and current field geometry distinguish them from literal or multiline
drafts. Claude accepts a genuinely blank bordered field, not ambiguous Try text.
Unknown or unsupported styles cannot become empty. Copilot retains
unavailable composer evidence and its explicit handback responsibility. Durable
leases, fences, draft dispositions, cleanup priority and unknown-input results
retain their existing guarantees. A typed known blocker before any native write
remains waiting after journal serialization and lifecycle pending projection;
a possible write still produces an unknown outcome on failure.
The worker supplies the initial task cwd at workspace creation and checks the
original shell cwd only immediately before a fresh native start. Resource
discovery, live-agent reconnection, input observation and stopping do not require
pane and agent cwd metadata to agree. A human workspace at the same cwd does not prevent creation
of a separately owned task workspace. Actual creation errors come from
`workspace.create`. Original workspace/pane/terminal binding, final task
authorization, process-stop evidence and prompt receipts remain checked. Missing credentials, integration failures and launch errors
stay visible. Use attach for business input. Reconnecting an already alive agent
does not promise to resend an input lost across a process interruption.

When the original claim is absent from a successful complete inventory, the
backend owns terminal resource cleanup. macOS Herdr writes its stop intent and
close request before controlled stopping. It checks original process birth and
audit identities, stops only its isolated runtime, persists the stop proof,
closes segments and confirms the same-generation ledger with the service.
Unknown identity, replacement or stop outcomes retain responsibility and block
new runs. A journal write failure permits only an unconfirmed best-effort stop;
pane disappearance cannot prove success after restart.

macOS Herdr records complete terminal samples independently of viewers and
network connectivity. The combined Worker publishes its observation, control
and archive capabilities through Session v2; a compatible page is still required
to render terminal content and expose its controls. Samples are durable before
publication as recorded. Identical screens retain a five-second checkpoint of
their observed duration; interrupted intervals and recording limits remain
visible in partial archives.

A durable input arbiter revokes control before cleanup. It sends one bounded
advisory prompt only from safe automation with no manual draft or unknown
input; other states skip the prompt and proceed with controlled stopping.
Confirmed stopping releases the execution slot while a separate queue freezes
the original Session and uploads its fixed archive. Worktree deletion requires
the matching durable `ready` or legitimate `unavailable` receipt. Failed source
or upload responsibility retains the original worktree and blocks a new claim
for that task; other tasks may run within the independent resource budgets.
See [retained recordings](#retained-herdr-recordings) for inspection and explicit
recovery or disposal.

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

Transient or unclassified cleanup failures retry independently after 1, 2, 4, 8, 16, 32 and then at most 60
seconds, when normal reconciliation next observes eligibility. Backoff does not
spend execution recovery budget or release a capacity slot. Other eligible
cleanup and healthy execution continue under the existing capacity limit. Errors
identify the failed stage and next retry time, distinguishing unconfirmed native
stop from a stopped agent awaiting backend closure, archive upload or worktree
removal. If a retry-state write fails, the current process retains bounded
backoff and both errors without claiming that the latest decision is durable.

A known incomplete Web archive enters a durable repair-required state. Every
15 minutes the Worker checks the original stopped generation without loading
pending timeline content or resource bytes. The claim and source remain reserved; a confirmed stopped execution no longer
occupies capacity. A recovered receipt still enters the normal remote receipt validation;
its presence alone neither clears the repair classification nor releases resources.
Confirmed complete source conditions clear the saved repair classification before
a full cleanup attempt, which must pass every archive and ownership check. Later
transient upload failures use normal cleanup backoff or the 60-second historical
backfill retry. A failed classification write preserves the repair wait; successful
classification changes still retain cleanup responsibility until complete cleanup
succeeds; execution capacity follows the original stop observation. Repeated checks do not repair missing history or clear
its completeness flags.

The Worker prepares each selected or retained repository by converting legacy
ownership into durable manifests before admitting file operations. Conversion
preserves existing checkouts and frozen cwd, and leaves conflicting or unknown
resources visible. A manifest locates a worktree but does not authorize deleting
unregistered nonempty content. The common-directory and origin inspection
queries run from the stable primary checkout with explicit verified
administrative and manifest-bound worktree paths, so their cwd does not prevent
concurrent leaf removal on Windows. Git continues to interpret the linked
worktree's configuration; a `core.worktree` redirect does not change the physical
resource identified by its manifest. The old Worker cannot manage converted
resources. The [Worker design](../../docs/design/daynight-worker.md#git-工作区与资源身份)
defines the inspection and cleanup checks.

A fully enumerated, independently attributed damaged worktree can be quarantined
only for static local validation failures under stable observations, while
unrelated tasks use remaining capacity. It blocks reuse of the same task; a confirmed stopped execution does not retain
an execution slot. Observed changes to ownership, metadata, current directory
objects or Git pointers during inspection leave coverage unknown. A manifest and independent execution evidence must agree before a damaged
resource can be attributed. Unreadable inventory, changing observations or
conflicting ownership can make capacity unknown. An online heartbeat or zero remote active
tasks does not establish that local capacity is available.

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

The diagnostic file sink uses fresh
`worker-YYYY-MM-DD-<32hex run id>-<segment>.jsonl` files for each run and recovery;
the date belongs to run startup and the current filename is exposed dynamically.
Temporary directory/create/append failures are visible through stderr and
available monitoring, then retried with capped backoff. Up to 256 records wait
behind one active writer. Undispatched omissions and unknown append attempts have
separate counters; a failed append can leave bytes in an older segment. Recovery
writes a new valid summary linking paths and counts and never replays unknown
records. Old partial tails remain inspectable and are not recovery inputs or an
exact loss ledger. Periodic flush joins current work; final close stops retry
scheduling and joins file/notification work after all emitters and stores finish.
Formatting, stdout/stderr and independent notification errors retain their chains.

Configuration diagnostics preserve the actual authority read, bootstrap
preparation, telemetry collection, observation capture, report send, receipt
acceptance, cache persistence and application stage. Queryable `configuration`
metadata includes the original item target and record, the current authority
generation and baseline, report/sync IDs and an available HTTP request ID. A
bounded, valid response `X-Request-ID` takes precedence over a body ID and remains
available when the response body is malformed; a body ID is used only when the
header is absent. Unread
authority, initialized authority and an uninitialized service are distinct;
`"0"` remains a valid initial observation baseline. Typed tool failures and
controlled file errors retain fixed reasons without recording native arguments,
command output or credentials. Malformed YAML and invalid local fields are
classified as invalid configuration without copying newly edited credentials;
authentication and permission refusals remain visible terminal authority-read
failures. A configuration POST cancelled before its queued transport dispatch
remains unsent. Remote confirmation stays confirmed while its
local checkpoint is pending, including after the report waiter ends. Diagnostic
failures do not change application or receipt outcomes.

The first failure, changed reason or target, and genuine recovery are emitted
immediately. Continuing failures produce at most one summary per five minutes
through existing cycles. `occurrences` counts actual failures in this run;
`backoffStep` describes the separately capped retry delay. Dynamic request IDs and
timestamps do not split the same cause into new groups. The
[configuration diagnostics design](../../docs/design/daynight-worker-reporting.md#失败与可观察性)
defines the complete fields, certainty values, `jq` filters by Worker/key/target,
sync ID or request ID, and the limits of querying an older partial segment.

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

Select Control mode `web` and Agent `codex`, `claude` or `copilot` in
My Workers → Configuration. Before enrollment, `worker.agentControlMode` and
`worker.agent` in `~/.daynight/config.yml` supply the initial values.
The default mode is `herdr`. The mode is
worker-wide, frozen by the service on each claim, and cannot be changed through
summary updates. Older claim records without a mode mean Herdr. Changing
configuration affects new claims; existing work stays with its original backend.

Web execution does not initialize, start or probe Herdr. Independent runtime
reporting only reads the private endpoint for its version and does not initialize
the Herdr execution backend. Codex uses a private app-server over stdio, Claude
uses the bundled Agent SDK, and Copilot uses the bundled SDK with
its own headless runtime. Provider arguments are checked for that backend before
claiming. The service must advertise the matching Session protocol and provider.
Codex stdout consumption yields to ready I/O after each complete frame and each
bounded decoder input slice. Output remains ordered and complete, media leases
retain their existing ownership, and partial frames keep their original absolute
deadline. The Worker IPC observation timeout remains 2,000 ms. This cooperative
scheduling cannot preempt a single synchronous decoder or storage operation.
The [Controller design](../../docs/design/task-session-protocol.md#codex-输出消费与-io)
owns the mechanism; the separate local stress entry can run
`pnpm test:stress test/commands/controller/output-responsiveness.stress.ts`
for native stdout, authenticated IPC, content and outbox accounting evidence.

Keep authentication in the native provider profile; credentials never enter a
Session URL. Project members can read the task's Session tab for messages and tools.
Only the persisted Session owner can send input, change model or permission
settings, execute supported slash commands, steer, interrupt or answer current
approvals; other administrators and members are read-only. Unsupported native
controls remain unavailable.

Copilot Web bundles SDK 1.0.11 and the `@github/copilot` 1.0.105 package, with token-authenticated loopback
transport to its private runtime. `COPILOT_HOME` chooses the native profile;
`model: null` and `args: []` preserve native defaults. Web arguments accept
`--effort low|medium|high|xhigh`. Plan approval supports exit-only, interactive
or reject with optional feedback. Unknown send results are not replayed or
resolved by matching historical text. Provider-specific runtime evidence is
required separately from protocol tests.

The pinned macOS arm64 package includes the native MSAL broker addon and its
runtime library for Entra authentication. Authentication still belongs to the
native Copilot profile and requires a valid login and organization access.
Worker capability probes and Web launches use the bundled executable with
`--no-auto-update`; installing or updating a Copilot executable on `PATH` does
not change this runtime.

Update Daynight to a release containing the dependency change with `daynight
update`, or install a package built from the desired revision. An existing
installation and its running Worker/Controller processes do not switch merely
because repository dependencies changed. Restart the Worker after its active
work has reached an appropriate stopping point, retaining its local records and
native profile so sessions can resume. To verify an installed package, resolve
its `@github/copilot` platform dependency and run that executable with
`--no-auto-update --version`; a plain `copilot --version` can report an automatic
update cache or another installation.

The primary worker database retains its claim and native-session index. Web
execution state lives separately in `~/.daynight/worker/web-executions.sqlite`
with its own format version 2. The version 1 upgrade removes redundant cleanup
input/results and stopped/closed/deleted flags, preserving cleanup intent,
identity and deadline. Version 0 resets its schema and data through the common
SQLite policy. Private launch tickets and Controller
journals live under `~/.daynight/controller/`; journals retain their independent
format version 11. Both Worker stores must open successfully before scheduling.
Web restart reconnects to a surviving Controller. Starting a new generation
requires proof that the original native processes stopped and the exact native
session ID. A missing journal or ID cannot authorize a replacement conversation.
Unknown initial inputs and operations are reconciled without replay.

Controller writers, local migration, stopped recording and archive write phases
share one execution storage permit. Current-format reads remain lock-free;
old-format upgrades acquire the same owner and reserve their writes. Preparation
separates upgrade-only, stopped-maintenance and writer admission. The writer holds
its permit until relay, media and journal handles close; archive and source-tail
transport release local ownership before the network and verify the same stopped
source after reacquiring it. Stopped settlement retains its existing 8 MiB reserve
above the ordinary 128 MiB metadata limit, so an acknowledged tail can settle
before recovery applies normal writer admission. Unknown process state and unconfirmed handle close
retain their evidence. The journal stores one current SQL row per timeline entry;
body, UTF-8 totals, Markdown/image state, original input origins and outbox commit
in the original transaction. Replaced body revisions do not create candidate files.
Historical candidates remain only until reader-safe stopped maintenance finishes.

The outbox stores its exact encoded UTF-8 byte total in the same journal
transaction as every queue mutation. Capacity reads use the singleton total;
partial acknowledgements measure only deleted rows, while full drains and clears
bulk-delete and reset the total. Normal reopen and recovery do not recount the
queue. Version 11 initializes the total once from old encoded text during the
original migration transaction, independent of the SQLite file encoding.

Version 10 imports only committed historical body pointers and preserves the
original execution, native identity, operations and message origins. Upgrade-only
reads retain stopping evidence and pending cleanup; they do not prove native
termination. Proven stopped maintenance completes the reader checkpoint barrier,
legacy body retirement, in-place VACUUM, post-checkpoint file verification and
actual reservation settlement before the next writer starts. Busy readers or
physical capacity refusal keep the original history and report maintenance
waiting. Current timeline JSON remains limited to 64 MiB and 100000 entries;
normal physical admission still applies independently. The
[SQL content design](../../docs/design/session-sqlite-content.md) defines these
storage and recovery boundaries.

Initial launch preflight uses the frozen ticket before spawn. The child prepares
under its own permit and commits its generation and original Controller proof in
one transaction before native side effects. Lock or capacity waiting retains the
same launch, ticket and recovery budget. Runtime construction closes every created
resource on failure and initializes capture callbacks before relay connection.
Recovery records the original complete stop and finishes local maintenance before
allocating another generation. A committed stop remains committed when later
close or permit release reports a failure.

An unconfirmed Controller launch retains its original ticket and spawn identity
across observation windows. Only authenticated IPC acknowledges the launch;
a preceding or missing journal cannot do so. Cancellation stops the original
bootstrap process within the cleanup deadline, then checks the journal. If the
current generation was committed, complete Controller and native stop evidence
is still required. A pre-writer exit retains the launch and its resources as
blocked, without inventing a stopped generation or replaying input.
Windows full-stop confirmation retains the original authenticated Job lease and
pins the known original Controller/native process handles before Job termination.
It returns only after those birth-verified handles are signaled and the same Job
inventory is empty. ESRCH, changed exit codes and a missing Job name cannot
replace that completion proof. A birth-verified bootstrap already terminating
waits on the same handle within the original cleanup deadline. Unknown native
state, identity conflicts, wait failures and handle-close errors retain failure
and resource responsibility. The [process exit decision](../../.agents/notes/implemented/bug-fix/2026-11-13-windows-controller-exit-completion.md)
owns the completion rule. A versioned proof in the journal preserves a confirmed
stop for later resume and archive. Older Windows records without that proof
remain blocked when the original Job cannot be verified.

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
their private local source. The Controller stores resource descriptors, blobs,
pins and leases through its resource file owner. The SQL content composition
checks current timeline and native input references before removing a resource.
Archive and active history uploads materialize their ordered timeline, resource
descriptors and source cutoff in a short SQL snapshot, then end the snapshot before
network work. Stopped archives close their local SQL connection; the active
Controller retains its lifetime writer. Frozen uploads retain only materialized
values and file reads/leases; later stopped acknowledgement and archive checks
reopen SQL under the original identity.
The current directory and user files are never removed by the launcher.

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

Stop `daynight worker run` before retry, release or resource management.
Each command acquires the same instance lock; an occupied lock returns an
instruction to stop the runner. Retry and release synchronously handle
one specified claim without a background request queue. Resource disposal
persists its explicit decision so an interrupted deletion can resume against
the original identity.

### Retained Herdr recordings

Inspect retained macOS Herdr resources before choosing a retry or disposal:

```bash
daynight worker resources list
```

The JSON result identifies the original Session, project/task/claim/worktree,
stop evidence, source and worktree paths, source byte count, archive state,
retry time and any disposal decision. Inspection never starts an Agent. A
confirmed original stop releases execution capacity even if archival failed,
provided no quarantined resource responsibility remains. Quarantine retains its
reservation until revalidation; `stop_unknown` still consumes capacity. The old worktree continues to reserve
its task path until verified removal.

New claims are blocked at 20 retained worktrees or 2 GiB of pending recording
source, or when the worker filesystem has less than 1 GiB available. Each round
advances at most one historical Herdr archive. Temporary upload failures use
5-second to 5-minute exponential backoff; permissions and permanent corruption
require explicit attention. Other running tasks continue. Ready local sources
are retained and still consume actual disk space; there is no automatic source
expiry or garbage collection.

After restoring the original owner's access or resolving a transient cause,
request another archive attempt with the identities from inspection:

```bash
daynight worker resources retry <task-id> --project <project-id> \
  --claim-id <claim-id> --session-id <session-id> --worktree-id <worktree-id>
```

Archive retry preserves the original operation and source. It never resumes an
Agent, switches archive owner or converts corrupt source into a partial or
unavailable archive. Normal worktree cleanup requires a durable, matching
`ready` or legitimate `unavailable` receipt.

For an irrecoverable failure, explicitly choose `abandon` to stop retries while
retaining files, or `delete` to remove that original worktree and recording
source. Deletion discards local recording evidence. Both choices require the
original execution to be confirmed stopped and its claim to be terminal:

```bash
daynight worker resources dispose <task-id> --project <project-id> \
  --claim-id <claim-id> --session-id <session-id> --worktree-id <worktree-id> \
  --operation-id <new-operation-uuid> --action abandon --confirm
```

Use `--action delete` only after reviewing the exact paths and consequences.
The stable operation UUID identifies this explicit choice; reuse it with the
same action after an interrupted result. Identity mismatches, active claims,
unknown stop evidence and missing confirmation are refused. Disposal preserves
the archive's historical failure and never manufactures a successful receipt.
Worktree deletion retains the existing ownership and resource-use checks.

### Active claim management

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
a matching finalization receipt permits deletion. The ordering above applies to legacy Herdr;
Web also applies its own archive gate. The worktree is retained until remote
confirmation. A refusal leaves it available
for original execution recovery; success followed by local deletion failure is
finished by the next run's ordinary absent-claim cleanup. Stopping failure cannot
supply stoppedConfirmed. Explicit --if-version is never replaced during cleanup.

```bash
daynight worker release <task-id> --claim-id <claim-id> --if-version <version> \
  --project <project-id>
```

Release returns the task to todo, clears its execution interval and removes
worker and sessionStartup. Session and archive history retain their original identities. Eligible tasks participate in ordinary automatic acquisition,
with the usual assignee, permission, platform, dependency and Goal checks.
Remote Worker control reads the caller's current `/projects/{id}/access`
projection for administrator authority and verifies its project/principal binding;
member profile reads retain their separate directory responsibility. Grant
versions preserve the full positive int64 range.

Release submits one remote request after confirming the source has stopped. A
valid response confirms release; a lost or invalid response remains unknown and
is neither replayed nor inferred from a later Task read. Source completion runs
only after a valid response. If completion fails, release remains confirmed and
the original resources need cleanup by a later run.

Web task details show the current claiming user, machine, agent and phase. The
original owner or a project admin can confirm **Force withdraw** for active ownership. This submits the reviewed claim ID and exact version,
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
[model options decision](../../.agents/notes/archived/feature/2026-10-22-review-copilot-model.md)
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
[multi-perspective decision](../../.agents/notes/archived/process/2026-10-22-pr-specific-review-perspectives.md)
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
current process groups; Windows skill discovery and review phases stop their
held Jobs and join captured process objects and direct streams. The legacy
unowned helper retains its separate ancestry checks and termination policy.
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

## Assistant tasks

`daynight assistant-task` operates user-owned collaboration tasks separately from
Project Tasks. Read registration, manuals, items and records; use Bot identity for
claims, inquiries and protected writes; use a user terminal for proposal decisions,
pause/resume and transfers. Every command supports `--json` and explicit
pagination. The [assistant-task manual](src/commands/skill/skills/using-daynight/references/assistant-tasks.md)
owns commands, private credential storage, operation recovery and failure rules.
It is also included in `daynight --skill` and the installed `using-daynight` skill.
