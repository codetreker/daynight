# Agent Note: Cross-layer Task Attachment Acceptance

Status: implemented

## Problem

Storage, HTTP, CLI, browser components and deployment checks can each succeed
without proving that an installed CLI and production page consume the same
service files. Frontend-only fixtures cannot establish backend persistence or
cross-client bytes. A PDF response with the right MIME type and a loaded iframe
can also succeed without the PDF page visibly painting. Inline and standalone
readers additionally need proof that real input reaches the document end without
competing ancestor scrollbars. Combined delivery needs observable content,
service failures and resource cleanup tied to the tested artifacts.

## Decision

The [attachment requirements](../../../../docs/spec/daynight-task-attachments.md)
and [architecture](../../../../docs/design/daynight-task-attachments.md) own the
feature and accepted K1 limitation. This note owns combined attachment proof,
extending the [production browser acceptance](2026-10-20-dashboard-production-acceptance.md)
with an attachment journey. Independent runtime acceptance now also establishes
the integrated [split view](../../implemented/architecture/2026-10-22-task-attachment-split-view.md)
and [standalone reader](../../implemented/architecture/2026-10-22-task-attachment-full-reader.md). The existing
[pipeline decision](2026-10-21-web-acceptance-pipeline.md) continues to own stage
scheduling, permissions, isolated capacity timing and interrupted-run recovery.
The [Web delivery note](../feature/2026-10-21-task-attachment-web.md) retains
component, fixture and focus decisions; its local mockup observations remain
separate evidence.

The Go `installed_cli_task_attachment_workflow` reuses the existing packed and
installed CLI, actual process fixture and isolated PG schema/root. It compares
text, empty and multi-chunk binary contents above 1 MiB, including invalid UTF-8
and NUL; covers nested/special paths, distinct-directory basenames, overwrite
metadata, complete path pagination above 100 entries, tree/text output and
deletion. Refusals retain actual server request IDs. A normal missing-content
failure remains an error. The complete task resource stays unchanged, and
process restart reuses the same root before metadata and byte comparisons.

The scenario records `attachmentFiles` as path/sizeBytes/SHA-256,
`attachmentsListed`, `attachmentPageRequests` and correlated refusal IDs without
storing file bodies. All actual-process fixture cleanup now requires
`storageRootRemoved`, set only after removing its owned root and confirming
absence. Original process, schema, session and CLI reaping gates and capture,
request and watchdog bounds remain unchanged.

A full Web acceptance run prepares one installation through the
[shared installed-CLI fixture](../../../../packages/daynight/test/fixtures/installed-cli.ts)
and reuses it for native and production-container browser phases. The production
Docker build copies Web sources and the CLI manifest, not the CLI test tree. Web
therefore owns the persisted receipt DTO and a narrow factory/result type; only
native preparation dynamically imports the existing CLI fixture by file URL and
requires its expected factory export. The CLI producer remains typechecked by
its own module, while Web validates the resulting receipt at runtime. Static
imports must not pull the omitted CLI test/dependency graph into the production
Web build, and missing exports fail rather than selecting another installer.
The [task-attachments scenario](../../../../packages/daynight-web/tests/e2e/attachments.spec.ts)
uploads with that CLI and opens the same task/files
in the production page; Web mutations are checked with raw CLI reads. It covers
original binary downloads, single-file mutations, directory paths, Markdown
relative images, image/text/PDF and HTML relative styles/scripts/data behavior.
The same journey covers detail tabs and retained file state, adjacent pane
geometry, preview scroll owners and real new-tab opening/direct reload without
originating-dialog state.
The graph scenarios and the later `project-view-tabs` scenario keep GET/HEAD-only
browser checks except for one exact registered fixture-file PUT in
`refresh-staleness`. The
[quiet-detail decision](../../implemented/bug-fix/2026-10-23-quiet-task-detail-refresh.md)
holds its real response across automatic reads to check retained pending work. Exact
fixture-scoped file PUT/DELETE requests are admitted by the attachment scenario
and the later `language-state-preservation` scenario, which verifies pending
writes across language changes. Every unrelated mutation remains a failure.

The attachment delivery expanded each target to nine functional scenarios. The
later [task view decision](../../implemented/feature/2026-10-22-project-task-views.md) adds
`project-view-tabs`, expanding each target to ten. The
[complete context decision](../../implemented/feature/2026-10-22-complete-prerequisite-context.md)
adds a dense-external capacity graph; native capacity preserves its four original
scenarios and all timing/geometry gates. The
[bilingual interface decision](../../implemented/feature/2026-10-22-web-bilingual-interface.md)
adds three functional language scenarios per target. Those deliveries produced
18 unique native scenarios and thirteen container scenarios. The
[authentication activation](../../implemented/architecture/2026-10-22-authentication-activation.md)
adds six functional scenarios per target and normal protocol bootstrap. The
[Markdown description delivery](../../implemented/architecture/2026-10-22-task-description-markdown.md)
adds one read-only browser journey per target. The later
[approval lifecycle](../../implemented/feature/2026-10-22-task-approval-lifecycle.md) adds three
approval journeys with separate registered-task POST allowances. Current strict
inventories include the later task-unapproval scenario and require 29 unique
native and twenty-four container scenarios. One worker,
zero retries, complete reports and cleanup remain mandatory.

All phases use the full bundled Chromium channel `chromium`, retaining the
pinned Playwright version and matching native/container browser identity. PDF
acceptance polls actual iframe compositor screenshots for a substantial
fixture-specific colored rectangle. The existing browser decodes the PNG,
groups pixels matching RGB `(17, 203, 149)` within a per-channel tolerance of 4
and alpha at least 250 into connected components, then measures each solid
marker independently. A main-page candidate must extend into the screenshot's
right half (`bounds.right >= width / 2`); the largest such component must contain
at least 1,600 matching pixels, span at least 80px by 20px and have density at
least 0.95 within its bounds. The fixture's 360-by-220 PDF page has a horizontally
centered 290-by-70 marker at `(35, 35)`. In the pinned native viewer, that page
marker reaches the frame's right half while left-side thumbnail markers do not.
This fixture/viewer location rule rejects thumbnail-only paint even when its
size and density meet the thresholds. Independent bounds also prevent a separate
thumbnail from diluting the page marker's density. The location assumption must
be revalidated when the fixture or viewer layout changes. The successful
screenshot and component metrics identify the expected PDF hash and preview URL
in `task-attachments-pdf.png` and `task-attachments-pdf.json`; the main UI capture
is `task-attachments.png`. MIME success, load, a fixed delay or an empty outer
MIME document cannot satisfy the pixel oracle.
The paint oracle avoids depending on PDF viewer extension IDs, internal plugin
APIs or browser-specific text-layer DOM.

Independent reading acceptance uses a fresh evaluator and production-built Web
assets served by the actual Go application, with real service files and isolated
storage/database resources. It retains the strict native functional, container
functional and native capacity pipeline, zero retries, coverage, timeouts and
cleanup gates. Frontend-only fixtures and implementation self-reports remain
separate from the independent verdict.

The reading matrix covers the prescribed desktop, tablet, narrow and short
viewports in both languages. Geometry checks inspect actual client/scroll sizes
through the document and ancestor chain, then exercise wheel and keyboard input.
Markdown, text, images and HTML must reach their document end; fitting content
must not expose an extra scrollbar. Keyboard-only Tab navigation must reach the
scrollable body, and left-pane scrolling must preserve the right reading
position. Real new-tab navigation, standalone reload, relative resources,
unsupported-file download and normal standalone keys remain part of the same
reading proof.

Native multi-page PDF acceptance enters the actual plugin through real keyboard
navigation from the dialog actions. Wheel input and Home/PageDown/End must move
that reader, reach the end and visibly paint a unique final-page footer. The
same proof applies to standalone reading. Private viewer DOM may supply
read-only offset diagnostics; it never drives focus or scrolling and does not
replace input plus compositor evidence. A painted first page or a changing
wrapper offset alone cannot prove that the final document page is reachable.

Failure probes synchronize request timing without replacing responses. An
unavailable owned metadata table produces an actual later-page 500 after an
earlier successful page, preserving the incomplete-list state and retry. An
actual stored file made temporarily unavailable produces preview 404 and
restoration/retry. A held PUT exposes busy controls, then an actual database
failure must preserve the upload form before retry. Missing-file recovery,
delayed responses and unchanged task version/graph remain observable checks.
Fault restoration and confirmed removal of all owned browser, service, database
and storage resources are required.

Runtime measurements, hashes and probe histories remain source-bound artifacts
under the
[validation evidence decision](../process/2026-10-20-source-bound-validation-evidence.md),
not rolling Markdown snapshots. Independent runtime acceptance is complete
within its observed environment; a local browser override establishes no
hosted-CI browser result. An immutable
[source-qualified evidence selection](../../../../docs/research/evidence/daynight-attachment-reading-ad16d6f.json)
retains the [narrow split view](../../../../docs/research/assets/daynight-attachment-reading-ad16d6f-320.png),
[short-viewport split view](../../../../docs/research/assets/daynight-attachment-reading-ad16d6f-844.png)
and [native final-page footer](../../../../docs/research/assets/daynight-attachment-reading-ad16d6f-pdf-end.png)
from the [accepted production source](https://github.com/codetreker/daynight/tree/ad16d6f9e5c4c081b038d18fa243e77683bf6bc3).
These unedited captures and their original probe qualifications preserve the
lasting scroll/native-reader evidence.

Installed-package handoff validates the receipt's Git SHA, required
source.gitTreeSha and dirty state, and recomputes tarball/entry hashes. The
[lifecycle cross-layer extension](../../implemented/testing/2026-10-22-task-lifecycle-cross-layer-acceptance.md)
uses the same handoff for same-data lifecycle journeys and installed instruction
artifacts. The tree identifies committed contents; the dirty boolean is not a
digest of modified source contents. CI still requires a clean checkout at GITHUB_SHA; local dirty
receipts identify their artifacts and observed environment without claiming an
exact modified-source fingerprint. Original binary bytes are captured without
UTF-8 conversion, and CLI child/process-group ownership joins existing browser,
server, database and deployment cleanup evidence.

The single `evidence.installedCli` record contains `root`, `cleanup` and optional
`receiptPath`/`receipt`. The runner persists the deterministic
`<acceptanceRun>/installed-cli` root before invoking the factory. The shared
fixture creates that directory exclusively; an existing directory is an error
and remains untouched. Completed receipt fields are recorded only after package
preparation succeeds, so interrupted preparation still has an attributable root.

Normal cleanup and recovery first require the recorded preparation commands and
groups to have stopped. Existing completed artifacts also require source/artifact
validation, and completed installations require owned CLI process cleanup. They remove the exact recorded root
and persist `cleanup: passed` into the original evidence before remaining
native/Docker cleanup. A partial installation needs no completed package receipt
to establish that root's ownership. Recovery can therefore repeat after partial
preparation or a later Docker failure; a live preparation command retains the
root and causes refusal. Updating cleanup state preserves the original test
outcome and uses no separate preparation journal. Credential-bearing CLI homes
now live in the run's private sibling root rather than the uploaded installation
receipt tree; the installation artifacts and hashes retain their original owner.
Session/PAT bootstrap uses normal UniAuth, and cleanup/recovery removes those
private homes after their CLI processes stop. The
[combined authentication decision](../../implemented/testing/2026-10-23-authentication-combined-acceptance.md)
reuses this validated installation through an explicit receipt path for its
native/container journeys; source, parent receipt and artifact hash checks keep
their force. It adds original-credential restart and admitted-transfer revocation
proof without replacing the attachment byte/restore results or the current
Playwright inventory. The activation decision owns private fixture metadata and
the disabled credential-bearing browser trace; compositor/PNG and custom CDP
evidence keep their existing validation rules.

The Ubuntu web job invokes the existing
[real-container attachment check](../../../../deployment/dev-ci/tests/attachments.mts)
once after the browser pipeline and recorded recovery. This preserves capacity
isolation and independently checks volume recreation, two-project isolation,
nonroot writes and paired backup/restore. Its `.tmp/attachment-deployment-*/`
receipts are archived with deployment/browser evidence. The shared installed-CLI
fixture now selects CLI, Go and Web CI consumers under the
[module routing decision](../process/2026-10-21-module-scoped-pr-ci.md).

## Alternatives

**Treat independently passing component and deployment tests as combined proof.**
They do not establish that both clients observed the same task and original
bytes. Native and container journeys explicitly cross the installed CLI and
production page against one target's real data.

**Accept PDF HTTP success, iframe load or a screenshot without assertions.**
Those observations can describe a blank or failed viewer. A distinctive painted
marker makes expected document content an automatic assertion; a first-page
marker alone still cannot establish reading to the document end. Real input and
a unique final-page marker provide that additional proof. Viewer-internal state
alone would tie the verdict to browser implementation details, so private DOM
is restricted to read-only diagnostics rather than behavioral control or proof.

**Statically import CLI test fixture types into Web.** That makes the production
Web build depend on source and dependencies deliberately absent from its Docker
context. A Web-owned persisted DTO plus a dynamically loaded, validated factory
keeps test orchestration at preparation time without enlarging the product build.

**Install another CLI for each browser phase.** That repeats package preparation
and permits different artifacts between targets. One installation and validated
receipt per full run make the shared artifact explicit while preserving each
target's independent service data and resource ownership.

## Consequences

The acceptance inventory grows by one functional journey per target without
removing graph, coverage, capacity, native CLI or deployment checks. Cleanup
must prove owned storage roots and installed CLI processes/groups are gone,
including failure and cancellation paths. A successful child exit alone remains
insufficient evidence.

Painted-PDF proof requires the full browser channel; the recorded executable
identity must match the run's selected environment. Pixel evidence proves the
fixture page painted under those conditions, without asserting arbitrary PDF
compatibility. Independent reading proof also establishes real-input access to
the fixture's final page, not arbitrary viewer or document compatibility. CI and
local receipts retain their own source/environment limits; source inspection
cannot substitute for successfully validated run receipts.

K1 stays recorded only. Ordinary storage/PG/transfer failures remain visible,
but cross-store rollback, compensation, reconciliation and recovery are not
implemented or added as acceptance gates. Trusted HTML still executes with the
application origin's privileges.
