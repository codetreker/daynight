package task_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func assignmentHTTPPointer(value string) *string { return &value }

func assertHTTPAssignment(t *testing.T, fields map[string]json.RawMessage, expected *string) {
	t.Helper()
	value, present := fields["assignedTo"]
	if !present {
		t.Fatalf("mandatory nullable assignedTo is absent: %s", fields)
	}
	var actual *string
	if err := json.Unmarshal(value, &actual); err != nil || !reflect.DeepEqual(actual, expected) {
		t.Fatalf("assignedTo=%s want %v: %v", value, expected, err)
	}
	if expected == nil && !bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		t.Fatalf("unassigned resource is not explicit null: %s", value)
	}
}

func assertHTTPAssignmentResources(t *testing.T, body []byte, collection string, expected map[string]*string) {
	t.Helper()
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatal(err)
	}
	var resources []map[string]json.RawMessage
	if collection == "" {
		resources = []map[string]json.RawMessage{envelope}
	} else if err := json.Unmarshal(envelope[collection], &resources); err != nil {
		t.Fatal(err)
	}
	if len(resources) != len(expected) {
		t.Fatalf("assignment resource count: got %d want %d in %s", len(resources), len(expected), body)
	}
	seen := make(map[string]bool)
	for _, resource := range resources {
		var id string
		if err := json.Unmarshal(resource["id"], &id); err != nil {
			t.Fatal(err)
		}
		want, exists := expected[id]
		if !exists {
			t.Fatalf("unexpected task %q in %s", id, body)
		}
		assertHTTPAssignment(t, resource, want)
		seen[id] = true
	}
	if len(seen) != len(expected) {
		t.Fatalf("missing assignment resources: got %v want %v", seen, expected)
	}
}

func assertHTTPAssignmentTransition(t *testing.T, before, after api.Task, target *string) {
	t.Helper()
	if !reflect.DeepEqual(after.AssignedTo, target) || after.AllowAgents || after.Version != before.Version+1 || !after.UpdatedAt.After(before.UpdatedAt) {
		t.Fatalf("assignment transition: before %#v after %#v target %v", before, after, target)
	}
	preserved := after
	preserved.AssignedTo, preserved.AllowAgents, preserved.Version, preserved.UpdatedAt = before.AssignedTo, before.AllowAgents, before.Version, before.UpdatedAt
	if !reflect.DeepEqual(preserved, before) {
		t.Fatalf("assignment changed unrelated task facts: before %#v after %#v", before, after)
	}
}

func TestTaskHTTPAssignmentStrictInputsAndNullableResources(t *testing.T) {
	f := newTaskHTTPFixture(t)
	other, outsider := "c6666666-6666-4666-8666-666666666666", "c7777777-7777-4777-8777-777777777777"
	declared := f.target
	declared.Title, declared.AssignedTo = "Assignment default", nil
	task, response := assignmentHTTPCreate(f, declared, `{"title":"Assignment default","status":"todo"}`, nil)
	if task.AssignedTo != nil {
		t.Fatalf("default assignment: %#v", task)
	}
	assertHTTPAssignmentResources(t, response.Body.Bytes(), "", map[string]*string{task.ID: nil})
	f.store.ReadSnapshotCall, f.store.WriteProjectCall = nil, nil
	for _, invalid := range []struct {
		value     string
		readsTask bool
	}{{`""`, true}, {`"invalid"`, true}, {`" ` + f.principal.UserID + `"`, true}, {`true`, false}, {`0`, false}, {`[]`, false}, {`{}`, false}} {
		value := invalid.value
		f.store.WriteProjectCall = nil
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), `{"title":"Invalid assignment","assignedTo":`+value+`}`), http.StatusBadRequest, "invalid_input")
		if invalid.readsTask {
			assignmentHTTPMutation(f, &task, nil, nil, nil, false, nil, nil, store.TransactionCommitted)
		}
		assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(assignmentHTTPAPI(t, task)), `{"version":1,"assignedTo":`+value+`}`), http.StatusBadRequest, "invalid_input")
	}
	f.store.WriteProjectCall = nil
	for _, body := range []string{`{"title":"Duplicate","assignedTo":null,"assignedTo":null}`, `{"title":"Wrong case","AssignedTo":null}`} {
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), body), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{`{"version":1,"assignedTo":null,"assignedTo":null}`, `{"version":1,"AssignedTo":null}`} {
		assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(assignmentHTTPAPI(t, task)), body), http.StatusBadRequest, "invalid_input")
	}
	for _, id := range []string{outsider, uuid.NewString()} {
		invalid := declared
		invalid.Title, invalid.AssignedTo = "Invalid target", &id
		values := platformHTTPValues(invalid)
		assignmentHTTPMutation(f, nil, &values, nil, nil, true, &id, model.ErrNotFound, store.TransactionCommitted)
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), jsonBody(t, map[string]any{"status": "todo", "title": "Invalid target", "assignedTo": id})), http.StatusBadRequest, "invalid_input")
		invalid = task
		invalid.AssignedTo, invalid.Title = &id, "Must not partly save"
		values = platformHTTPValues(invalid)
		assignmentHTTPMutation(f, &task, &values, nil, nil, true, &id, model.ErrNotFound, store.TransactionCommitted)
		assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(assignmentHTTPAPI(t, task)), jsonBody(t, map[string]any{"version": task.Version, "assignedTo": id, "title": "Must not partly save"})), http.StatusBadRequest, "invalid_input")
	}
	f.expectRead(task)
	if !reflect.DeepEqual(readHTTPTask(t, f.handler, assignmentHTTPAPI(t, task)), assignmentHTTPAPI(t, task)) {
		t.Fatal("invalid assignment changed declared Task")
	}
	assignmentHTTPUpdate(f, task, task, map[string]any{"assignedTo": nil}, nil, false)
	for _, target := range []any{nil, strings.ToUpper(f.principal.UserID)} {
		created := declared
		created.Title = "Explicit assignment"
		if target != nil {
			created.AssignedTo = &f.principal.UserID
		}
		row, read := assignmentHTTPCreate(f, created, jsonBody(t, map[string]any{"status": "todo", "title": "Explicit assignment", "assignedTo": target}), nil)
		if !reflect.DeepEqual(row.AssignedTo, created.AssignedTo) || row.AllowAgents {
			t.Fatalf("creation assignment: %#v", row)
		}
		assertHTTPAssignmentResources(t, read.Body.Bytes(), "", map[string]*string{row.ID: created.AssignedTo})
	}
	after := platformHTTPResult(task, task)
	after.AllowAgents, after.Description, after.RequiredPlatform = true, "Preserve materials", assignmentPlatformPointer(model.PlatformLinux)
	after.Properties = model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"opaque\u0000","title":"Evidence"}]`)}
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"allowAgents": true, "description": "Preserve materials", "requiredPlatform": "linux", "properties": map[string]any{"pullRequests": []any{map[string]any{"url": "opaque\x00", "title": "Evidence"}}}}, nil, true)
	before := task
	after = platformHTTPResult(task, task)
	after.AssignedTo, after.AllowAgents = &f.principal.UserID, false
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"assignedTo": strings.ToUpper(f.principal.UserID), "allowAgents": true}, nil, true)
	assertHTTPAssignmentTransition(t, assignmentHTTPAPI(t, before), assignmentHTTPAPI(t, task), &f.principal.UserID)
	after = platformHTTPResult(task, task)
	after.Description = "Omitted assignment"
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"description": "Omitted assignment"}, nil, true)
	if task.AssignedTo == nil || *task.AssignedTo != f.principal.UserID {
		t.Fatal("omitted assignment cleared target")
	}
	after = platformHTTPResult(task, task)
	after.AllowAgents = true
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"allowAgents": true}, nil, true)
	assignmentHTTPUpdate(f, task, task, map[string]any{"assignedTo": strings.ToUpper(f.principal.UserID)}, nil, false)
	assignmentHTTPMutation(f, &task, nil, nil, nil, false, nil, nil, store.TransactionCommitted)
	assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(assignmentHTTPAPI(t, task)), jsonBody(t, map[string]any{"version": task.Version - 1, "assignedTo": f.principal.UserID})), http.StatusConflict, "version_conflict")
	before = task
	after = platformHTTPResult(task, task)
	after.AssignedTo, after.AllowAgents = &other, false
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"assignedTo": other, "allowAgents": true}, nil, true)
	assertHTTPAssignmentTransition(t, assignmentHTTPAPI(t, before), assignmentHTTPAPI(t, task), &other)
	after = platformHTTPResult(task, task)
	after.AllowAgents = true
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"allowAgents": true}, nil, true)
	before = task
	after = platformHTTPResult(task, task)
	after.AssignedTo, after.AllowAgents = nil, false
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"assignedTo": nil}, nil, true)
	assertHTTPAssignmentTransition(t, assignmentHTTPAPI(t, before), assignmentHTTPAPI(t, task), nil)
	f.expectRead(task)
	read := projectRequest(f.handler, http.MethodGet, taskPath(assignmentHTTPAPI(t, task)), "")
	decodeResponse[api.Task](t, read, http.StatusOK)
	assertHTTPAssignmentResources(t, read.Body.Bytes(), "", map[string]*string{task.ID: nil})
}

func TestTaskHTTPAssignmentRetainsFormerMember(t *testing.T) {
	f := newTaskHTTPFixture(t)
	former := "c6666666-6666-4666-8666-666666666666"
	task := f.target
	task.Title, task.AssignedTo = "Retained responsibility", &former
	task, _ = assignmentHTTPCreate(f, task, jsonBody(t, map[string]any{"status": "todo", "title": task.Title, "assignedTo": former}), nil)
	after := platformHTTPResult(task, task)
	after.AllowAgents = true
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"allowAgents": true}, nil, true)
	assignmentHTTPUpdate(f, task, task, map[string]any{"assignedTo": strings.ToUpper(former)}, nil, false)
	after = platformHTTPResult(task, task)
	after.Description = "Former member retained"
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"description": "Former member retained"}, nil, true)
	if task.AssignedTo == nil || *task.AssignedTo != former || !task.AllowAgents {
		t.Fatal("metadata discarded former assignment")
	}
	unassigned := f.target
	unassigned.Title, unassigned.AssignedTo = "Cannot select former member", nil
	unassigned, _ = assignmentHTTPCreate(f, unassigned, jsonBody(t, map[string]any{"status": "todo", "title": unassigned.Title}), nil)
	candidate := unassigned
	candidate.AssignedTo = &former
	values := platformHTTPValues(candidate)
	assignmentHTTPMutation(f, &unassigned, &values, nil, nil, true, &former, model.ErrNotFound, store.TransactionCommitted)
	assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(assignmentHTTPAPI(t, unassigned)), jsonBody(t, map[string]any{"version": unassigned.Version, "assignedTo": former})), http.StatusBadRequest, "invalid_input")
	f.expectRead(unassigned)
	platformHTTPCheck(t, readHTTPTask(t, f.handler, assignmentHTTPAPI(t, unassigned)), assignmentHTTPAPI(t, unassigned))
}

func assignmentHTTPAPI(t *testing.T, row model.Task) api.Task {
	t.Helper()
	result := platformHTTPAPI(row)
	if raw, exists := row.Properties["worker"]; exists {
		var stored map[string]json.RawMessage
		if err := json.Unmarshal(raw, &stored); err != nil {
			t.Fatal(err)
		}
		legacy := make(map[string]json.RawMessage, 13)
		for _, field := range []string{"claimId", "state", "userId", "workerId", "machine", "platform", "agent", "worktreeId", "phase", "herdr", "nativeSessionId", "claimedAt"} {
			legacy[field] = stored[field]
		}
		result.Properties["worker"] = rawProperty(t, legacy)
	}
	return result
}

type assignmentHTTPProjectDAO struct {
	store.ProjectWriteDAO
	f      *taskHTTPFixture
	target string
	err    error
	plan   *httpCallPlan
}

func (d assignmentHTTPProjectDAO) ProjectAccess(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
	if principal == d.f.principal {
		return d.ProjectWriteDAO.ProjectAccess(ctx, principal)
	}
	d.f.require(ctx, d.f.project.ID)
	d.plan.Called("target")
	platformHTTPCheck(d.f.t, principal, model.Principal{UserID: d.target})
	return model.ProjectAccess{ProjectID: d.f.project.ID, UserID: d.target, Role: model.ProjectMemberRole}, d.err
}

type assignmentHTTPWriteScope struct {
	store.ProjectWriteScope
	project store.ProjectWriteDAO
}

func (s assignmentHTTPWriteScope) ProjectDAO() store.ProjectWriteDAO { return s.project }

func assignmentHTTPMutation(f *taskHTTPFixture, current *model.Task, values *store.TaskWrite, result *model.Task, dependencies []model.Task, validate bool, target *string, targetError error, completion store.TransactionOutcome) {
	f.t.Helper()
	extended := &externalHTTPFixture{f}
	extended.mutation(current, values, result, dependencies, validate, completion)
	if target == nil {
		return
	}
	plan := newHTTPCallPlan(f.t, map[string]int{"target": 1})
	write := f.store.WriteProjectCall
	f.store.WriteProjectCall = func(ctx context.Context, project string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
		return write(ctx, project, func(scope store.ProjectWriteScope) error {
			dao := assignmentHTTPProjectDAO{ProjectWriteDAO: scope.ProjectDAO(), f: f, target: *target, err: targetError, plan: plan}
			return run(assignmentHTTPWriteScope{ProjectWriteScope: scope, project: dao})
		})
	}
}

func assignmentHTTPCreate(f *taskHTTPFixture, declared model.Task, body string, dependencies []model.Task) (model.Task, *httptest.ResponseRecorder) {
	f.t.Helper()
	declared = copyTaskHTTPTask(declared)
	values := platformHTTPValues(declared)
	assignmentHTTPMutation(f, nil, &values, &declared, dependencies, true, declared.AssignedTo, nil, store.TransactionCommitted)
	response := projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), body)
	got := decodeResponse[api.Task](f.t, response, http.StatusCreated)
	platformHTTPCheck(f.t, got, assignmentHTTPAPI(f.t, declared))
	return declared, response
}

func assignmentHTTPUpdate(f *taskHTTPFixture, before, after model.Task, patch map[string]any, dependencies []model.Task, changed bool) model.Task {
	f.t.Helper()
	before, after = copyTaskHTTPTask(before), copyTaskHTTPTask(after)
	values := platformHTTPValues(after)
	var result *model.Task
	if changed {
		result = &after
	}
	var target *string
	if !reflect.DeepEqual(before.AssignedTo, after.AssignedTo) {
		target = after.AssignedTo
	}
	assignmentHTTPMutation(f, &before, &values, result, dependencies, true, target, nil, store.TransactionCommitted)
	got := updateHTTPTask(f.t, f.handler, assignmentHTTPAPI(f.t, before), patch)
	platformHTTPCheck(f.t, got, assignmentHTTPAPI(f.t, after))
	return after
}

func assignmentHTTPGraphRow(row model.Task) model.GraphTask {
	row = copyTaskHTTPTask(row)
	result := platformHTTPProjection(row)
	result.DependsOn, result.ExternalDependsOn, result.BlockedBy = row.DependsOn, row.ExternalDependsOn, row.BlockedBy
	return result
}

func assignmentHTTPSyncRow(row model.Task) model.TaskViewRecord {
	row = copyTaskHTTPTask(row)
	return model.TaskViewRecord{ID: row.ID, TitlePreview: row.Title, Properties: row.Properties, Status: row.Status, Version: row.Version,
		AssignedTo: row.AssignedTo, RequiredPlatform: row.RequiredPlatform, AllowAgents: row.AllowAgents, DependsOn: row.DependsOn, ExternalDependsOn: row.ExternalDependsOn,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, StartedAt: row.StartedAt, CompletedAt: row.CompletedAt, CancelledAt: row.CancelledAt}
}

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

func TestTaskHTTPAssignmentDAOFailureReportsUncommittedOutcome(t *testing.T) {
	f := newTaskHTTPFixture(t)
	current := f.target
	current.AssignedTo = nil
	target := "c6666666-6666-4666-8666-666666666666"
	candidate := current
	candidate.AssignedTo = &target
	values := platformHTTPValues(candidate)
	failure := errors.New("private assignment lookup failure")
	assignmentHTTPMutation(f, &current, &values, nil, nil, true, &target, failure, store.TransactionNotCommitted)
	write := f.store.WriteProjectCall
	var completion store.Completion
	var callbackError error
	f.store.WriteProjectCall = func(ctx context.Context, id string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
		completion, callbackError = write(ctx, id, run)
		return completion, callbackError
	}
	response := projectRequest(f.handler, http.MethodPatch, taskPath(assignmentHTTPAPI(t, current)), jsonBody(t, map[string]any{"version": current.Version, "assignedTo": target}))
	assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(callbackError, failure) || strings.Contains(response.Body.String(), failure.Error()) {
		t.Fatalf("callback error and completion lost independence: completion=%#v error=%v body=%s", completion, callbackError, response.Body)
	}
	f.expectRead(current)
	platformHTTPCheck(t, readHTTPTask(t, f.handler, assignmentHTTPAPI(t, current)), assignmentHTTPAPI(t, current))
}
