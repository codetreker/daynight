package query

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestListCursorBindingAndFormat(t *testing.T) {
	id := "f47ac10b-58cc-11cf-a447-001122334455"
	when := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	scopes := []ListScope{
		{Kind: "teams", UserID: id},
		{Kind: "workers", WorkerUserID: &id},
		{Kind: "bots", WorkerUserID: &id, WorkerID: &id},
		{Kind: "tasks", ProjectID: id, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: id}},
	}
	for _, scope := range scopes {
		t.Run(scope.Kind, func(t *testing.T) {
			encoded, err := EncodeListCursor(scope, when, id)
			if err != nil {
				t.Fatal(err)
			}
			page, err := ListPage(model.PageRequest{Limit: 5, Cursor: &encoded}, scope)
			if err != nil || page.After == nil || page.After.ID != id || !page.After.CreatedAt.Equal(when) {
				t.Fatalf("page = %#v, %v", page, err)
			}
			decoded, err := base64.RawURLEncoding.DecodeString(encoded)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]any
			if err := json.Unmarshal(decoded, &fields); err != nil {
				t.Fatal(err)
			}
			version := float64(1)
			if scope.Kind == "tasks" {
				version = 2
			}
			if fields["version"] != version {
				t.Fatalf("version = %v", fields["version"])
			}
			changed := scope
			changed.Kind += "-different"
			if _, err := ListPage(model.PageRequest{Limit: 5, Cursor: &encoded}, changed); err == nil {
				t.Fatal("accepted different scope")
			}
			if scope.Kind == "tasks" {
				changed = scope
				changed.AssignedTo = model.TaskAssignmentFilter{Mode: model.TaskAssignmentUnassigned}
				if _, err := ListPage(model.PageRequest{Limit: 5, Cursor: &encoded}, changed); err == nil {
					t.Fatal("accepted different assignment")
				}
			}
			for _, raw := range []string{encoded + "=", base64.RawURLEncoding.EncodeToString(append(decoded, []byte(" {}")...)), base64.RawURLEncoding.EncodeToString([]byte(strings.TrimSuffix(string(decoded), "}") + `,"unknown":true}`))} {
				if _, err := ListPage(model.PageRequest{Limit: 5, Cursor: &raw}, scope); err == nil {
					t.Fatalf("accepted invalid cursor %q", raw)
				}
			}
		})
	}
}

func TestProjectCursorScopeAndPrincipal(t *testing.T) {
	id := "f47ac10b-58cc-11cf-a447-001122334455"
	scope := store.ProjectScope{Kind: store.ProjectScopeAll}
	encoded, err := EncodeProjectCursor(model.Project{ID: id, CreatedAt: time.Now().UTC()}, id, scope)
	if err != nil {
		t.Fatal(err)
	}
	req := model.PageRequest{Limit: 5, Cursor: &encoded}
	if _, err := ProjectListPage(req, id, scope); err != nil {
		t.Fatal(err)
	}
	if _, err := ProjectListPage(req, "different", scope); err == nil {
		t.Fatal("accepted different principal")
	}
	if _, err := ProjectListPage(req, id, store.ProjectScope{Kind: store.ProjectScopeShared}); err == nil {
		t.Fatal("accepted different scope")
	}
	if _, err := ListPage(req, ListScope{Kind: "teams", UserID: id}); err == nil {
		t.Fatal("accepted project cursor as list cursor")
	}
}
