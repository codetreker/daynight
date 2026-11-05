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

func TestCursorLimitsAndAssignmentValidation(t *testing.T) {
	id := "f47ac10b-58cc-11cf-a447-001122334455"
	for _, limit := range []int{0, 101} {
		if _, err := ListPage(model.PageRequest{Limit: limit}, ListScope{}); err == nil {
			t.Fatalf("list accepted limit %d", limit)
		}
		if _, err := ProjectListPage(model.PageRequest{Limit: limit}, id, store.ProjectScope{}); err == nil {
			t.Fatalf("project list accepted limit %d", limit)
		}
	}
	if page, err := ListPage(model.PageRequest{Limit: 1}, ListScope{}); err != nil || page.Limit != 1 || page.After != nil {
		t.Fatalf("initial list page %#v %v", page, err)
	}
	if page, err := ProjectListPage(model.PageRequest{Limit: 100}, id, store.ProjectScope{}); err != nil || page.Limit != 100 || page.After != nil {
		t.Fatalf("initial project page %#v %v", page, err)
	}
	for _, test := range []struct {
		filter model.TaskAssignmentFilter
		want   string
	}{
		{model.TaskAssignmentFilter{}, "all"},
		{model.TaskAssignmentFilter{Mode: model.TaskAssignmentUnassigned}, "unassigned"},
		{model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: id}, "user:" + id},
	} {
		if got, err := TaskAssignmentScope(test.filter); err != nil || got != test.want {
			t.Fatalf("assignment = %q, %v", got, err)
		}
	}
	for _, filter := range []model.TaskAssignmentFilter{
		{Mode: model.TaskAssignmentAll, UserID: id},
		{Mode: model.TaskAssignmentUnassigned, UserID: id},
		{Mode: model.TaskAssignmentUser, UserID: "bad"},
		{Mode: model.TaskAssignmentUser, UserID: strings.ToUpper(id)},
		{Mode: "unknown"},
	} {
		if _, err := TaskAssignmentScope(filter); err == nil {
			t.Fatalf("accepted invalid assignment %#v", filter)
		}
		scope := ListScope{Kind: "tasks", AssignedTo: filter}
		if _, err := EncodeListCursor(scope, time.Now(), id); err == nil {
			t.Fatalf("encoded invalid assignment %#v", filter)
		}
		cursor, err := EncodeListCursor(ListScope{Kind: "tasks"}, time.Now(), id)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ListPage(model.PageRequest{Limit: 1, Cursor: &cursor}, scope); err == nil {
			t.Fatalf("accepted invalid assignment scope %#v", filter)
		}
	}
}

func TestProjectCursorRejectsMalformedInputAndEncodingFailure(t *testing.T) {
	id := "f47ac10b-58cc-11cf-a447-001122334455"
	scope := store.ProjectScope{Kind: store.ProjectScopeAll}
	for _, raw := range []string{"not base64", "e30=", base64.RawURLEncoding.EncodeToString([]byte(`{"unknown":1}`)), base64.RawURLEncoding.EncodeToString([]byte(`{} {}`))} {
		if _, err := ProjectListPage(model.PageRequest{Limit: 1, Cursor: &raw}, id, scope); err == nil {
			t.Fatalf("accepted malformed project cursor %q", raw)
		}
	}
	future := time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	if _, err := EncodeProjectCursor(model.Project{ID: id, CreatedAt: future}, id, scope); err == nil {
		t.Fatal("encoded an unrepresentable project timestamp")
	}
	if _, err := EncodeListCursor(ListScope{Kind: "teams"}, future, id); err == nil {
		t.Fatal("encoded an unrepresentable list timestamp")
	}
}
