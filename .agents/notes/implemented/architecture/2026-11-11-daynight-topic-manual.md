# Agent Note: Read Daynight Topics Independently and Generate the Offline Manual

Status: implemented

## Problem

The public skill's short index linked every operation to an anchor in one large
manual. Those anchors located content but did not provide independently readable
resources. Reading attachment instructions still required locating and extracting
part of the same document that contained Session history, Webhook recovery and
Step internals. Repeated explanations also obscured which topic owned a rule.

## Decision

The public `using-daynight` skill keeps one short entry and nine topic references.
The entry routes by purpose and states which common and resource-specific rules
must be read together. Product operations remain separate from repository
development workflows and compiled Worker constraints under the
[separation decision](2026-11-10-daynight-manual-workflow-separation.md).

The topic files are the only edited product-manual source. A fixed ordered list
in `commands/skill/manual.ts` is shared by bundle validation and manual assembly.
`manual-assembly.ts` validates nonblank UTF-8 topics, one initial H1, unique heading
slugs within each topic, closed code fences and resolvable local topic and section
links. The supported format is the fixed topics' Markdown headings, fenced code
and inline links; this does not introduce a general document-processing system.

The build preserves topic bytes in the installed bundle and produces the complete
`dist/commands/skill/usage.md` before publishing resources. Assembly lowers topic
headings one level, emits explicit anchors namespaced by topic and rewrites local
links to those anchors. Broken or incomplete sources fail before resource copying.
Installation applies the same topic validation before replacing any target, and
whole-directory replacement removes obsolete references.

`daynight --skill` continues to read the prebuilt complete artifact and print its
raw bytes. It neither assembles topics at invocation nor requires a skill
installation, source checkout, login, configuration or separate referenced file.
Its argument, error, cancellation and output behavior remains unchanged.

This decision replaces only the separation decision's single-file source layout.
That earlier layout avoided inventory and link-conversion costs when direct topic
reading was not an explicit delivery requirement; its ownership and authorization
rules still apply.

## Alternatives

**Keep one manual and read heading ranges.** This avoids assembly but makes every
selective read discover document boundaries before extracting the needed text.
The entry cannot directly identify an independent resource for the operation.

**Edit both topics and a complete manual.** Separate editable copies would require
every product change to synchronize competing descriptions. Build-time assembly
keeps offline completeness without introducing a second content owner.

## Consequences

Agents can read the relevant topic files directly, including required shared
write-safety material. CLI users retain one complete offline output. Topics and
the aggregate expose the same product rules without requiring identical source
and aggregate bytes.

The fixed inventory and link conversion are additional build responsibilities.
Resource tests must verify topic completeness, anchor conversion and rejection of
invalid sources, while installed CLI tests bind both aliases to the generated
artifact. Adding a topic or changing the supported Markdown structure requires
updating and validating that explicit assembly boundary.
