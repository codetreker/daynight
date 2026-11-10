package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
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
	task, response := assignmentHTTPCreate(f, declared, `{"title":"Assignment default","status":"todo"}`, taskcore.CreateTask{Title: "Assignment default", Status: platformHTTPPointer(model.TaskTodo), DependsOn: []string{}, Properties: model.TaskProperties{}})
	if task.AssignedTo != nil {
		t.Fatalf("default assignment: %#v", task)
	}
	assertHTTPAssignmentResources(t, response.Body.Bytes(), "", map[string]*string{task.ID: nil})
	clearMutationHTTPOperations(f)
	for _, invalid := range []struct {
		value     string
		readsTask bool
		assigned  string
	}{{`""`, true, ""}, {`"invalid"`, true, "invalid"}, {`" ` + f.principal.UserID + `"`, true, " " + f.principal.UserID}, {`true`, false, ""}, {`0`, false, ""}, {`[]`, false, ""}, {`{}`, false, ""}} {
		value := invalid.value
		clearMutationHTTPOperations(f)
		if invalid.readsTask {
			assigned := invalid.assigned
			expectMutationHTTPCreate(f, taskcore.CreateTask{Title: "Invalid assignment", AssignedTo: &assigned, DependsOn: []string{}, Properties: model.TaskProperties{}}, model.Task{}, mutationHTTPFault("invalid_input"))
		}
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), `{"title":"Invalid assignment","assignedTo":`+value+`}`), http.StatusBadRequest, "invalid_input")
		if invalid.readsTask {
			assigned := invalid.assigned
			expectMutationHTTPUpdate(f, task.ID, taskcore.UpdateTask{Version: 1, AssignedTo: platformHTTPPointer(&assigned)}, model.Task{}, mutationHTTPFault("invalid_input"))
		}
		assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(assignmentHTTPAPI(t, task)), `{"version":1,"assignedTo":`+value+`}`), http.StatusBadRequest, "invalid_input")
	}
	clearMutationHTTPOperations(f)
	for _, body := range []string{`{"title":"Duplicate","assignedTo":null,"assignedTo":null}`, `{"title":"Wrong case","AssignedTo":null}`} {
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), body), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{`{"version":1,"assignedTo":null,"assignedTo":null}`, `{"version":1,"AssignedTo":null}`} {
		assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(assignmentHTTPAPI(t, task)), body), http.StatusBadRequest, "invalid_input")
	}
	for _, id := range []string{outsider, uuid.NewString()} {
		expectMutationHTTPCreate(f, taskcore.CreateTask{Title: "Invalid target", Status: platformHTTPPointer(model.TaskTodo), AssignedTo: &id, DependsOn: []string{}, Properties: model.TaskProperties{}}, model.Task{}, mutationHTTPFault("invalid_input"))
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), jsonBody(t, map[string]any{"status": "todo", "title": "Invalid target", "assignedTo": id})), http.StatusBadRequest, "invalid_input")
		expectMutationHTTPUpdate(f, task.ID, taskcore.UpdateTask{Version: task.Version, AssignedTo: platformHTTPPointer(&id), Title: platformHTTPPointer("Must not partly save")}, model.Task{}, mutationHTTPFault("invalid_input"))
		assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(assignmentHTTPAPI(t, task)), jsonBody(t, map[string]any{"version": task.Version, "assignedTo": id, "title": "Must not partly save"})), http.StatusBadRequest, "invalid_input")
	}
	f.expectRead(task)
	if !reflect.DeepEqual(readHTTPTask(t, f.handler, assignmentHTTPAPI(t, task)), assignmentHTTPAPI(t, task)) {
		t.Fatal("invalid assignment changed declared Task")
	}
	assignmentHTTPUpdate(f, task, task, map[string]any{"assignedTo": nil}, taskcore.UpdateTask{AssignedTo: platformHTTPPointer[*string](nil)})
	for _, target := range []any{nil, strings.ToUpper(f.principal.UserID)} {
		created := declared
		created.Title = "Explicit assignment"
		if target != nil {
			created.AssignedTo = &f.principal.UserID
		}
		row, read := assignmentHTTPCreate(f, created, jsonBody(t, map[string]any{"status": "todo", "title": "Explicit assignment", "assignedTo": target}), taskcore.CreateTask{Title: "Explicit assignment", Status: platformHTTPPointer(model.TaskTodo), AssignedTo: assignmentHTTPStringInput(target), DependsOn: []string{}, Properties: model.TaskProperties{}})
		if !reflect.DeepEqual(row.AssignedTo, created.AssignedTo) || row.AllowAgents {
			t.Fatalf("creation assignment: %#v", row)
		}
		assertHTTPAssignmentResources(t, read.Body.Bytes(), "", map[string]*string{row.ID: created.AssignedTo})
	}
	after := platformHTTPResult(task, task)
	after.AllowAgents, after.Description, after.RequiredPlatform = true, "Preserve materials", assignmentPlatformPointer(model.PlatformLinux)
	after.Properties = model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"opaque\u0000","title":"Evidence"}]`)}
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"allowAgents": true, "description": "Preserve materials", "requiredPlatform": "linux", "properties": map[string]any{"pullRequests": []any{map[string]any{"url": "opaque\x00", "title": "Evidence"}}}}, taskcore.UpdateTask{AllowAgents: platformHTTPPointer(true), Description: platformHTTPPointer("Preserve materials"), RequiredPlatform: platformHTTPPointer(assignmentPlatformPointer(model.PlatformLinux)), Properties: model.TaskPropertiesPatch{"pullRequests": json.RawMessage(`[{"url":"opaque\u0000","title":"Evidence"}]`)}})
	before := task
	after = platformHTTPResult(task, task)
	after.AssignedTo, after.AllowAgents = &f.principal.UserID, false
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"assignedTo": strings.ToUpper(f.principal.UserID), "allowAgents": true}, taskcore.UpdateTask{AssignedTo: platformHTTPPointer(platformHTTPPointer(strings.ToUpper(f.principal.UserID))), AllowAgents: platformHTTPPointer(true)})
	assertHTTPAssignmentTransition(t, assignmentHTTPAPI(t, before), assignmentHTTPAPI(t, task), &f.principal.UserID)
	after = platformHTTPResult(task, task)
	after.Description = "Omitted assignment"
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"description": "Omitted assignment"}, taskcore.UpdateTask{Description: platformHTTPPointer("Omitted assignment")})
	if task.AssignedTo == nil || *task.AssignedTo != f.principal.UserID {
		t.Fatal("omitted assignment cleared target")
	}
	after = platformHTTPResult(task, task)
	after.AllowAgents = true
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"allowAgents": true}, taskcore.UpdateTask{AllowAgents: platformHTTPPointer(true)})
	assignmentHTTPUpdate(f, task, task, map[string]any{"assignedTo": strings.ToUpper(f.principal.UserID)}, taskcore.UpdateTask{AssignedTo: platformHTTPPointer(platformHTTPPointer(strings.ToUpper(f.principal.UserID)))})
	expectMutationHTTPUpdate(f, task.ID, taskcore.UpdateTask{Version: task.Version - 1, AssignedTo: platformHTTPPointer(&f.principal.UserID)}, model.Task{}, mutationHTTPFault("version_conflict"))
	assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(assignmentHTTPAPI(t, task)), jsonBody(t, map[string]any{"version": task.Version - 1, "assignedTo": f.principal.UserID})), http.StatusConflict, "version_conflict")
	before = task
	after = platformHTTPResult(task, task)
	after.AssignedTo, after.AllowAgents = &other, false
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"assignedTo": other, "allowAgents": true}, taskcore.UpdateTask{AssignedTo: platformHTTPPointer(&other), AllowAgents: platformHTTPPointer(true)})
	assertHTTPAssignmentTransition(t, assignmentHTTPAPI(t, before), assignmentHTTPAPI(t, task), &other)
	after = platformHTTPResult(task, task)
	after.AllowAgents = true
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"allowAgents": true}, taskcore.UpdateTask{AllowAgents: platformHTTPPointer(true)})
	before = task
	after = platformHTTPResult(task, task)
	after.AssignedTo, after.AllowAgents = nil, false
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"assignedTo": nil}, taskcore.UpdateTask{AssignedTo: platformHTTPPointer[*string](nil)})
	assertHTTPAssignmentTransition(t, assignmentHTTPAPI(t, before), assignmentHTTPAPI(t, task), nil)
	f.expectRead(task)
	read := projectRequest(f.handler, http.MethodGet, taskPath(assignmentHTTPAPI(t, task)), "")
	decodeResponse[api.Task](t, read, http.StatusOK)
	assertHTTPAssignmentResources(t, read.Body.Bytes(), "", map[string]*string{task.ID: nil})
}

func TestTaskHTTPAssignmentExecutionLocksAndPreservesClaim(t *testing.T) {
	for _, workerExecution := range []bool{false, true} {
		t.Run(map[bool]string{false: "manual", true: "worker"}[workerExecution], func(t *testing.T) {
			f := newTaskHTTPFixture(t)
			other := "c6666666-6666-4666-8666-666666666666"
			declared := f.target
			declared.Title = "Executing assignment"
			task, _ := assignmentHTTPCreate(f, declared, jsonBody(t, map[string]any{"status": "todo", "title": declared.Title, "assignedTo": f.principal.UserID}), taskcore.CreateTask{Title: declared.Title, Status: platformHTTPPointer(model.TaskTodo), AssignedTo: &f.principal.UserID, DependsOn: []string{}, Properties: model.TaskProperties{}})
			after := platformHTTPResult(task, task)
			after.AllowAgents = true
			task = assignmentHTTPUpdate(f, task, after, map[string]any{"allowAgents": true}, taskcore.UpdateTask{AllowAgents: platformHTTPPointer(true)})
			if workerExecution {
				body := workerClaimBody(task.Version)
				claimedAt := task.UpdatedAt.Add(time.Second)
				claim := model.WorkerClaim{ClaimID: body["claimId"].(string), WorkerID: body["workerId"].(string), UserID: f.principal.UserID,
					Machine: model.WorkerMachine{ID: body["machine"].(map[string]any)["id"].(string), Name: "Worker machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: body["worktreeId"].(string), State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: claimedAt}
				after = task
				after.Status, after.Version, after.Ready = model.TaskInProgress, task.Version+1, false
				after.StartedAt, after.UpdatedAt = copyTaskHTTPPointer(&claimedAt), claimedAt
				after.Properties = workerHTTPProperties(t, task.Properties, &claim)
				plan := expectWorkerHTTPClaim(t, f.tasks, task, f.principal, workerHTTPClaimInput(body), after, nil)
				got := claimHTTPWorker(t, f.handler, assignmentHTTPAPI(t, task), body)
				plan.check()
				platformHTTPCheck(t, got, assignmentHTTPAPI(t, after))
				task = after
			} else {
				task = platformHTTPStatus(f, task, model.TaskInProgress)
			}
			if task.AssignedTo == nil || *task.AssignedTo != f.principal.UserID {
				t.Fatal("start discarded assignment")
			}
			assignmentHTTPUpdate(f, task, task, map[string]any{"assignedTo": f.principal.UserID}, taskcore.UpdateTask{AssignedTo: platformHTTPPointer(&f.principal.UserID)})
			expectMutationHTTPStatus(f, task.ID, taskcore.SetTaskStatus{Version: task.Version, Status: model.TaskInProgress}, task, nil)
			same := setHTTPTask(t, f.handler, assignmentHTTPAPI(t, task), "in_progress")
			platformHTTPCheck(t, same, assignmentHTTPAPI(t, task))
			for _, target := range []*string{nil, &other} {
				expectMutationHTTPUpdate(f, task.ID, taskcore.UpdateTask{Version: task.Version, AssignedTo: platformHTTPPointer(copyTaskHTTPPointer(target)), Title: platformHTTPPointer("Must not save")}, model.Task{}, mutationHTTPFault("invalid_transition"))
				assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(assignmentHTTPAPI(t, task)), jsonBody(t, map[string]any{"version": task.Version, "assignedTo": target, "title": "Must not save"})), http.StatusConflict, "invalid_transition")
				f.expectRead(task)
				platformHTTPCheck(t, readHTTPTask(t, f.handler, assignmentHTTPAPI(t, task)), assignmentHTTPAPI(t, task))
			}
			if workerExecution {
				claim := apiWorker(t, task.Properties)
				completed := *claim
				completed.State = "completed"
				after = platformHTTPResult(task, task)
				after.Status, after.Ready = model.TaskDone, false
				after.CompletedAt = copyTaskHTTPPointer(&after.UpdatedAt)
				raw, err := json.Marshal(completed)
				if err != nil {
					t.Fatal(err)
				}
				after.Properties = model.TaskProperties{"worker": raw}
				expectMutationHTTPStatus(f, task.ID, taskcore.SetTaskStatus{Version: task.Version, Status: model.TaskDone, ClaimID: &claim.ClaimID}, after, nil)
				got := decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPut, taskPath(assignmentHTTPAPI(t, task))+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: task.Version, Status: "done", ClaimID: &claim.ClaimID})), http.StatusOK)
				platformHTTPCheck(t, got, assignmentHTTPAPI(t, after))
				task = after
			} else {
				task = platformHTTPStatus(f, task, model.TaskDone)
			}
			before := task
			after = platformHTTPResult(task, task)
			after.AssignedTo, after.AllowAgents = &other, false
			task = assignmentHTTPUpdate(f, task, after, map[string]any{"assignedTo": other}, taskcore.UpdateTask{AssignedTo: platformHTTPPointer(&other)})
			assertHTTPAssignmentTransition(t, assignmentHTTPAPI(t, before), assignmentHTTPAPI(t, task), &other)
			if !reflect.DeepEqual(apiWorker(t, assignmentHTTPAPI(t, task).Properties), apiWorker(t, assignmentHTTPAPI(t, before).Properties)) {
				t.Fatal("completed assignment changed claim history")
			}
		})
	}
}

func TestTaskHTTPAssignmentRetainsFormerMember(t *testing.T) {
	f := newTaskHTTPFixture(t)
	former := "c6666666-6666-4666-8666-666666666666"
	task := f.target
	task.Title, task.AssignedTo = "Retained responsibility", &former
	task, _ = assignmentHTTPCreate(f, task, jsonBody(t, map[string]any{"status": "todo", "title": task.Title, "assignedTo": former}), taskcore.CreateTask{Title: task.Title, Status: platformHTTPPointer(model.TaskTodo), AssignedTo: &former, DependsOn: []string{}, Properties: model.TaskProperties{}})
	after := platformHTTPResult(task, task)
	after.AllowAgents = true
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"allowAgents": true}, taskcore.UpdateTask{AllowAgents: platformHTTPPointer(true)})
	assignmentHTTPUpdate(f, task, task, map[string]any{"assignedTo": strings.ToUpper(former)}, taskcore.UpdateTask{AssignedTo: platformHTTPPointer(platformHTTPPointer(strings.ToUpper(former)))})
	after = platformHTTPResult(task, task)
	after.Description = "Former member retained"
	task = assignmentHTTPUpdate(f, task, after, map[string]any{"description": "Former member retained"}, taskcore.UpdateTask{Description: platformHTTPPointer("Former member retained")})
	if task.AssignedTo == nil || *task.AssignedTo != former || !task.AllowAgents {
		t.Fatal("metadata discarded former assignment")
	}
	unassigned := f.target
	unassigned.Title, unassigned.AssignedTo = "Cannot select former member", nil
	unassigned, _ = assignmentHTTPCreate(f, unassigned, jsonBody(t, map[string]any{"status": "todo", "title": unassigned.Title}), taskcore.CreateTask{Title: unassigned.Title, Status: platformHTTPPointer(model.TaskTodo), DependsOn: []string{}, Properties: model.TaskProperties{}})
	expectMutationHTTPUpdate(f, unassigned.ID, taskcore.UpdateTask{Version: unassigned.Version, AssignedTo: platformHTTPPointer(&former)}, model.Task{}, mutationHTTPFault("invalid_input"))
	assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(assignmentHTTPAPI(t, unassigned)), jsonBody(t, map[string]any{"version": unassigned.Version, "assignedTo": former})), http.StatusBadRequest, "invalid_input")
	f.expectRead(unassigned)
	platformHTTPCheck(t, readHTTPTask(t, f.handler, assignmentHTTPAPI(t, unassigned)), assignmentHTTPAPI(t, unassigned))
}

func TestTaskHTTPAssignmentFullGraphAndSyncProjections(t *testing.T) {
	f := newTaskHTTPFixture(t)
	unassigned := f.target
	unassigned.Title, unassigned.AssignedTo = "Unassigned prerequisite", nil
	unassigned, _ = assignmentHTTPCreate(f, unassigned, jsonBody(t, map[string]any{"status": "todo", "title": unassigned.Title}), taskcore.CreateTask{Title: unassigned.Title, Status: platformHTTPPointer(model.TaskTodo), DependsOn: []string{}, Properties: model.TaskProperties{}})
	assigned := f.target
	assigned.Title = "Assigned successor"
	assigned.DependsOn, assigned.BlockedBy = []string{unassigned.ID}, []string{unassigned.ID}
	assigned.Ready = false
	assigned, _ = assignmentHTTPCreate(f, assigned, jsonBody(t, map[string]any{"status": "todo", "title": assigned.Title, "assignedTo": f.principal.UserID, "dependsOn": []string{unassigned.ID}}), taskcore.CreateTask{Title: assigned.Title, Status: platformHTTPPointer(model.TaskTodo), AssignedTo: &f.principal.UserID, DependsOn: []string{unassigned.ID}, Properties: model.TaskProperties{}})
	rows := []model.Task{unassigned, assigned}
	facts := []model.TaskAssigneeVersion{{UserID: f.principal.UserID, Version: taskHTTPAdminProfileVersion, HasProjectAccess: true}}
	check := func(expected map[string]*string, delta string) {
		f.expectListRequest(taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 50}}, taskservice.TaskPage{Items: rows}, nil)
		response := projectRequest(f.handler, http.MethodGet, taskCollection(f.project.ID), "")
		decodeResponse[api.TaskPage](t, response, http.StatusOK)
		assertHTTPAssignmentResources(t, response.Body.Bytes(), "items", expected)
		f.expectGraph(unassigned.ID, []model.GraphTask{assignmentHTTPGraphRow(rows[0]), assignmentHTTPGraphRow(rows[1])}, model.TaskGraphSummary{Total: 2, Todo: 2, Ready: 1, Blocked: 1})
		response = projectRequest(f.handler, http.MethodGet, graphPath(f.project.ID, unassigned.ID), "")
		if response.Code != http.StatusOK {
			t.Fatalf("Graph: %d %s", response.Code, response.Body)
		}
		assertHTTPAssignmentResources(t, response.Body.Bytes(), "tasks", expected)
		f.expectSync([]model.TaskViewRecord{assignmentHTTPSyncRow(rows[0]), assignmentHTTPSyncRow(rows[1])}, facts, nil)
		response = projectRequest(f.handler, http.MethodGet, syncPath(f.project.ID), "")
		decodeResponse[api.TaskSync](t, response, http.StatusOK)
		assertHTTPAssignmentResources(t, response.Body.Bytes(), "tasks", expected)
		for _, row := range rows {
			f.expectRead(row)
			response = projectRequest(f.handler, http.MethodGet, taskPath(assignmentHTTPAPI(t, row)), "")
			decodeResponse[api.Task](t, response, http.StatusOK)
			assertHTTPAssignmentResources(t, response.Body.Bytes(), "", map[string]*string{row.ID: expected[row.ID]})
		}
		if delta != "" {
			lower := f.observed.Add(-10 * time.Second)
			f.expectSync([]model.TaskViewRecord{assignmentHTTPSyncRow(rows[0]), assignmentHTTPSyncRow(rows[1])}, facts, &lower)
			response = projectRequest(f.handler, http.MethodGet, syncPath(f.project.ID)+delta, "")
			result := decodeResponse[api.TaskSync](t, response, http.StatusOK)
			if result.Mode != "delta" {
				t.Fatalf("delta mode: %q", result.Mode)
			}
			assertHTTPAssignmentResources(t, response.Body.Bytes(), "tasks", expected)
		}
	}
	check(map[string]*string{unassigned.ID: nil, assigned.ID: &f.principal.UserID}, "")
	f.expectSync([]model.TaskViewRecord{assignmentHTTPSyncRow(unassigned), assignmentHTTPSyncRow(assigned)}, facts, nil)
	baseline := decodeResponse[api.TaskSync](t, projectRequest(f.handler, http.MethodGet, syncPath(f.project.ID), ""), http.StatusOK)
	after := platformHTTPResult(unassigned, unassigned)
	after.AssignedTo = &f.principal.UserID
	unassigned = assignmentHTTPUpdate(f, unassigned, after, map[string]any{"assignedTo": f.principal.UserID}, taskcore.UpdateTask{AssignedTo: platformHTTPPointer(&f.principal.UserID)})
	after = platformHTTPResult(assigned, assigned)
	after.AssignedTo = nil
	assigned = assignmentHTTPUpdate(f, assigned, after, map[string]any{"assignedTo": nil}, taskcore.UpdateTask{AssignedTo: platformHTTPPointer[*string](nil)})
	rows = []model.Task{unassigned, assigned}
	query := "?epoch=" + baseline.Epoch + "&since=" + url.QueryEscape(baseline.ObservedAt.Format(time.RFC3339Nano))
	check(map[string]*string{unassigned.ID: &f.principal.UserID, assigned.ID: nil}, query)
}

func assignmentHTTPStringInput(value any) *string {
	if value == nil {
		return nil
	}
	text := value.(string)
	return &text
}
