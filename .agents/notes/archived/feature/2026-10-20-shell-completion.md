# Agent Note: Native Shell Completion

Status: implemented

## Problem

The CLI has nested commands, an operation alias and a directory-valued option.
Operators must remember their spelling and argument position while typing.
Independent definitions for parsing, help and shell candidates would let valid
syntax diverge as the toolkit grows. Completion must also remain usable without
review configuration, a database, network access or a process launch on every Tab.

## Decision

`daynight completion bash` and `daynight completion zsh` generate complete native
scripts for Bash 4.2 or newer and zsh. Bare `completion` and its help options show
usage. Script generation writes only the script to stdout and does not resolve
user-home or working-directory queries, load review dependencies or execute
external tools. Scripts register `daynight` and its root alias `dn` when sourced,
as defined by the [short-command decision](../../implemented/feature/2026-10-22-dn-short-command.md); zsh
requires an already initialized `compinit` and reports its absence. The original loading contract
left startup-file changes to the operator so generated stdout remained a pure
sourceable script. The [setup decision](2026-10-21-completion-setup.md) partially
supersedes that installation choice with an explicit installer; generation
remains pure, and an existing shell still needs an explicit reload after a
package update.

Each command's business-free definition supplies names, aliases, options,
argument kinds and fixed choices. Parsing, help and both script generators share
that command tree. The root registry may import these definitions while command
execution stays lazy. The
[client-composition decision](../architecture/2026-10-20-client-command-composition.md)
retains responsibility for dependency ownership. Existing review syntax remains
exact: help is a sole argument at its level, `--path` occurs once before or after
the remote, and `review add-repo` accepts neither `--path=value` nor `--`.

Project creation declares one positional name and an optional `--repo` option.
Its `allowOptionsTerminator` declaration permits `--` to end option parsing so
leading-dash names remain representable. Both generated shells consume that
declaration: after the terminator they track only positional input and suppress
option and file candidates. Before it, unconsumed options remain available.
The [project/task decision](../architecture/2026-10-20-project-task-cli-design.md)
owns name validation and original-text preservation. The
[repository-discovery correction](../bug-fix/2026-10-21-project-create-repository-discovery.md)
owns origin inference and creation preflight; these execute only with the business
command, while completion continues to use static syntax without Git or service
queries.

Task command integration extends those definitions with explicit empty-value
permission for descriptions, fixed status choices and repeatable dependency
values. Value choices control validation and both generated scripts. Help uses
the declared names, value names, required markers and option descriptions; it
does not enumerate `value.choices`.
Text options accept inline assignment at the first equals sign, including leading
dashes in their values; directories, switches and help retain their rejection of
inline values. Scalar options disappear after use; dependencies remain available
after each occurrence. Status candidates work in separated and inline forms,
while free text and identifiers have no file fallback.

Loaded scripts use shell-native completion and local directory enumeration. They
do not start Node or another daynight process on Tab, read review data or make
network requests. zsh uses its native completion descriptions. Directory
candidates preserve argument quoting and special characters without restricting
manual input of an uncreated target. Remote repository input has no remote or
unrelated file candidates.

The [client requirements](../../../../docs/spec/daynight.md) own observable
behavior. The [completion design](../../../../docs/design/daynight-completion.md)
owns command-definition structure, shell integration, quoting, cursor handling
and real-shell verification. The [README](../../../../README.md#shell-completion)
owns activation and repeatable validation commands.

## Alternatives

**Support Bash 3.2.** This would cover the old Bash supplied by macOS, at the cost
of another quoting and directory-completion implementation and a separate
compatibility target. Bash 4.2 is the accepted minimum, and native zsh addresses
that shell directly. The Bash script checks its minimum and reports unsupported
versions; a lower baseline would require its own implementation and real-shell
evidence.

**Start Node on each Tab.** A process could reuse the TypeScript parser directly
and later fetch application-derived candidates. Current arguments need only
static syntax and local directories, so this would add startup work and a
runtime installation dependency to every interactive completion. Shared data
supplies the same syntax to generated local scripts without requiring the
business runtime. Future data-derived arguments need an explicit candidate
source and failure policy; they must not turn help or current static completion
into a configuration or database startup path.

**Switch the command framework.** A framework could supply command declarations
and completion adapters, but would replace the toolkit's small lazy-dispatch
model and require revalidating existing syntax and dependency ownership.
Lightweight typed definitions provide the needed shared facts while retaining
operation-owned execution. This choice keeps custom parsing and shell generation
as maintained code with explicit regression coverage.

**Use zsh `bashcompinit`.** Reusing the Bash script would avoid a second shell
adapter, but would require callers to initialize Bash emulation and would omit
native zsh descriptions and argument handling. The zsh generator uses the native
completion system and leaves the caller's styles unchanged.

**Ship the same zsh output as an `fpath` autoload file.** Direct source activation
requires function definition plus explicit registration; autoload requires a
different loading form. The source output has one documented loading contract.
An autoload installation mode can be added independently, provided its entry
shape and refresh behavior are specified and tested; the current generator must
not imply that its source output also satisfies that contract.

**Relocate zsh through the process environment or interactive setup.** zsh does
not accept `module_path` initialization from the inherited environment, and ZLE
can load native modules before the first interactive setup command. Appending
host completion directories also inherits their availability and trust policy.
The PTY fixture initializes the extracted package's module and function
paths in its private `.zshenv` before ZLE, then suppresses later startup files.
The fixture runs `compaudit` before `compinit -D` and fails immediately if the
audit rejects its paths. A terminal waiting for an operator trust decision is
not a ready test shell.

## Consequences

The command grammar has one owner across execution, help and two shells.
Generating or loading completion does not initialize review, and Tab stays local
to the shell. Supporting two native shells requires maintaining separate
renderers and checking actual Readline and zsh insertion, not only candidate
arrays. The separate PTY acceptance suite requires real Bash 4.2, modern Bash,
zsh and Python 3 on a POSIX host. A Linux preparation helper builds the
hash-pinned GNU Bash 4.2 release and uses existing or locally extracted zsh,
keeping test toolchains under the repository's `.tmp/` without global package
installation. Its initial preparation needs network and build tools; executable
selection remains explicit for other POSIX hosts. Extracted zsh uses a private
`ZDOTDIR/.zshenv` and native startup ordering so its modules are available before
ZLE; the fixture excludes inherited completion search paths and subsequent user
startup files while retaining `compaudit`. Ordinary CLI tests retain native
Linux, macOS and Windows coverage. The PTY driver uses the
[observable readiness protocol](../testing/2026-10-20-observable-acceptance-readiness.md):
a fresh primary-prompt generation followed by an actual editor widget
acknowledgement with an empty buffer and cursor zero. A queued reset widget
clears discarded input in the same generation; actual command execution waits
for the next prompt. Pipe-gated proofs exercise quiet pre-editor transitions and
a still-running capture widget without changing scenario assertions or deadlines.

The package's next invocation uses the installed command definitions; existing
shells keep their loaded definitions until sourced again. Saved generated files
must be regenerated after upgrades. Bash below 4.2 and zsh without `compinit`
receive loading diagnostics. Completion does not change review data formats,
configuration fields, clone paths or update ownership. Shell JSON receipts are
run-specific evidence, distinct from controlled installed-CLI and real-service
acceptance. The [completion design](../../../../docs/design/daynight-completion.md)
owns their coverage and interpretation; the corresponding PR and CI run retain
observed results for their tested revision.
