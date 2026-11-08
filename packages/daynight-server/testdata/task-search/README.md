# Task search HTTP fixtures

These are response bodies captured from the search HTTP handler. `first-page`,
`next-page`, `empty-page`, `invalid-expression`, `invalid-input`, and
`search-changed` and all `syntax-*` reasons come from `TestTaskSearchHTTPContract` against isolated
PostgreSQL 18.6. The test creates a Goal, its title-matching child, and an
independent description match; it requests one result per page and updates the
second task before reusing the cursor. Set `DAYNIGHT_SEARCH_FIXTURE_CAPTURE` to
a temporary directory when running the test to capture a new run.

`context-limit` and `timeout` were captured through the HTTP handler using
controlled snapshot and deadline failures. They illustrate the error response;
their counts and request IDs are observations from that test. The captured cursor
is opaque and belongs to the original database snapshot and identity, so it is
not a reusable credential or a continuation for another test run.
