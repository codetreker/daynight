package query

import (
	"encoding/base64"
	"encoding/json"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
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
				version = 3
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

func TestCursorEncodedBoundBeforeDecode(t *testing.T) {
	id := "f47ac10b-58cc-11cf-a447-001122334455"
	scope := store.ProjectScope{Kind: store.ProjectScopeAll}
	listScope := ListScope{Kind: "teams", UserID: id}
	list, err := EncodeListCursor(listScope, time.Now(), id)
	if err != nil {
		t.Fatal(err)
	}
	project, err := EncodeProjectCursor(model.Project{ID: id, CreatedAt: time.Now()}, id, scope)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, encoded string
		parse         func(string) error
	}{
		{"list", list, func(s string) error {
			_, err := ListPage(model.PageRequest{Limit: 1, Cursor: &s}, listScope)
			return err
		}},
		{"project", project, func(s string) error {
			_, err := ProjectListPage(model.PageRequest{Limit: 1, Cursor: &s}, id, scope)
			return err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := base64.RawURLEncoding.DecodeString(tc.encoded)
			if err != nil {
				t.Fatal(err)
			}
			raw = append(raw, []byte(strings.Repeat(" ", transport.MaxEncodedCursorBytes*3/4-len(raw)))...)
			boundary := base64.RawURLEncoding.EncodeToString(raw)
			if len(boundary) != transport.MaxEncodedCursorBytes {
				t.Fatal("bad fixture")
			}
			if err := tc.parse(boundary); err != nil {
				t.Fatalf("boundary rejected: %v", err)
			}
			if err := tc.parse(boundary + "A"); err == nil {
				t.Fatal("accepted oversized cursor")
			}
			oversized := strings.Repeat("A", 1<<20)
			var before, after runtime.MemStats
			runtime.ReadMemStats(&before)
			_ = tc.parse(oversized)
			runtime.ReadMemStats(&after)
			if used := after.TotalAlloc - before.TotalAlloc; used > 64<<10 {
				t.Fatalf("oversized cursor allocated %d bytes", used)
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
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(decoded, &fields); err != nil || fields["version"] != float64(2) || fields["kind"] != "scoped-projects" {
		t.Fatalf("Project cursor version or kind: %#v %v", fields, err)
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

func TestTaskListCursorBindsPlatformSpecificTier(t *testing.T) {
	id := "f47ac10b-58cc-11cf-a447-001122334455"
	when := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	yes, no := true, false
	for _, tier := range []*bool{nil, &no, &yes} {
		scope := ListScope{Kind: "tasks", ProjectID: id, PlatformSpecific: tier}
		encoded, err := EncodeListCursor(scope, when, id)
		if err != nil {
			t.Fatal(err)
		}
		for _, nextTier := range []*bool{nil, &no, &yes} {
			next := scope
			next.PlatformSpecific = nextTier
			page, err := ListPage(model.PageRequest{Limit: 1, Cursor: &encoded}, next)
			if model.EqualOptional(tier, nextTier) {
				if err != nil || page.After == nil || page.After.ID != id || !page.After.CreatedAt.Equal(when) {
					t.Fatalf("same tier page=%#v err=%v", page, err)
				}
			} else if err == nil {
				t.Fatal("accepted cursor from another platform tier")
			}
		}
	}
}
