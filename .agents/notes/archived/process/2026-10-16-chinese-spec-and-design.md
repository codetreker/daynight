# Agent Note: Chinese Specifications and Designs

Status: implemented

## Problem

Specifications and design documents communicate product behavior and technical
mechanisms to Chinese-speaking reviewers. A blanket English-only instruction
conflicts with their intended reading language and leaves document authors
without a consistent rule for these two document types.

## Decision

The [repository instructions](../../../../AGENTS.md) and
[documentation conventions](../../../../README.md) require Chinese headings and
explanatory prose in new or revised documents under `docs/spec/` and
`docs/design/`. Code, commands, identifiers, paths, and API names retain their
required spelling. Other documents, skills, code, comments, and commit messages
remain English unless an explicit instruction selects another language.

This policy replaces the blanket document-language rule recorded by the
[shared workflow decision](2026-10-16-agent-workflow.md) for specifications and
designs only. The workflow's original rationale and the English Agent Note
format remain intact. The policy is forward-looking: existing specifications
and designs adopt Chinese when they are next revised, and immutable archives
retain their historical content.

## Alternatives

**Keep every repository document in English.** This preserves the original
uniform convention, but conflicts with the selected language for requirements
and architecture discussions. Distinguishing these two document types provides
an explicit rule without changing unrelated artifact conventions.

## Consequences

New and revised requirements and designs share the reviewers' reading language.
Authors must preserve technical literals when translating prose and keep this
exception synchronized between repository instructions and documentation
conventions. Workflow documents and decision notes continue to use their
existing English structure.
