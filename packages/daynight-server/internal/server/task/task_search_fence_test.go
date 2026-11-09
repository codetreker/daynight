package task_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
)

func TestSearchHTTPFenceFailureAndAccessMapping(t *testing.T) {
	cursor := "private-opaque-cursor"
	for _, tc := range []struct {
		name, code string
		status     int
	}{{"changed", "search_changed", 409}, {"revoked", "forbidden", 403}, {"missing", "not_found", 404}} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Search = func(ctx context.Context, p model.Principal, pid string, input tasksearch.Request) (tasksearch.Page, error) {
				if pid != testProjectID || p != h.principal || input.Query != "match" || input.Limit != 1 || input.Cursor == nil || *input.Cursor != cursor {
					t.Fatalf("cursor input=%+v", input)
				}
				return tasksearch.Page{}, &model.Fault{Code: tc.code, Message: "Search cannot continue."}
			}
			response := projectRequest(h, http.MethodPost, taskCollection(testProjectID)+"/search", jsonBody(t, map[string]any{"query": "match", "limit": 1, "cursor": cursor}))
			assertProjectError(t, response, tc.status, tc.code)
			if strings.Contains(response.Body.String(), cursor) {
				t.Fatal("refusal exposed cursor")
			}
		})
	}
	h := newHTTPFixture(t, io.Discard)
	h.Search = func(ctx context.Context, p model.Principal, pid string, input tasksearch.Request) (tasksearch.Page, error) {
		if input.Cursor == nil || *input.Cursor != cursor {
			t.Fatalf("continuation input=%+v", input)
		}
		return tasksearch.Page{ProjectID: pid, Items: []tasksearch.Item{}, Total: 0}, nil
	}
	result := decodeResponse[api.TaskSearchPage](t, projectRequest(h, http.MethodPost, taskCollection(testProjectID)+"/search", jsonBody(t, map[string]any{"query": "match", "limit": 1, "cursor": cursor})), 200)
	if result.Items == nil || result.NextCursor != nil || result.Total != 0 {
		t.Fatalf("continued=%+v", result)
	}
}
