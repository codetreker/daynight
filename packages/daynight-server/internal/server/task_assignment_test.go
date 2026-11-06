package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func assignmentHTTPUser(t *testing.T, database *store.Store) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, id, "assignment-"+id); err != nil {
		t.Fatal(err)
	}
	return id
}

func assignmentHTTPMember(t *testing.T, database *store.Store, projectID string) string {
	t.Helper()
	id := assignmentHTTPUser(t, database)
	if _, err := database.WriteProject(context.Background(), projectID, func(tx store.ProjectWriteScope) error {
		_, err := tx.ProjectDAO().AddInvitedMember(context.Background(), id)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return id
}

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
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	project := taskProject(t, handler)
	other := assignmentHTTPMember(t, database, project.ID)
	outsider := assignmentHTTPUser(t, database)
	response := projectRequest(handler, http.MethodPost, taskCollection(project.ID), `{"title":"Assignment default"}`)
	task := decodeResponse[api.Task](t, response, http.StatusCreated)
	if task.AssignedTo != nil {
		t.Fatalf("default assignment: %#v", task)
	}
	assertHTTPAssignmentResources(t, response.Body.Bytes(), "", map[string]*string{task.ID: nil})

	for _, value := range []string{`""`, `"invalid"`, `" ` + handler.principal.UserID + `"`, `true`, `0`, `[]`, `{}`} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), `{"title":"Invalid assignment","assignedTo":`+value+`}`), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), `{"version":1,"assignedTo":`+value+`}`), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{`{"title":"Duplicate","assignedTo":null,"assignedTo":null}`, `{"title":"Wrong case","AssignedTo":null}`} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), body), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{`{"version":1,"assignedTo":null,"assignedTo":null}`, `{"version":1,"AssignedTo":null}`} {
		assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), body), http.StatusBadRequest, "invalid_input")
	}
	for _, id := range []string{outsider, uuid.NewString()} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Invalid target", "assignedTo": id})), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": task.Version, "assignedTo": id, "title": "Must not partly save"})), http.StatusBadRequest, "invalid_input")
	}
	if got := readHTTPTask(t, handler, task); !reflect.DeepEqual(got, task) {
		t.Fatal("invalid assignment input changed task")
	}
	if same := updateHTTPTask(t, handler, task, map[string]any{"assignedTo": nil}); !reflect.DeepEqual(same, task) {
		t.Fatal("same null assignment changed resource")
	}

	for _, target := range []any{nil, strings.ToUpper(handler.principal.UserID)} {
		createdResponse := projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Explicit assignment", "assignedTo": target}))
		created := decodeResponse[api.Task](t, createdResponse, http.StatusCreated)
		var want *string
		if target != nil {
			want = assignmentHTTPPointer(handler.principal.UserID)
		}
		if !reflect.DeepEqual(created.AssignedTo, want) || created.AllowAgents {
			t.Fatalf("creation assignment or permission: %#v", created)
		}
		assertHTTPAssignmentResources(t, createdResponse.Body.Bytes(), "", map[string]*string{created.ID: want})
	}

	task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": true, "description": "Preserve materials", "requiredPlatform": "linux", "properties": map[string]any{"pullRequests": []any{map[string]any{"url": "opaque\x00", "title": "Evidence"}}}})
	before := task
	task = updateHTTPTask(t, handler, task, map[string]any{"assignedTo": strings.ToUpper(handler.principal.UserID), "allowAgents": true})
	assertHTTPAssignmentTransition(t, before, task, assignmentHTTPPointer(handler.principal.UserID))
	task = updateHTTPTask(t, handler, task, map[string]any{"description": "Omitted assignment"})
	if task.AssignedTo == nil || *task.AssignedTo != handler.principal.UserID {
		t.Fatal("omitted assignment cleared the stored target")
	}
	task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": true})
	if same := updateHTTPTask(t, handler, task, map[string]any{"assignedTo": strings.ToUpper(handler.principal.UserID)}); !reflect.DeepEqual(same, task) {
		t.Fatal("canonical same assignment changed permission, version or task facts")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": task.Version - 1, "assignedTo": handler.principal.UserID})), http.StatusConflict, "version_conflict")
	before = task
	task = updateHTTPTask(t, handler, task, map[string]any{"assignedTo": other, "allowAgents": true})
	assertHTTPAssignmentTransition(t, before, task, assignmentHTTPPointer(other))
	task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": true})
	before = task
	task = updateHTTPTask(t, handler, task, map[string]any{"assignedTo": nil})
	assertHTTPAssignmentTransition(t, before, task, nil)
	read := projectRequest(handler, http.MethodGet, taskPath(task), "")
	decodeResponse[api.Task](t, read, http.StatusOK)
	assertHTTPAssignmentResources(t, read.Body.Bytes(), "", map[string]*string{task.ID: nil})
}

func TestTaskHTTPAssignmentExecutionLocksAndPreservesClaim(t *testing.T) {
	for _, worker := range []bool{false, true} {
		t.Run(map[bool]string{false: "manual", true: "worker"}[worker], func(t *testing.T) {
			database := projectTestStore(t)
			handler := projectTestHandler(t, database, io.Discard)
			project := taskProject(t, handler)
			other := assignmentHTTPMember(t, database, project.ID)
			task := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Executing assignment", "assignedTo": handler.principal.UserID})), http.StatusCreated)
			task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": true})
			if worker {
				task = claimHTTPWorker(t, handler, task, workerClaimBody(task.Version))
			} else {
				task = setHTTPTask(t, handler, task, "in_progress")
			}
			if task.AssignedTo == nil || *task.AssignedTo != handler.principal.UserID {
				t.Fatal("starting execution discarded assignment")
			}
			if same := updateHTTPTask(t, handler, task, map[string]any{"assignedTo": handler.principal.UserID}); !reflect.DeepEqual(same, task) {
				t.Fatal("executing same assignment changed task")
			}
			if same := setHTTPTask(t, handler, task, "in_progress"); !reflect.DeepEqual(same, task) {
				t.Fatal("same status changed assigned task")
			}
			for _, target := range []any{nil, other} {
				assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": task.Version, "assignedTo": target, "title": "Must not save"})), http.StatusConflict, "invalid_transition")
				if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
					t.Fatal("executing reassignment partly saved task")
				}
			}
			if worker {
				claim := apiWorker(t, task.Properties)
				task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPut, taskPath(task)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: task.Version, Status: "done", ClaimID: &claim.ClaimID})), http.StatusOK)
			} else {
				task = setHTTPTask(t, handler, task, "done")
			}
			before := task
			task = updateHTTPTask(t, handler, task, map[string]any{"assignedTo": other})
			assertHTTPAssignmentTransition(t, before, task, assignmentHTTPPointer(other))
			if !reflect.DeepEqual(apiWorker(t, task.Properties), apiWorker(t, before.Properties)) {
				t.Fatal("completed assignment transferred or removed claim history")
			}
		})
	}
}

func TestTaskHTTPAssignmentRetainsFormerMember(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	project := taskProject(t, handler)
	former := assignmentHTTPMember(t, database, project.ID)
	task := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Retained responsibility", "assignedTo": former})), http.StatusCreated)
	if _, err := database.Pool.Exec(context.Background(), `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, former); err != nil {
		t.Fatal(err)
	}
	task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": true})
	if same := updateHTTPTask(t, handler, task, map[string]any{"assignedTo": strings.ToUpper(former)}); !reflect.DeepEqual(same, task) {
		t.Fatal("retained same-value assignment was requalified or reset")
	}
	task = updateHTTPTask(t, handler, task, map[string]any{"description": "Former member retained"})
	if task.AssignedTo == nil || *task.AssignedTo != former || !task.AllowAgents {
		t.Fatal("ordinary metadata update discarded former member or permission")
	}
	unassigned := createHTTPTask(t, handler, project.ID, "Cannot select former member")
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(unassigned), jsonBody(t, map[string]any{"version": unassigned.Version, "assignedTo": former})), http.StatusBadRequest, "invalid_input")
	if !reflect.DeepEqual(readHTTPTask(t, handler, unassigned), unassigned) {
		t.Fatal("invalid former-member target changed task")
	}
}

func TestTaskHTTPAssignmentFullGraphAndSyncProjections(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	unassigned := createHTTPTask(t, handler, project.ID, "Unassigned prerequisite")
	assigned := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Assigned successor", "assignedTo": handler.principal.UserID, "dependsOn": []string{unassigned.ID}})), http.StatusCreated)
	want := map[string]*string{unassigned.ID: nil, assigned.ID: assignmentHTTPPointer(handler.principal.UserID)}
	check := func(expected map[string]*string, delta string) {
		t.Helper()
		for _, item := range []struct{ path, collection string }{{taskCollection(project.ID), "items"}, {graphPath(project.ID, unassigned.ID), "tasks"}, {syncPath(project.ID), "tasks"}} {
			response := projectRequest(handler, http.MethodGet, item.path, "")
			if response.Code != http.StatusOK {
				t.Fatalf("projection failed: %s %d %s", item.path, response.Code, response.Body)
			}
			assertHTTPAssignmentResources(t, response.Body.Bytes(), item.collection, expected)
		}
		for id, target := range expected {
			response := projectRequest(handler, http.MethodGet, taskCollection(project.ID)+"/"+id, "")
			decodeResponse[api.Task](t, response, http.StatusOK)
			assertHTTPAssignmentResources(t, response.Body.Bytes(), "", map[string]*string{id: target})
		}
		if delta != "" {
			response := projectRequest(handler, http.MethodGet, syncPath(project.ID)+delta, "")
			result := decodeResponse[api.TaskSync](t, response, http.StatusOK)
			if result.Mode != "delta" {
				t.Fatalf("expected delta, got %q", result.Mode)
			}
			assertHTTPAssignmentResources(t, response.Body.Bytes(), "tasks", expected)
		}
	}
	check(want, "")
	baseline := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(project.ID), ""), http.StatusOK)
	unassigned = updateHTTPTask(t, handler, unassigned, map[string]any{"assignedTo": handler.principal.UserID})
	assigned = updateHTTPTask(t, handler, assigned, map[string]any{"assignedTo": nil})
	want = map[string]*string{unassigned.ID: assignmentHTTPPointer(handler.principal.UserID), assigned.ID: nil}
	query := "?epoch=" + baseline.Epoch + "&since=" + url.QueryEscape(baseline.ObservedAt.Format(time.RFC3339Nano))
	check(want, query)
}
