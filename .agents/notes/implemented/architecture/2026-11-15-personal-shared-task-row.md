# Agent Note: Personal list uses the shared Task row

Status: implemented

## Problem

The account-wide in-progress list and project Task lists describe the same
ordinary Task through different row implementations. They can disagree about
fields, Worker history, Session freshness and available actions. Account-wide
pages also need an assignee identity before any project has been opened, and
items received on different cursor pages have different response clock anchors.
The full personal Session response does not itself contain every source fact
needed to derive project-row state and independent reading eligibility.

## Decision

The personal list maps its validated account projection to the list-independent
model and row owned by the [shared Task row decision](2026-11-15-shared-project-task-row.md).
Its adapter supplies the selected Task facts, retained active or completed Worker
record and normalized current Session. Only the personal list supplies an
additional link to the Task's actual Parent Goal. List traversal, project grouping,
counts, pagination, reading history and access isolation remain with their
existing owners.

The authenticated account projection includes ID, name and avatar URL from the
same verified `session.user`. The personal list checks the account against its
request and response principal before mapping the assignee and uses the same
presentational identity as project rows. It needs no project member receipt or
extra identity request.

The personal response supplies required `sessionRow`, derived by the same server
rules as project TaskSync from the same Engine sample, alongside the existing
full Session. Source and Task-version rechecks fence both projections; the client
does not reconstruct missing reading facts or invent a claim ID in its
lightweight Worker record. Both list clients apply one pure display normalization
for freshness, warning grace and independent readability. Each personal item
retains its own database and Engine response clocks and monotonic body receipt.
A per-item execution clock input prevents later cursor pages from borrowing the
first page's time; the underlying tick subscription remains shared.

The [personal startup grace decision](../bug-fix/2026-11-14-personal-session-startup-grace.md)
introduced the two-minute warning window when the personal list had a private
presentation. The shared display extends the same rule across ordinary Task
rows and preserves a separately confirmed, unexpired Session entry during that
window. The [Web design](../../../../docs/design/daynight-web.md#我的进行中任务)
and [Session design](../../../../docs/design/task-session-status.md) own the
mechanisms and observable conditions.

## Alternatives

**Keep personal markup and copy the shared fields.** Separate markup would retain
independent navigation, copy and Session rules, so equivalent Task facts could
diverge again. The complete account projection supplies the shared model's
required facts.

**Derive all row state from the existing full Session response.** That response
does not carry every archive and live-readability fact used by the server's
project projection. Inferring eligibility would give equivalent sources different
meaning or create a reading entry without evidence. A projection from the same
sample preserves source semantics without another Session read.

**Use a project assignee receipt for personal rows.** An account can open its
personal overview before opening any project. Requiring project receipts would
delay or omit a known authenticated identity and add reads with another lifecycle.

**Use one project-group clock anchor.** A project can span cursor pages, and its
items can arrive after different sampling and processing delays. The first
item's anchor would alter later items' elapsed times and freshness boundaries.

## Consequences

All ordinary Task list contexts share field presentation and actions while
preserving their own data admission and navigation. The shared row has an
optional Goal link supplied only by the personal owner. The personal API has an
additional required projection and strict producer/consumer validation; it adds
no per-row requests or runtime fallback. Clock estimates still include processing
and transport delay between server response anchors and body receipt.
