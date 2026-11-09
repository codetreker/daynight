package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func taskAssignmentFilterQuery(selector string) string {
	return "?limit=1&status=todo&ready=true&allowAgents=true&compatiblePlatform=linux&assignedTo=" + url.QueryEscape(selector)
}

func taskAssignmentHTTPQuery(target *string) store.TaskQuery {
	status, ready, allowed, platform := model.TaskTodo, true, true, model.PlatformLinux
	assigned := model.TaskAssignmentFilter{Mode: model.TaskAssignmentUnassigned}
	if target != nil {
		assigned = model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: *target}
	}
	return store.TaskQuery{AssignedTo: assigned, Page: store.Page{Limit: 1}, Status: &status, Ready: &ready, AllowAgents: &allowed, CompatiblePlatform: &platform}
}

func collectAssignmentHTTPPages(t *testing.T, f *taskHTTPFixture, collection, query string, expected *string, rows []model.Task) ([]string, *string) {
	t.Helper()
	var ids []string
	var firstCursor *string
	cursor := ""
	for index, row := range rows {
		selected := taskAssignmentHTTPQuery(expected)
		if index != 0 {
			selected.Page.After = &store.Position{CreatedAt: rows[index-1].CreatedAt, ID: rows[index-1].ID}
		}
		f.expectList([]store.TaskQuery{selected}, []store.TaskPage{{Items: []model.Task{row}, HasMore: index+1 < len(rows)}})
		path := collection + query
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		page := decodeResponse[api.TaskPage](t, projectRequest(f.handler, http.MethodGet, path, ""), http.StatusOK)
		if len(page.Items) != 1 || page.Items[0].ID != row.ID {
			t.Fatalf("Task page identity/count: %#v", page)
		}
		item := page.Items[0]
		if expected == nil && item.AssignedTo != nil || expected != nil && (item.AssignedTo == nil || *item.AssignedTo != *expected) {
			t.Fatalf("Task filter projection: %#v", item)
		}
		ids = append(ids, item.ID)
		if index+1 == len(rows) {
			if page.NextCursor != nil {
				t.Fatalf("final page has cursor: %#v", page)
			}
			break
		}
		if page.NextCursor == nil {
			t.Fatal("bounded page omitted continuation")
		}
		if firstCursor == nil {
			value := *page.NextCursor
			firstCursor = &value
		}
		cursor = *page.NextCursor
	}
	return ids, firstCursor
}

func TestTaskHTTPAssignedToFilteringPrecedesLimitAndBindsCursor(t *testing.T) {
	f := newTaskHTTPFixture(t)
	otherID := "c6666666-6666-4666-8666-666666666666"
	otherPrincipal := f.principal
	otherPrincipal.UserID = otherID
	other := newTaskHTTPFixtureForPrincipal(t, otherPrincipal)
	first, second, unassigned := f.target, f.target, f.target
	first.ID, second.ID, unassigned.ID = "d1111111-1111-4111-8111-111111111111", "d2222222-2222-4222-8222-222222222222", "d3333333-3333-4333-8333-333333333333"
	first.AllowAgents, second.AllowAgents, unassigned.AllowAgents = true, true, true
	first.RequiredPlatform = assignmentPlatformPointer(model.PlatformLinux)
	second.RequiredPlatform, unassigned.AssignedTo = nil, nil
	collection, query := taskCollection(f.project.ID), taskAssignmentFilterQuery("me")
	ids, cursor := collectAssignmentHTTPPages(t, f, collection, query, &f.principal.UserID, []model.Task{first, second})
	if !slices.Equal(ids, []string{first.ID, second.ID}) || cursor == nil {
		t.Fatalf("bounded assignment pages: %v %v", ids, cursor)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(*cursor)
	if err != nil {
		t.Fatal(err)
	}
	var cursorFields map[string]any
	if err := json.Unmarshal(decoded, &cursorFields); err != nil || cursorFields["version"] != float64(2) {
		t.Fatalf("Task cursor version: %s %v", decoded, err)
	}
	for _, selector := range []string{"unassigned", otherID} {
		assertProjectError(t, projectRequest(f.handler, http.MethodGet, collection+taskAssignmentFilterQuery(selector)+"&cursor="+url.QueryEscape(*cursor), ""), http.StatusBadRequest, "invalid_input")
	}
	withoutAssignment := "?limit=1&status=todo&ready=true&allowAgents=true&compatiblePlatform=linux&cursor=" + url.QueryEscape(*cursor)
	assertProjectError(t, projectRequest(f.handler, http.MethodGet, collection+withoutAssignment, ""), http.StatusBadRequest, "invalid_input")
	assertProjectError(t, projectRequest(other.handler, http.MethodGet, collection+query+"&cursor="+url.QueryEscape(*cursor), ""), http.StatusBadRequest, "invalid_input")
	sameQuery := taskAssignmentHTTPQuery(&f.principal.UserID)
	sameQuery.Page.After = &store.Position{CreatedAt: first.CreatedAt, ID: first.ID}
	f.expectList([]store.TaskQuery{sameQuery}, []store.TaskPage{{Items: []model.Task{second}}})
	same := decodeResponse[api.TaskPage](t, projectRequest(f.handler, http.MethodGet, collection+taskAssignmentFilterQuery(strings.ToUpper(f.principal.UserID))+"&cursor="+url.QueryEscape(*cursor), ""), http.StatusOK)
	if len(same.Items) != 1 || same.Items[0].ID != second.ID {
		t.Fatalf("me/explicit canonical cursor scope: %#v", same)
	}
	cursorFields["version"] = float64(1)
	old, err := json.Marshal(cursorFields)
	if err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, projectRequest(f.handler, http.MethodGet, collection+query+"&cursor="+url.QueryEscape(base64.RawURLEncoding.EncodeToString(old)), ""), http.StatusBadRequest, "invalid_input")
	ids, _ = collectAssignmentHTTPPages(t, f, collection, taskAssignmentFilterQuery("unassigned"), nil, []model.Task{unassigned})
	if !slices.Equal(ids, []string{unassigned.ID}) {
		t.Fatalf("unassigned filter: %v", ids)
	}
}

func TestTaskHTTPAssignedToStrictFiltersAndFormerTarget(t *testing.T) {
	f := newTaskHTTPFixture(t)
	former := "c7777777-7777-4777-8777-777777777777"
	target := f.target
	target.AssignedTo = &former
	collection := taskCollection(f.project.ID)
	for _, query := range []string{"assignedTo=", "assignedTo=null", "assignedTo=all", "assignedTo=invalid", "assignedTo=Me", "assignedTo=Unassigned", "assignedTo=true", "assignedTo=%xx", "assignedTo=%ff", "assignedTo=%00", "assignedTo=me&assignedTo=me", "assignedTo=me&assignedTo=unassigned", "AssignedTo=me", "assignedTo[]=me", "assignedTo=%20" + former, "assignedTo=" + former + "%20"} {
		assertProjectError(t, projectRequest(f.handler, http.MethodGet, collection+"?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
	selected := store.TaskQuery{AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: former}, Page: store.Page{Limit: 50}}
	f.expectList([]store.TaskQuery{selected}, []store.TaskPage{{Items: []model.Task{target}}})
	response := projectRequest(f.handler, http.MethodGet, collection+"?assignedTo="+strings.ToUpper(former), "")
	page := decodeResponse[api.TaskPage](t, response, http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].ID != target.ID || page.Items[0].AssignedTo == nil || *page.Items[0].AssignedTo != former {
		t.Fatalf("former target projection: %#v", page)
	}
	if response.Header().Get("Daynight-User-ID") != f.principal.UserID || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("filter lost admitted identity/cache policy")
	}
	unknown := uuid.NewString()
	selected.AssignedTo.UserID = unknown
	f.expectList([]store.TaskQuery{selected}, []store.TaskPage{{Items: []model.Task{}}})
	empty := decodeResponse[api.TaskPage](t, projectRequest(f.handler, http.MethodGet, collection+"?assignedTo="+unknown, ""), http.StatusOK)
	if empty.Items == nil || len(empty.Items) != 0 || empty.NextCursor != nil {
		t.Fatalf("unknown valid target empty page: %#v", empty)
	}
	selected.AssignedTo = model.TaskAssignmentFilter{}
	f.expectList([]store.TaskQuery{selected}, []store.TaskPage{{Items: []model.Task{target}}})
	all := decodeResponse[api.TaskPage](t, projectRequest(f.handler, http.MethodGet, collection, ""), http.StatusOK)
	if len(all.Items) != 1 || all.Items[0].ID != target.ID {
		t.Fatal("omitted selector changed default scope")
	}
}

func assignmentPlatformPointer(value model.TaskPlatform) *model.TaskPlatform { return &value }
