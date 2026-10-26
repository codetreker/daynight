# Agent Note: Completion Startup Setup

Status: implemented

## Problem

Native completion requires a shell registration in each interactive session.
Operators currently have to choose the startup file, add a loading statement and
avoid duplicate initialization themselves. Bash login and non-login shells read
different files, and zsh can relocate its startup files through `ZDOTDIR`.
Treating an installed statement as proof of a loaded parent-shell function would
report a state that a CLI child process cannot observe.

## Decision

`daynight completion setup [--shell bash|zsh] [--rc-file <path>]` installs
persistent startup configuration. This partially supersedes the manual-only
startup-file choice in the [native completion decision](2026-10-20-shell-completion.md).
That choice kept script stdout pure and avoided implicit configuration writes;
the explicit setup operation retains both properties for the existing `bash`
and `zsh` generation operations.

The command validates arguments before file access and loads its installation
module only for setup execution. An explicit shell wins; otherwise a bounded
query of the direct parent process must identify Bash or zsh. `SHELL` describes a
login preference and is not evidence of the running caller. An unrecognized
parent produces a diagnostic directing the operator to `--shell`. An explicit
`--rc-file` restricts installation to that single file.

Default Bash setup covers `.bashrc` and the effective login startup file selected
as the first readable existing file in Bash's `.bash_profile`, `.bash_login`,
`.profile` order. It creates `.bash_profile` only when none exists, preserving
existing startup-file priority. Existing profiles that are all unreadable cause
an error. The login block is POSIX-parseable and runs only in interactive Bash. It loads
completion independently, preserving the existing policy for loading the rest of
`.bashrc` in a login shell. Default zsh setup uses exported `ZDOTDIR`, falling
back to the home directory only when the variable is unset. An exported empty value selects
`/.zshrc`; setup resolves a relative value from its current working directory.
zsh resolves that value from its own startup directory, so starting elsewhere
selects another file. An unexported custom value requires an explicit file path.

A managed block checks that both `daynight` and `dn` register the expected
callable completion function before deciding that loading is unnecessary. A
missing or replaced registration for either command, or a missing function,
reloads the shared script and restores both commands. Managed blocks therefore
reuse complete registrations when startup files load each other.
Preserved manual loading statements retain their own execution semantics. zsh
reuses `compdef` when initialized and otherwise initializes `compinit` with its
normal security checks. Generated loading code preserves the nonzero status of
generation, evaluation and initialization failures. The generated zsh script
retains its own precondition that the caller initialize the completion system.

Setup recognizes its complete canonical managed block and the documented
standalone `source <(daynight completion bash)` or zsh statement. An installed
file is unchanged on repeat execution. Appending preserves original bytes and
line endings, permissions, the target inode and symbolic-link identity. Added
blocks and a missing final separator use LF: CR in generated shell code is token
data and can break command names, conditions and block delimiters. An adjacent
exclusive lock serializes installers; a file identity, modification
time or size change between inspection and append fails explicitly. Malformed,
modified or repeated managed blocks and invalid file targets are errors. Earlier
block templates are not migrated. A block that differs from the current template
requires removal of its marked section before setup can install the current
block; directly sourcing the current generated script remains available.

The command reports file installation separately from session activation and
prints the existing shell-specific source command. It does not execute user
startup files or claim to inspect the parent's loaded functions. Startup blocks
call the installed generation operation dynamically, so new shells receive the
current package's definitions. Tab continues to execute only the loaded shell
code and local directory enumeration.

[Client requirement C7](../../../../docs/spec/daynight.md#c7-补全启动配置安装)
owns observable startup-installation behavior. The
[top-level setup removal decision](../../implemented/simplification/2026-10-25-remove-top-level-setup.md)
leaves this independent shell operation intact. The [completion design](../../../../docs/design/daynight-completion.md)
owns startup ordering, registration tests and file mechanics. The
[README](../../../../README.md#shell-completion) owns installation and activation
instructions.

## Alternatives

**Add `setup --activate` as another sourceable protocol.** The existing generation
operations already provide sourceable scripts for the current shell. Another
activation operation would duplicate that interface while ordinary setup still
cannot mutate a parent shell. Setup instead reports the existing source command
and limits its own output contract to installation results.

**Have Bash login setup source `.bashrc`.** This would also load completion from
the non-login file, but it changes execution of every unrelated command in that
file. Independent guarded blocks cover both startup modes while preserving the
operator's existing policy for the rest of `.bashrc`.

**Use `SHELL` to detect the active shell.** This works when the running shell is
the user's configured login shell, but picks the wrong syntax and startup files
when the operator starts another shell. Direct-parent detection is bounded and
fails with an explicit override when a wrapper prevents reliable identification.

**Execute startup files to discover all equivalent loading statements.** This
could find arbitrary aliases, functions and conditions, but executing user
configuration has its own side effects and still cannot prove what the parent
has loaded. Static recognition covers the documented statement and owned block;
custom control flow remains the operator's responsibility to verify by starting
the shell.

**Migrate earlier canonical blocks during setup.** This would let setup replace
an earlier guard automatically, but requires taking ownership of rewriting
existing startup files. The installer retains exact current-template recognition
and explicit repair diagnostics. Earlier blocks still call the current generator
in a fresh shell and normally register both commands, while their original
registration guard remains unchanged.

## Consequences

The standard installation path handles the two supported shells without making
script generation a configuration operation. Preserving the original file
identity also preserves hard-link behavior and symbolic links, at the cost of
an append-oriented update rather than atomic replacement of a whole startup
file. Exclusive locking protects cooperating setup processes; external changes
are detected before append, but arbitrary external writers do not participate
in that lock.

A child process cannot recover unexported shell variables, inspect loaded parent
functions or change parent memory. Explicit file selection and the existing
source command keep these limits visible. Custom early returns, conditional
loading or later removal of registrations can prevent completion even when a
recognized statement exists. The installer does not interpret those programs.
A preserved unconditional manual source statement can still reload after a
managed block has registered completion. For example, `.bash_profile` can source
a managed `.bashrc` and then run its own standard manual loader. Automatic
conversion of such manual loaders is deferred: it would need an explicit policy
for taking ownership of user text and its execution order. It can be added as a
separate migration while setup preserves original statements; managed blocks
continue to skip existing registrations. An `fpath` autoload mode remains outside
the source output's contract and can be added independently with its own loading
shape and refresh rules.

Real-shell verification covers Bash 4.2, modern Bash and zsh in isolated startup
environments, including login priority, repeated setup and managed loading,
partial or replaced command registrations, missing functions,
unset, absolute and relative zsh directory selection, symbolic links, preserved
CRLF startup content, failures and actual Tab behavior. Empty `ZDOTDIR` root
mapping is verified with isolated mocked file I/O, avoiding host-root startup-file
writes. Generation retains separate dependency isolation checks. Test fixtures never modify the operator's startup files or
installed CLI. Observed runs and receipts remain attached to the tested source
revision rather than embedded as permanent success claims in this note.
