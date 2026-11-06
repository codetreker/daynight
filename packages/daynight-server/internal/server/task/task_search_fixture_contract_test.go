package task_test

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

// This end-to-end fixture uses the public routes and real PostgreSQL. The
// optional capture directory saves the exact responses for downstream consumers.
func TestTaskSearchHTTPContract(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	project := taskProject(t, handler)
	root := createHTTPTask(t, handler, project.ID, "Goal")
	first := createHTTPTask(t, handler, project.ID, "Cache title", root.ID)
	second := createHTTPTask(t, handler, project.ID, "Other")
	second = updateHTTPTask(t, handler, second, map[string]any{"description": "raw **cache** markdown"})
	path := taskCollection(project.ID) + "/search"
	capture := func(name string, body []byte) {
		if dir := os.Getenv("DAYNIGHT_SEARCH_FIXTURE_CAPTURE"); dir != "" {
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, name+".json"), body, 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	response := projectRequest(handler, "POST", path, `{"query":"cache","limit":1}`)
	page := decodeResponse[api.TaskSearchPage](t, response, 200)
	capture("first-page", response.Body.Bytes())
	if page.ProjectID != project.ID || page.Total != 2 || len(page.Items) != 1 || page.Items[0].ID != first.ID || page.NextCursor == nil || page.Items[0].Context == nil || page.Items[0].Context.TaskID != root.ID {
		t.Fatalf("unexpected first page: %+v", page)
	}
	response = projectRequest(handler, "POST", path, jsonBody(t, map[string]any{"query": "cache", "limit": 1, "cursor": *page.NextCursor}))
	next := decodeResponse[api.TaskSearchPage](t, response, 200)
	capture("next-page", response.Body.Bytes())
	if next.Total != 2 || len(next.Items) != 1 || next.Items[0].ID != second.ID || next.NextCursor != nil || next.Items[0].Match.DescriptionSnippet == nil {
		t.Fatalf("unexpected next page: %+v", next)
	}
	response = projectRequest(handler, "POST", path, `{"query":"no-such-term"}`)
	empty := decodeResponse[api.TaskSearchPage](t, response, 200)
	capture("empty-page", response.Body.Bytes())
	if empty.Total != 0 || len(empty.Items) != 0 || empty.NextCursor != nil {
		t.Fatalf("unexpected empty page: %+v", empty)
	}
	response = projectRequest(handler, "POST", path, `{"query":"缓存 AND ("}`)
	assertProjectError(t, response, 400, "invalid_search_expression")
	capture("invalid-expression", response.Body.Bytes())
	var syntax api.ErrorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &syntax); err != nil || syntax.Error.Details == nil || syntax.Error.Details.Reason == nil || *syntax.Error.Details.Reason != "unclosed_group" {
		t.Fatalf("syntax response: %s (%v)", response.Body.String(), err)
	}
	cases := []struct {
		input, reason    string
		position, length int
	}{
		{"  ", "empty_query", 1, 0}, {"中文 AND", "expected_operand", 7, 0},
		{`x"y"`, "unexpected_token", 2, 3}, {"中文 )", "unexpected_closing_group", 4, 1},
		{"中文 (x", "unclosed_group", 4, 1}, {`中文 "x`, "unclosed_quote", 4, 1},
		{`中文 ""`, "empty_phrase", 4, 2}, {`中文 "a\qb"`, "invalid_escape", 6, 2},
		{"中文 status:done", "unknown_field", 4, 6}, {"title:", "missing_field_value", 7, 0},
		{"title:(x)", "field_group_not_supported", 7, 1},
		{strings.Repeat("a", 8193), "query_too_large", 8193, 1},
		{strings.Repeat("a ", 128) + "b", "too_many_terms", 257, 1},
		{strings.Repeat("(", 33) + "x" + strings.Repeat(")", 33), "nesting_too_deep", 33, 1},
	}
	for _, tc := range cases {
		response = projectRequest(handler, "POST", path, jsonBody(t, map[string]any{"query": tc.input}))
		assertProjectError(t, response, 400, "invalid_search_expression")
		var result api.ErrorResponse
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		d := result.Error.Details
		if d == nil || d.Reason == nil || d.Position == nil || d.Length == nil || *d.Reason != tc.reason || *d.Position != tc.position || *d.Length != tc.length {
			t.Fatalf("%s: %s", tc.reason, response.Body.String())
		}
		capture("syntax-"+tc.reason, response.Body.Bytes())
		fixture, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "task-search", "syntax-"+tc.reason+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var saved api.ErrorResponse
		if err := json.Unmarshal(fixture, &saved); err != nil {
			t.Fatal(err)
		}
		sd := saved.Error.Details
		if saved.Error.Code != result.Error.Code || sd == nil || sd.Reason == nil || sd.Position == nil || sd.Length == nil || *sd.Reason != tc.reason || *sd.Position != tc.position || *sd.Length != tc.length {
			t.Fatalf("fixture %s does not match the HTTP contract", tc.reason)
		}
	}
	response = projectRequest(handler, "POST", path, `{"query":"cache","limit":0}`)
	assertProjectError(t, response, 400, "invalid_input")
	capture("invalid-input", response.Body.Bytes())
	updateHTTPTask(t, handler, second, map[string]any{"description": "cache changed"})
	response = projectRequest(handler, "POST", path, jsonBody(t, map[string]any{"query": "cache", "limit": 1, "cursor": *page.NextCursor}))
	assertProjectError(t, response, 409, "search_changed")
	capture("search-changed", response.Body.Bytes())
	if strings.Contains(response.Body.String(), *page.NextCursor) {
		t.Fatal("response leaked cursor")
	}
}
