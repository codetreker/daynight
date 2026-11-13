# Agent Note: Project PR Workspace

Status: implemented

## Problem

Project members need to browse all retained pull requests without task graph failures blocking access or background reads moving the page they are reading. The workspace must retain navigation state without mixing Task identities, account data or unknown synchronization results.

## Decision

The Project has an independent, persistently mounted PR workspace with a six-item cursor list and the existing PR detail reader. Section types, preference and history decoders, responsive keyboard navigation and reading positions share the overview/tasks/prs/tags order. List and synchronization status use separate reads and errors, exact decimal revisions and request generations. Hidden workspaces cancel reads while retaining authorized in-memory selections.

Background reconciliation retains the initial upper bound and current page anchor. A separate first-page probe only announces records above the bound; explicit refresh establishes a new bound. The initial page uses the documented upper-plus-one next cursor, including its scope and query, to preserve its bound. Only this synthetic read's artificial previous cursor is suppressed. Navigation responses retain both server cursors regardless of the displayed page number: records re-entering the filter can create an earlier page within the retained bound. The [read design](../../../../docs/design/github-pr-reading.md) owns the protocol and lifecycle details.

## Alternatives

**Rebuild the workspace on every section change.** This loses filters, cursors and the detail reader's raw Markdown selection and reading position.

**Reread an unbounded first page during background checks.** Newly created records move the reader's existing page and can duplicate records across traversal.

**Use the Task cache for PR summaries.** TaskSync owns UUID Tasks and their dependency graph; adding PR numbers and synchronization facts would couple unrelated revisions and failure paths.

## Consequences

PR browsing remains available independently of task graph loading and errors. The activity timer and first-page probe add bounded reads only while the PR workspace is visible. Cursor pages remain observations of a changing collection, so page counts can change and a previously populated anchor can become empty. Pagination remains visible whenever either server cursor exists, preserving both previous-only and next-only escape paths independently of the displayed page number. PR state lives only for the current authenticated Project workspace, with no persistent PR cache.
