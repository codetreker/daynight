package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
)

type acceptanceAssignmentRequest struct {
	RequestID string `json:"requestId"`
	Route     string `json:"route"`
	Status    int    `json:"status"`
}

func acceptanceAssignmentRequests(process *acceptanceProcess) []acceptanceAssignmentRequest {
	process.logs.mu.Lock()
	defer process.logs.mu.Unlock()
	var requests []acceptanceAssignmentRequest
	for _, event := range process.logs.events {
		if event["type"] != "http_request" {
			continue
		}
		id, _ := event["request_id"].(string)
		route, _ := event["route"].(string)
		status, _ := event["status"].(float64)
		requests = append(requests, acceptanceAssignmentRequest{RequestID: id, Route: route, Status: int(status)})
	}
	return requests
}

func acceptanceAssignmentMark(t *testing.T, process *acceptanceProcess, project api.Project) int {
	t.Helper()
	id := "assignment-log-barrier-" + uuid.NewString()
	acceptanceDecode[api.Project](t, process.request(context.Background(), http.MethodGet, "/api/v1/projects/"+project.ID, nil, id), http.StatusOK)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	position := 0
	if err := acceptanceEventually(ctx, func() (bool, error) {
		for index, request := range acceptanceAssignmentRequests(process) {
			if request.RequestID == id {
				position = index + 1
				return true, nil
			}
		}
		return false, nil
	}); err != nil {
		t.Fatal("assignment request logs did not reach the HTTP barrier")
	}
	return position
}

func acceptanceAssignmentBudget(t *testing.T, process *acceptanceProcess, project api.Project, start, taskReads, taskWrites, pages int) []acceptanceAssignmentRequest {
	t.Helper()
	end := acceptanceAssignmentMark(t, process, project) - 1
	requests := acceptanceAssignmentRequests(process)[start:end]
	want := map[string]int{
		"GET /api/v1/projects/{projectId}":                  1,
		"GET /api/v1/projects/{projectId}/tasks/{taskId}":   taskReads,
		"PATCH /api/v1/projects/{projectId}/tasks/{taskId}": taskWrites,
		"GET /api/v1/projects/{projectId}/tasks":            pages,
	}
	counts := make(map[string]int)
	for _, request := range requests {
		counts[request.Route]++
		if request.RequestID == "" {
			t.Fatal("assignment request lost its server correlation identity")
		}
	}
	for route, count := range want {
		if counts[route] != count {
			t.Fatalf("installed assignment request budget for %s: got %d, want %d", route, counts[route], count)
		}
		delete(counts, route)
	}
	if len(counts) != 0 {
		t.Fatalf("installed assignment added an unexpected HTTP request: %v", counts)
	}
	return requests
}

func acceptanceAssignmentSave(t *testing.T, evidence *acceptanceLifecycleEvidence, action string, before, after api.Task, output string, requests []acceptanceAssignmentRequest) {
	t.Helper()
	encoded, err := json.Marshal(requests)
	if err != nil {
		t.Fatal(err)
	}
	if err := binaryAcceptance.update(func() {
		evidence.Actions = append(evidence.Actions, acceptanceLifecycleAction{Action: action, Before: before, After: after, Output: output + "HTTP requests: " + string(encoded) + "\n"})
	}); err != nil {
		t.Fatal("cannot persist installed assignment evidence")
	}
}

func acceptanceAssignmentNative(t *testing.T, fixture *acceptanceFixture, task api.Task) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	var assignedTo *string
	var allowed bool
	var version int64
	if err := fixture.admin.QueryRow(ctx, "SELECT assigned_to::text,allow_agents,version FROM tasks WHERE id=$1", task.ID).Scan(&assignedTo, &allowed, &version); err != nil {
		t.Fatal("cannot inspect native assignment storage")
	}
	if !reflect.DeepEqual(assignedTo, task.AssignedTo) || allowed != task.AllowAgents || version != task.Version {
		t.Fatal("installed assignment output differs from native stored assignment, permission or exact version")
	}
}

func acceptanceAssignmentMember(t *testing.T, fixture *acceptanceFixture, project api.Project) string {
	t.Helper()
	id := uuid.NewString()
	fixture.exec(t, "INSERT INTO users (id,uniauth_id,name,created_at,updated_at) VALUES ($1,$2,'Assignment colleague',statement_timestamp(),statement_timestamp())", id, "assignment-colleague-"+id)
	fixture.exec(t, "INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,'member')", project.ID, id)
	return id
}

func TestInstalledCLIAssignmentAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_assignment_writes_versions_and_execution", []string{"AS-C1-write", "AS-C1-version", "AS-C1-request-budget"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		cli.configure(t, process)
		evidence := newLifecycleEvidence(t, scenario)
		project := process.project(t, "Installed task assignment writes")
		self := acceptanceDecode[api.User](t, process.request(context.Background(), http.MethodGet, "/api/v1/me", nil, "assignment-fixture-principal"), http.StatusOK)
		other := acceptanceAssignmentMember(t, fixture, project)
		create := func(title string, options ...string) api.Task {
			output := cli.run(t, cli.caller, append([]string{"task", "create", "--project", project.ID, "--title", title, "--description", "Assignment material\nPreserve this content"}, options...)...)
			id := acceptanceCLIResourceID(t, output)
			task := process.readTask(t, api.Task{ID: id, ProjectID: project.ID})
			assignment := "unassigned"
			if task.AssignedTo != nil {
				assignment = *task.AssignedTo
			}
			if !strings.Contains(output, "Assigned to: "+assignment+"\n") || !strings.Contains(output, "Version: 1\n") {
				t.Fatal("installed creation text lost its assignment or exact initial version")
			}
			acceptanceAssignmentNative(t, fixture, task)
			acceptanceAssignmentSave(t, evidence, "create "+assignment, api.Task{}, task, output, nil)
			return task
		}
		unassigned := create("Default unassigned")
		if unassigned.AssignedTo != nil || unassigned.AllowAgents {
			t.Fatal("installed default creation assigned a user or enabled automation")
		}
		target := create("Explicit colleague", "--assigned-to", strings.ToUpper(other), "--depends-on", unassigned.ID)
		if target.AssignedTo == nil || *target.AssignedTo != other || target.AllowAgents {
			t.Fatal("installed explicit creation did not save its canonical assignee")
		}
		target = process.update(t, target, map[string]any{"properties": map[string]any{"pullRequests": []map[string]string{{"url": "opaque-assignment-reference", "title": "Saved material"}}}})
		update := func(before api.Task, assignment *string, allowed bool, changed, explicit bool, options ...string) api.Task {
			arguments := []string{"task", "update", before.ID, "--project", project.ID}
			reads := 1
			if explicit {
				arguments = append(arguments, "--if-version", strconv.FormatInt(before.Version, 10))
				reads = 0
			}
			start := acceptanceAssignmentMark(t, process, project)
			output := cli.run(t, cli.caller, append(arguments, options...)...)
			requests := acceptanceAssignmentBudget(t, process, project, start, reads, 1, 0)
			after := acceptanceCLITaskResource(t, cli.run(t, cli.caller, "task", "show", before.ID, "--project", project.ID, "--json"))
			version := before.Version
			if changed {
				version++
			}
			preserved := after
			preserved.AssignedTo, preserved.AllowAgents, preserved.Version, preserved.UpdatedAt = before.AssignedTo, before.AllowAgents, before.Version, before.UpdatedAt
			if !reflect.DeepEqual(after.AssignedTo, assignment) || after.AllowAgents != allowed || after.Version != version || !reflect.DeepEqual(preserved, before) || changed && !after.UpdatedAt.After(before.UpdatedAt) || !changed && !after.UpdatedAt.Equal(before.UpdatedAt) {
				t.Fatal("installed assignment update lost its version branch, permission effect or preserved task materials")
			}
			assignedText := "unassigned"
			if assignment != nil {
				assignedText = *assignment
			}
			if !strings.Contains(output, "Assigned to: "+assignedText+"\n") || !strings.Contains(output, "Version: "+strconv.FormatInt(version, 10)+"\n") {
				t.Fatal("installed update text lost its assignment or exact returned version")
			}
			acceptanceAssignmentNative(t, fixture, after)
			acceptanceAssignmentSave(t, evidence, strings.Join(options, " "), before, after, output, requests)
			return after
		}
		target = update(target, &other, true, true, true, "--allow-agents", "true")
		target = update(target, &other, true, false, true, "--assigned-to", strings.ToUpper(other))
		target = update(target, &other, true, false, true, "--assigned-to", strings.ToUpper(other), "--allow-agents", "true")
		target = update(target, &self.ID, false, true, true, "--assigned-to", self.ID, "--allow-agents", "true")
		target = update(target, &self.ID, true, true, true, "--allow-agents", "true")
		target = update(target, nil, false, true, true, "--clear-assigned-to")
		target = update(target, &other, false, true, false, "--assigned-to", other)
		beforeOmission := target
		start := acceptanceAssignmentMark(t, process, project)
		output := cli.run(t, cli.caller, "task", "update", target.ID, "--project", project.ID, "--description", "Assignment omitted; material changed")
		requests := acceptanceAssignmentBudget(t, process, project, start, 1, 1, 0)
		target = process.readTask(t, target)
		preserved := target
		preserved.Description, preserved.Version, preserved.UpdatedAt = beforeOmission.Description, beforeOmission.Version, beforeOmission.UpdatedAt
		if target.Description != "Assignment omitted; material changed" || target.Version != beforeOmission.Version+1 || !reflect.DeepEqual(preserved, beforeOmission) {
			t.Fatal("installed omitted assignment changed the saved assignee or other task materials")
		}
		acceptanceAssignmentSave(t, evidence, "update description with assignment omitted", beforeOmission, target, output, requests)
		fixture.exec(t, "UPDATE tasks SET version=$2 WHERE id=$1", target.ID, int64(9007199254740993))
		target = process.readTask(t, target)
		target = update(target, &self.ID, false, true, true, "--assigned-to", self.ID)
		target = update(target, &self.ID, false, false, false, "--assigned-to", strings.ToUpper(self.ID))
		acceptanceCLIRefusal(t, cli, process, evidence, target, "version_conflict", "task", "update", target.ID, "--project", project.ID, "--if-version", "9007199254740993", "--clear-assigned-to")
		shown := cli.run(t, cli.caller, "task", "show", target.ID, "--project", project.ID, "--json")
		fields := acceptanceCLIJSON[map[string]json.RawMessage](t, shown)
		if string(fields["assignedTo"]) != strconv.Quote(self.ID) || string(fields["version"]) != "9007199254740994" || !reflect.DeepEqual(acceptanceCLITaskResource(t, shown), target) {
			t.Fatal("installed JSON task output lost native assignment or its exact bigint version")
		}
		unassigned = acceptanceCLISetStatus(t, cli, process, evidence, unassigned, "in_progress")
		acceptanceCLIRefusal(t, cli, process, evidence, unassigned, "invalid_transition", "task", "update", unassigned.ID, "--project", project.ID, "--if-version", strconv.FormatInt(unassigned.Version, 10), "--assigned-to", other, "--title", "Must not persist")
		claimed := create("Assigned automatic execution", "--assigned-to", self.ID)
		claimed = update(claimed, &self.ID, true, true, true, "--allow-agents", "true")
		beforeClaim := claimed
		claim := map[string]any{"version": claimed.Version, "claimId": uuid.NewString(), "workerId": uuid.NewString(), "machine": map[string]string{"id": uuid.NewString(), "name": "Assignment acceptance"}, "platform": "linux", "agent": "codex", "agentControlMode": "herdr", "worktreeId": uuid.NewString()}
		claimed = acceptanceDecode[api.Task](t, process.request(context.Background(), http.MethodPost, acceptanceTaskPath(claimed)+"/worker-claim", claim, "assignment-claim"), http.StatusOK)
		// Claim comparisons use the same negotiated worker representation as CLI mutations.
		claimOutput := cli.run(t, cli.caller, "task", "show", claimed.ID, "--project", project.ID, "--json")
		claimed = acceptanceCLITaskResource(t, claimOutput)
		worker := acceptanceWorker(t, claimed.Properties)
		if worker == nil || worker.UserID != self.ID || worker.ClaimID != claim["claimId"] || worker.WorkerID != claim["workerId"] || worker.WorktreeID != claim["worktreeId"] || worker.AgentControlMode != "herdr" || claimed.AssignedTo == nil || *claimed.AssignedTo != self.ID {
			t.Fatal("worker claim did not retain the assigned execution owner")
		}
		acceptanceAssignmentSave(t, evidence, "worker claim with protocol-2 task representation", beforeClaim, claimed, claimOutput, nil)
		acceptanceCLIRefusal(t, cli, process, evidence, claimed, "invalid_transition", "task", "update", claimed.ID, "--project", project.ID, "--if-version", strconv.FormatInt(claimed.Version, 10), "--clear-assigned-to")
		sameClaim := update(claimed, &self.ID, true, false, true, "--assigned-to", strings.ToUpper(self.ID))
		if !reflect.DeepEqual(sameClaim, claimed) || !reflect.DeepEqual(acceptanceWorker(t, sameClaim.Properties), worker) {
			t.Fatal("installed same-assignee update changed the active execution claim")
		}
		process.signal(t)
		process.stopped(t, 0)
	})
	acceptanceCase(t, "installed_cli_assignment_filtered_pagination", []string{"AS-C1-list", "AS-C1-me-principal", "AS-C1-filter-before-pagination"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		cli.configure(t, process)
		evidence := newLifecycleEvidence(t, scenario)
		project := process.project(t, "Installed task assignment pagination")
		self := acceptanceDecode[api.User](t, process.request(context.Background(), http.MethodGet, "/api/v1/me", nil, "assignment-list-fixture-principal"), http.StatusOK)
		other := acceptanceAssignmentMember(t, fixture, project)
		prerequisite := process.task(t, project, "Unfinished prerequisite")
		for _, assignedTo := range []*string{nil, &self.ID, &other} {
			fixture.exec(t, `INSERT INTO tasks (id,project_id,title,assigned_to,allow_agents,required_platform,created_at,updated_at)
				SELECT gen_random_uuid(),$1,'Matching assignment '||n,$2,true,'linux',statement_timestamp()+interval '1 second',statement_timestamp()
				FROM generate_series(1,101) n`, project.ID, assignedTo)
			fixture.exec(t, `INSERT INTO tasks (id,project_id,title,assigned_to,allow_agents,required_platform,status,created_at,updated_at)
				SELECT gen_random_uuid(),$1,'Excluded assignment '||n,$2,n<>1,CASE WHEN n=2 THEN 'windows' ELSE 'linux' END,CASE WHEN n=3 THEN 'done' ELSE 'todo' END,statement_timestamp()-interval '1 second',statement_timestamp()
				FROM generate_series(1,4) n`, project.ID, assignedTo)
			fixture.exec(t, `INSERT INTO task_dependencies (project_id,task_id,depends_on_task_id)
				SELECT project_id,id,$3 FROM tasks WHERE project_id=$1 AND assigned_to IS NOT DISTINCT FROM $2::uuid AND title='Excluded assignment 4'`, project.ID, assignedTo, prerequisite.ID)
		}
		for _, selection := range []struct {
			name string
			id   *string
		}{{strings.ToUpper(other), &other}, {"me", &self.ID}, {"unassigned", nil}} {
			start := acceptanceAssignmentMark(t, process, project)
			output := cli.run(t, cli.caller, "task", "list", "--project", project.ID, "--assigned-to", selection.name, "--status", "todo", "--ready", "--allow-agents", "true", "--compatible-platform", "linux", "--json")
			requests := acceptanceAssignmentBudget(t, process, project, start, 0, 0, 2)
			items := acceptanceCLIJSON[[]api.Task](t, output)
			raw := acceptanceCLIJSON[[]map[string]json.RawMessage](t, output)
			if len(items) != 101 || len(raw) != 101 {
				t.Fatal("installed assignment list did not read both filtered pages")
			}
			ids := make([]string, len(items))
			for index, item := range items {
				ids[index] = item.ID
				if _, present := raw[index]["assignedTo"]; !present || !reflect.DeepEqual(item.AssignedTo, selection.id) || item.Status != "todo" || !item.Ready || !item.AllowAgents || item.RequiredPlatform == nil || *item.RequiredPlatform != "linux" || item.Version != 1 {
					t.Fatal("installed assignment list changed the assignment or combined query constraints")
				}
				if _, present := raw[index]["description"]; present {
					t.Fatal("installed assignment list changed the description-only JSON projection")
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			rows, err := fixture.admin.Query(ctx, "SELECT id::text FROM tasks WHERE project_id=$1 AND assigned_to IS NOT DISTINCT FROM $2::uuid AND title LIKE 'Matching assignment %' ORDER BY created_at,id", project.ID, selection.id)
			if err != nil {
				cancel()
				t.Fatal("cannot read assignment page membership from native storage")
			}
			var expected []string
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					rows.Close()
					cancel()
					t.Fatal("cannot decode native assignment page membership")
				}
				expected = append(expected, id)
			}
			err = rows.Err()
			rows.Close()
			cancel()
			if err != nil || !slices.Equal(ids, expected) {
				t.Fatal("installed assignment pagination changed native filtered membership or order")
			}
			acceptanceAssignmentSave(t, evidence, fmt.Sprintf("list assignedTo=%s combined filters; items=%d pages=2", selection.name, len(items)), api.Task{}, api.Task{}, output, requests)
		}
		start := acceptanceAssignmentMark(t, process, project)
		empty := cli.run(t, cli.caller, "task", "list", "--project", project.ID, "--assigned-to", "me", "--status", "in_progress", "--json")
		requests := acceptanceAssignmentBudget(t, process, project, start, 0, 0, 1)
		if items := acceptanceCLIJSON[[]api.Task](t, empty); items == nil || len(items) != 0 {
			t.Fatal("installed empty me list did not preserve its concrete empty array")
		}
		acceptanceAssignmentSave(t, evidence, "empty me page without identity request", api.Task{}, api.Task{}, empty, requests)
		text := cli.run(t, cli.caller, "task", "list", "--project", project.ID, "--assigned-to", "unassigned", "--status", "todo", "--ready", "--allow-agents", "true", "--compatible-platform", "linux")
		if strings.Count(text, "Assigned to: unassigned\n") != 101 || strings.Contains(text, "Description:") || strings.Contains(text, "Version:") {
			t.Fatal("installed assignment text list lost its assignee or summary projection")
		}
		process.signal(t)
		process.stopped(t, 0)
	})
}
