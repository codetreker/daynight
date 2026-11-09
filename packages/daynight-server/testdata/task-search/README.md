# Task search HTTP fixtures

These response bodies are captured from the search HTTP handler with a mocked
search operation. `TestTaskSearchHTTPContract` captures pagination, empty,
syntax, invalid-input and search-changed responses. `TestTaskSearchIDFixtureContract`
captures `id-only` and `mixed-fields`, including the raw query and field order.
Set `DAYNIGHT_SEARCH_FIXTURE_CAPTURE` to an absolute temporary directory when
running these tests to capture their responses.

`context-limit` and `timeout` illustrate controlled error responses. Request IDs
are observations from capture. The pagination cursor is an opaque sample and is
not a reusable continuation for a different request or server version.
