# Agent Note: Read Bundled Skill Documents through the CLI

Status: implemented

## Problem

Coding agents need the instructions matching an installed CLI without requiring
an interactive installer or locating its package directory. The public skill
contains an entry and progressive references, so exposing only the entry leaves
its detailed instructions dependent on separate file discovery.

## Decision

`daynight --skill` and `dn --skill` output the current package's `SKILL.md` as
original bytes. An optional resource selects one Markdown file using a
slash-separated path relative to the skill bundle, such as
`references/handbook.md`. The entry explains this reading method; links within
reference files retain their document-relative meaning.

The shared `commands/skill/bundle.ts` captures and validates the package bundle
for reading, installation, automatic refresh and worker prompts.
`commands/skill/read.ts` selects the requested file and writes its Buffer through
the existing byte output channel. Selection and complete capture precede output.
Root option metadata supplies the optional resource syntax to parsing, help and
shell completion. Reading has no dependency on User or Project copies, cwd,
configuration, authentication, Git, native agents or interactive prompts.

[Herdr's bundled skill constant](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/main.rs#L449-L450)
and [direct output](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/main.rs#L737-L741)
provide the precedent for version-bound raw document output. Daynight's optional
resource preserves its existing progressive references. The
[skill requirements](../../../../docs/spec/daynight-agent-skill.md#as1-发布产物与路由)
own observable behavior; the
[skill design](../../../../docs/design/daynight-agent-skill.md#安装命令与既有机制)
owns module responsibilities. The
[original public distribution decision](../../archived/architecture/2026-10-21-public-agent-skill-design.md)
retains the installation rationale.

## Alternatives

**Output the entry alone.** This matches Herdr's standalone skill, but Daynight's
entry delegates its detailed rules to references. An agent reading stdout would
still have to locate the installed package or perform an interactive install.

**Concatenate every reference.** This makes one response self-contained but
loads all workflows, including managed execution instructions, before the
consumer selects a purpose. It also changes the entry's raw output and incurs
the full bundle size for ordinary command discovery.

## Consequences

A CLI invocation exposes one version-bound document with no installation or
business state changes. Existing installation and refresh continue to distribute
the same files; raw byte comparison validates reading against the actual npm
installation. This evidence proves document availability, not host discovery or
model compliance with instructions.

Consumers make separate calls for required references and supply paths from the
bundle root. Syntax and unknown resources fail as usage errors; missing or
invalid package bundles retain their execution error causes. Output failures may
leave partial stdout. There is no alternate source or retained-document fallback
when the current package cannot provide a valid bundle.
