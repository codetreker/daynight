# Agent Note: Native skill installation terminal acceptance

Status: implemented

## Problem

Skill installation requires an actual terminal for Agent checkboxes and scope
selection. Pipe-fed answers cannot prove keyboard behavior, cancellation or
native isTTY checks. At this decision's adoption, setup acceptance used a POSIX
Python PTY and skipped Windows interaction, so it did not establish the required
Windows behavior.
Combining terminal output also obscures whether ordinary results stay separate
from prompt and diagnostic output.

## Decision

Skill installation acceptance uses the development-only `node-pty@1.1.0` with
real PTY on Linux/macOS and ConPTY on Windows. A small Node bridge inside the
terminal starts the actual installed launcher: stdin and stderr inherit the
terminal, while stdout uses a separate result file descriptor. The unmodified
CLI therefore observes real terminal input/error handles and ordinary output
remains independently verifiable.

Prompt matching uses stable visible text rather than a literal trailing blank:
ConPTY can encode that blank as cursor movement in its VT stream. Raw terminal
transcripts remain available, and complete answer, choice and stdout assertions
still establish the interaction's result.

Tests drive Space, arrow keys, Enter and Ctrl+C, inspect installed bundle bytes
and destinations, and bound owned process lifetimes. Ctrl+C is actual terminal
input; force termination is cleanup only. Fixture homes, simulated PATH launchers,
logs and temporary resources stay in task-owned project directories. Launchers
write a sentinel and fail if executed; its absence verifies that detection never
runs them. The
[installation acceptance decision](2026-10-21-simulated-agent-installation-acceptance.md)
owns the three-Agent by two-scope matrix, full bundle comparisons and replacement
checks. Hosted native CI supplies the final platform evidence, not a Linux
projection of Windows.

The workspace permits only the selected node-pty version's build hooks and
keeps `better-sqlite3` hooks disabled. Linux compiles the addon with its available
compiler and Python; published macOS/Windows prebuilds are used when available.
Actual Node 24 native loading and terminal behavior remain validation gates;
Node-API compatibility alone is not proof.

The stable 1.1.0 tarball publishes both Darwin `spawn-helper` binaries with mode
0644. Darwin's native spawn cannot execute them, so the maintained dependency is
pinned with a mode-only pnpm patch restoring 0755 for arm64 and x64. This matches
the upstream [publication correction](https://github.com/microsoft/node-pty/blob/d70a3252ca5337186130a8e4644ffe28b15cf640/publish.yml)
and fixes the published artifact rather than adding test-time repair behavior.
The [reported failure](https://github.com/microsoft/node-pty/issues/850) occurs
before the CLI starts; it is not evidence that Inquirer or the installer failed.
The patch can be removed only when the selected release contains executable
helpers and unchanged native acceptance passes.

The owning [skill design](../../../../docs/design/daynight-agent-skill.md)
describes installation and acceptance. The
[pinned node-pty manifest](https://github.com/microsoft/node-pty/blob/1def5774632305246fe21f0f69e23a664d6c5910/package.json)
owns its install path, and the
[terminal API](https://github.com/microsoft/node-pty/blob/1def5774632305246fe21f0f69e23a664d6c5910/typings/node-pty.d.ts)
owns spawn, input and teardown behavior. Version-scoped build permission follows
[pnpm settings](https://github.com/pnpm/pnpm.io/blob/e5b39ba571ca59b6e7b492082e8d5b81a05217c0/versioned_docs/version-10.x/settings.md#allowbuilds).

## Alternatives

**Implement ConPTY through Python ctypes.** This avoids a package dependency but
requires maintaining HANDLE types, process attributes, pipe readers and teardown
ordering. Microsoft's
[session walkthrough](https://github.com/MicrosoftDocs/Console-Docs/blob/8cf64f2ce92961421c4fb95f08ce3ee932893028/docs/creating-a-pseudoconsole-session.md)
and [close contract](https://github.com/MicrosoftDocs/Console-Docs/blob/8cf64f2ce92961421c4fb95f08ce3ee932893028/docs/closepseudoconsole.md)
make the deadlock and draining obligations explicit. The maintained native
adapter owns that platform work.

**Use ordinary child pipes or skip Windows interaction.** These can test
noninteractive errors but do not exercise the terminal contract or provide the
required native cancellation proof.

**Repair helper modes in each test or move to a prerelease.** Test-time repair
would conceal an invalid installed dependency and couple every fixture to its
packaging defect. A prerelease changes unrelated terminal behavior. The scoped
mode-only patch carries the upstream artifact correction while preserving the
selected stable implementation.

**Depend on a runner-provided terminal CLI.** The runner image documents Python,
PowerShell, .NET and Windows SDK tools, but does not guarantee a general PTY
driver. Depending on an undocumented executable would make fixture behavior
sensitive to image changes.

## Consequences

Native terminal tests add a development dependency and a narrowly scoped install
hook permission. End-user production installations do not include node-pty.
Test code has an explicit process lifecycle and can verify result/terminal
stream separation without weakening production interactivity checks.

Terminal installation proves the command and installed files. The installer
acceptance uses simulated launchers and does not install or run real Agents,
inspect account configuration, call models, or start Daynight services/databases.
Static checks validate skill frontmatter, ordinary and managed mode references,
neutral task-execution guidance, shared task-content standard and Goal protocol,
and task-command guidance. The [mode decision](../architecture/2026-10-21-using-daynight-modes.md)
owns using-daynight naming and legacy migration; the
[managed execution decision](../architecture/2026-10-26-managed-task-skill.md)
owns the current routing and lifecycle separation. Independent scenario review
assesses instructions separately from installer file proof. Existing
project/task suites own task behavior. Host discovery and
reload guidance follow the documented paths. Counts and transcripts belong to
source-bound PR/CI evidence; this note preserves the terminal mechanism and limits.
