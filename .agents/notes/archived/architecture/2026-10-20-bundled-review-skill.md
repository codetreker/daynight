# Agent Note: Bundled Review Skill

Status: implemented

## Problem

Review methodology must be delivered with the client that launches the reviewer.
An agent can discover several same-named skills from different locations, and a
retained conversation can already contain an older body. Replacing an installed
package while a daemon is running must not change the instructions used by its
later attempts. Checking discovery also introduces another child process whose
lifetime must obey the existing durable attempt and resource-exclusion rules.

## Decision

The review module owns `skills/daynight-review/SKILL.md`. The build copies its
whole bundle into the matching `dist/commands/review/skills/` directory, and the
npm package includes it. The stable entry's package directory locates those
resources; contributor workflows continue to belong to the root `.agents/skills/`.

Resource copying keeps exclusive destination creation. The destination URL has
no terminal separator: on Node 24.22.0 a separator can cause the filesystem copy
to create that directory before its exclusive existence check rejects the same
path. The real copy script is tested against a fresh isolated package, repeat
copy and missing source. Native CI resolves the latest available Node.js 24
patch so cached earlier behavior cannot hide this supported-runtime condition.
See Node's pinned [destination handling](https://github.com/nodejs/node/blob/f14cd3aa7bf9ca8df2cc5b8bb14beb0f335b1d93/src/node_file.cc#L3706-L3710)
and [exclusive existence check](https://github.com/nodejs/node/blob/f14cd3aa7bf9ca8df2cc5b8bb14beb0f335b1d93/lib/internal/fs/cp/cp-sync.js#L136-L149).

After acquiring its instance lock, the runtime captures and validates the bundle
once. A generated local plugin wrapper contains `plugin.json` and
`skills/daynight-review/`. Its fixed manifest names `daynight-review-bundle`
with wrapper version `1.0.0`, independent of the client release. Entry types,
canonical relative paths and file bytes of that complete wrapper determine a
content digest. An atomic publication prepares it under
`cache/review-skills/<digest>/`; existing snapshots must match the captured
content. Published snapshots are immutable and retained because past sessions
or uncertain processes may still refer to them.

Every attempt runs native `copilot skill list --json` in its prepared worktree
before the review process. Both phases receive one explicit
`--plugin-dir=<digest directory>` argument and the same child environment, with
all case variants of inherited `COPILOT_SKILLS_DIRS` removed. This keeps comma,
space and Unicode paths intact without installing a global plugin. Discovery must resolve exactly
one enabled `daynight-review` entry to the snapshot directory. A project override,
invalid response or unavailable skill fails the attempt. The review prompt
explicitly invokes the skill and identifies its current absolute entrypoint and
digest, including on full-UUID resume. No session transcript is parsed.

One persisted attempt covers these two sequential child phases and one timeout
deadline. After the discovery child closes and its output is captured, existing
process supervision must exclude that execution. Only then can the store clear
its exact recorded PID and identity while retaining the running attempt. A
cancellation/deadline check and discovery validation precede the review child.
Uncertain exclusion preserves the recorded process and lock and prevents the
next child. Separate discovery logs retain its failure evidence without entering
the review's completion-marker parser.

The skill owns methodology: description and original-scope quality gates,
introduced causality, callers and contracts, consequential defects, bounded
verification and actionable English findings. The
[PR-quality decision](../process/2026-10-21-review-pr-quality-gates.md) partially
supersedes its original Critical/Major-only approval scope while retaining the
packaging and loading decision here. Dynamic targets, current PR metadata reads,
publication eligibility, stable identity, retry reconciliation, foreground tools
and completion remain in the attempt prompt. The
[conversation-cycle decision](2026-10-21-review-conversation-cycle.md) changes
follow-up and remote completion persistence while retaining the packaging and
loading decision here: COMMENT now needs a real resolvable thread, same-round
recovery preserves approval and existing effects, and resolved feedback can wake
a new round without a commit. Configuration, session UUIDs and the existing
agent-owned publisher remain unchanged. The
[skill design](../../../../docs/design/daynight-review-skill.md) owns the mechanism
and validation boundaries. This extends the
[Copilot execution decision](2026-10-17-copilot-session-execution.md) and
[client command composition](2026-10-20-client-command-composition.md).

## Alternatives

**Inject the contributor worktree's skill.** This would let local development
resources supply the runtime method, but installed consumers do not have that
worktree and its contents can vary independently of the released client.

**Install the skill in a user-global discovery directory.** This makes it usable
outside Daynight, but introduces a second installation/update lifecycle and can
change unrelated Copilot sessions. Per-child plugin arguments keep this resource
owned by the launching daemon.

**Point discovery at the live installed bundle.** This avoids copying resources,
but self-update can replace files during a running daemon or leave a retained
conversation referring to different content at the same path. Immutable content
paths preserve the captured bundle across those replacements.

**Use `COPILOT_SKILLS_DIRS` for the snapshot.** This initially supplied the desired
native discovery and activation without a wrapper. Copilot CLI 1.0.98 interprets
it as a comma-separated directory list: plain, backslash-escaped, quoted,
JSON-array and percent-encoded comma-path probes resolved no skill. One local
`--plugin-dir` argument preserves the supported filesystem path as one value.

**Trust discovery configuration without checking the selected skill.** A plugin
argument supplies a discovery root; it does not prove that an
enabled same-named skill selected from a project is the intended bundle. Native
listing and exact directory matching make that selection observable.

## Consequences

The release includes its review method and does not require operators to install
another skill. New, retried and resumed attempts share the daemon's captured
bundle while keeping their existing conversation. Listing costs one additional
bounded Copilot invocation within the existing attempt budget and timeout.
Discovery failures remain visible and cannot silently yield an unskilled review.

Snapshots consume disk space as bundle contents change. Automatic collection is
deferred: it can be added independently only with a reference policy covering
retained sessions and uncertain executions. The layout must remain content
addressed and immutable so that later collection does not require redesigning
launch semantics. No configurable skill catalog or generic plugin framework is
provided. The adopted [public task skill design](2026-10-21-public-agent-skill-design.md)
assigns the separate public bundle and installation contract to a new skill
command. The public bundle is included by the shared build copier; its
interactive installer shares data-level capture and entrypoint validation.
Review retains this runtime loading, hashing and snapshot contract.

Native discovery against Copilot CLI 1.0.98 verifies the minimal plugin wrapper
through a comma-containing path after plain, backslash-escaped, quoted,
JSON-array and percent-encoded comma paths through `COPILOT_SKILLS_DIRS` fail to
discover the skill. A single `--plugin-dir` argument discovers it using the
modern minimal manifest from GitHub's
[pinned plugin reference](https://github.com/github/docs/blob/2d0a7bedfba3fec537f96da6e4188165ca25c252/content/copilot/reference/copilot-cli-reference/cli-plugin-reference.md).

A local Copilot CLI 1.0.100 probe uses the actual compiled 0.3.2 skill,
production `prepareReviewSkill`, and the adapter's exact activation paragraph.
Its isolated cache path contains a comma, spaces and Unicode; discovery selects
the exact prepared directory with `source: "plugin"`. The integrated 0.4.1
package retains those skill bytes, but its installed and ordinary tests are
separate from this observed 0.3.2 native loading result.

Initial creation and changed-bundle resume both complete the native `skill` tool
with `source: "plugin"`, retaining one full UUID. The first answer identifies
the skill's Critical/Major publication scope and final section. A verification
value exists only in the updated isolated skill body, absent from both prompts;
the resumed answer returns it. The new snapshot has a different digest while
the original compiled resource and earlier snapshot retain their bytes. This
establishes actual current-body loading beyond directory listing or controlled
prompt inspection.

The probe supplies no PR target and performs no review or GitHub publication.
Available tools are restricted to `skill` and `view`; shell, write and URL tools,
built-in MCPs and custom instructions are disabled, with bounded model turns.
The observation uses `-p` and JSON output. Production stdin and text completion
retain separate controlled process and installed coverage. Raw sessions, homes,
caches and checkouts are removed afterward; the sanitized receipt records zero
remaining probe processes and zero credential occurrences in isolated state.

Same-path resume can retain an old body, so content-addressed paths and explicit
current-path invocation remain required. Observed-version evidence does not
create a minimum-version promise or a production transcript parser. The existing
completion marker remains the agent's assertion and does not independently prove
its reasoning or remote effects; the conversation cycle separately verifies
matching remote publication before completing a round.
