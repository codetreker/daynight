# Agent Note: Recent Task Browsing and Pagination

Status: implemented

## Problem

Hiding every completed outcome removes recent results as soon as work finishes.
The overview and task lists then disagree about which work belongs to the current
period, while long inventories make locating a particular Goal increasingly
costly. A display limit must preserve complete Goal membership and direct
navigation from overview progress into task browsing.

## Decision

Overview and both task-list categories share one recent projection of the
complete project index. Every unfinished item remains visible regardless of age.
Known completions remain for today and the previous six dates in the browser's
local time zone, with an inclusive midnight boundary. Calendar arithmetic keeps
those seven dates stable across daylight-saving changes. Live current time uses
the server observation plus monotonic elapsed time; local summary previews keep
their provisional client-time basis until synchronization. A project-owned
deadline recalculates both sections at local midnight and on visibility recovery.

A Goal is complete only when all ordinary-component members are done. Its latest
member completion determines recency; the representative and external
prerequisites cannot substitute for that member set. A known recent completion
proves the fully done Goal is recent even when older historical members have
unknown times. Without that evidence it stays available through Show all, and no
creation or update time is synthesized as a completion time. Retained Goals show
all children, including older completed children, and keep complete progress.

Each task category's existing completion preference now labels its checkbox
Show all and switches between the shared recent subset and its full history.
The existing boolean record remains independent per project and category.
Overview always uses the recent subset; recent all-done Goals and the standalone
aggregate remain visible at 100%. The six project statistic cards retain full
history. The [overview progress decision](2026-10-26-project-overview-progress.md)
records why standalone progress has a recent denominator and why navigation uses
a task witness. This decision replaces its rolling-duration window and
unfinished-only row policy.

All three lists page their filtered sequence in groups of 20 top-level entries.
A Goal counts once and keeps its complete child list; the final standalone
aggregate counts once across the entire Overview sequence. Independent page
state survives ordinary view switches within a project visit, resets to page one
when its filter changes, and clamps when results shrink. `usePagination` owns
this lifecycle and the valid ranges used by list renderers to slice their
sequences; `ListPagination` renders the localized range, total and previous/next
controls only for multiple pages. Page numbers do not add
browser storage or change synchronization pagination.

Overview navigation resolves the latest representative in the complete filtered
sequence, selects its task-list page, and consumes the request only after the
target is mounted and focused. The standalone aggregate targets page one of
Standalone tasks. Explicit navigation overrides saved scroll once. Existing
detail, full-index and graph owners remain intact; a graph whose list entry
becomes off-page closes through the existing unavailable-entry behavior.

The [task view decision](2026-10-22-project-task-views.md),
[Goal list decision](2026-10-26-goal-task-lists.md), and
[project section decision](2026-10-25-project-overview-task-sections.md) retain
classification, complete children and section lifetimes. Observable behavior
belongs in the [Web requirements](../../../../docs/spec/daynight-web.md), and
composition belongs in the [Web design](../../../../docs/design/daynight-web.md).

## Alternatives

**Keep a rolling 168-hour completion window.** This makes an item expire at its
individual completion time, so two completions on the same local date disappear
at different times. Calendar dates express the required local-day period and
supply one shared midnight boundary.

**Keep fully completed Goals hidden.** That retains the earlier focus on
unfinished work but loses a recently finished outcome immediately. Recent
whole-Goal retention makes completion visible without retaining every historical
Goal by default.

**Paginate individual tasks before deriving Goals.** A page can then omit members
needed for aggregate status, progress or graph context, and one Goal can split
across pages. Slicing the completed display projection preserves those existing
structural guarantees without changing service or cache contracts.

## Consequences

Recent completion remains visible across the overview and both task categories.
Different browser time zones can legitimately classify the same timestamp on
different calendar dates. Unknown historical facts remain accessible explicitly
without being represented as known recent work.

A page bounds top-level rows rather than total mounted child rows. A single
expanded Goal can still be long; its complete task list is a deliberate browsing
contract. Full project synchronization and graph limits retain their existing
capacity costs. Adding remote inventory pagination later requires preserving
complete membership and classification rather than reusing the display slice as
a domain graph.

Page changes can unmount rows, so row-local disclosure follows its existing
reset-on-unmount lifetime. Page retention is limited to the project visit; saved
category, Show all and scroll preferences preserve their established shapes.
Cross-page focus and expiry without new data require behavioral validation in
addition to isolated range calculations.
