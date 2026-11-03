# Agent Note: Print a Standalone CLI Usage Manual

Status: implemented

## Problem

An installed command-line toolkit needs a discoverable operating manual that
coding agents can read without locating package files or running an interactive
installer. Command-specific help supplies syntax, but using several related
operations also requires their shared semantics: project selection, task
versions, dependency replacement and attachment output.

## Decision

`daynight --skill` and `dn --skill` print one standalone English CLI usage manual
from the current package. The manual covers practical operations and command
help discovery. Its YAML frontmatter identifies it as `daynight`, and its content
has no package-relative references. Task orchestration workflows remain owned by
the separately installed `using-daynight` skill.

`commands/skill/usage.md` is an explicit build resource copied to the matching
`dist` path. Root option metadata declares a sole information action;
`cli/application.ts` loads `commands/skill/read.ts` only for that action. The
reader locates the manual through the stable package directory, reads it in
full, validates UTF-8 and writes the original Buffer through the byte output
channel. It does not import the interactive installer or workflow bundle.

[Herdr's bundled skill constant](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/main.rs#L449-L450)
and [direct output](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/main.rs#L737-L741)
provide the precedent for a complete, version-bound usage document emitted as
raw text. The
[client requirements](../../../../docs/spec/daynight.md#c2-命令组合与退出结果)
own observable behavior, and the
[client design](../../../../docs/design/daynight.md#源码组织)
owns module responsibilities.

## Alternatives

**Print the public workflow skill.** Its entry delegates detailed instructions
to progressive references and owns task orchestration. Printing that entry
would not provide a complete CLI operating manual; concatenating all references
would load every workflow and duplicate their authorization and lifecycle rules.

**Add resource lookup to the root option.** Separate calls could navigate the
workflow bundle, but this creates a resource-selection interface and leaves the
manual dependent on more document reads. A single standalone manual provides the
requested operating reference through one invocation.

## Consequences

The installed version exposes its command use without login, configuration,
working-directory discovery, Git, native agents or interactive prompts. The
output preserves every manual byte, including frontmatter and its final
newline. Extra arguments fail before the manual is read. Missing files, read
errors and invalid UTF-8 retain their failure causes; output failure may leave
partial stdout.

The manual's operation summaries must stay synchronized with command definitions
and behavior. Less-common flags are discovered through the relevant `--help`.
Packaging checks validate frontmatter and standalone links; installed-package
byte comparison proves availability and output fidelity. These checks do not
prove model understanding or task workflow compliance.
