//go:build integration

package main

import (
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	protocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	"github.com/google/uuid"
)

func serverAPIPersonalTaskNormalFlow(t *testing.T, f *fixture) {
	t.Helper()
	fixtureCopy := *f
	client := *f.client
	client.Transport = sessionWorkerTransport{next: client.Transport}
	fixtureCopy.client = &client
	f = &fixtureCopy
	personal := createProject(t, f, "Personal inventory project")
	team := requestJSON[api.Team](t, f, http.MethodPost, "/api/v1/teams", api.CreateTeamRequest{Name: "Inventory Team", ExpectedUserID: f.userID}, http.StatusCreated)
	project := requestJSON[api.Project](t, f, http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: "Team inventory project", RepoURL: "https://github.com/example/inventory-team", TeamID: &team.ID, ExpectedUserID: f.userID}, http.StatusCreated)
	goal := createTask(t, f, project, "Inventory Goal", map[string]any{"type": "goal"})
	if goal.Status != "todo" || goal.StartedAt != nil {
		t.Fatalf("new goal lifecycle differs: %+v", goal)
	}
	child := createTask(t, f, project, "Inventory child", map[string]any{"parentId": goal.ID, "assignedTo": f.userID, "status": "todo"})
	child = setStatus(t, f, child, "in_progress", nil)
	expectedGoal := goal
	expectedGoal.Status = "in_progress"
	expectedGoal.Version++
	goal = requestJSON[api.Task](t, f, http.MethodGet, taskPath(goal), nil, http.StatusOK)
	assertTaskContent(t, goal, expectedGoal)
	if goal.StartedAt == nil || goal.CompletedAt != nil || goal.CancelledAt != nil {
		t.Fatalf("started goal lifecycle differs: %+v", goal)
	}
	access := requestJSON[api.ProjectDocument](t, f, http.MethodGet, "/api/v1/projects/"+project.ID, nil, http.StatusOK).Access
	if access.DirectGrant == nil {
		t.Fatal("creator grant is absent")
	}
	removed := requestJSON[api.RemoveProjectGrantResult](t, f, http.MethodDelete, "/api/v1/projects/"+project.ID+"/grants/"+f.userID, map[string]any{"version": access.DirectGrant.Version, "expectedUserId": f.userID}, http.StatusOK)
	if removed.ActorAccess == nil || removed.ActorAccess.TeamRole == nil || removed.ActorAccess.DirectGrant != nil {
		t.Fatal("Team-only access was not retained")
	}
	independent := createTask(t, f, personal, "Personal inventory", map[string]any{"assignedTo": f.userID, "status": "todo"})
	independent = setStatus(t, f, independent, "in_progress", nil)
	tagsPath := "/api/v1/projects/" + personal.ID + "/tags"
	tag := requestJSON[catalogTag](t, f, http.MethodPost, tagsPath, map[string]any{"name": "Inventory tag"}, http.StatusCreated)
	workerTask := createTask(t, f, personal, "Worker inventory", map[string]any{"assignedTo": f.userID, "status": "todo", "requiredPlatform": "linux", "tagIds": []string{tag.ID}})
	workerTask = requestJSON[api.Task](t, f, http.MethodPatch, taskPath(workerTask), map[string]any{"version": workerTask.Version, "allowAgents": true}, http.StatusOK)
	claimID, workerID, machineID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	workerTask = requestJSON[api.Task](t, f, http.MethodPost, taskPath(workerTask)+"/worker-claim", map[string]any{"version": workerTask.Version, "claimId": claimID, "workerId": workerID, "machine": map[string]any{"id": machineID, "name": "Inventory machine"}, "platform": "linux", "agent": "codex", "agentControlMode": "web", "worktreeId": uuid.NewString()}, http.StatusOK)
	// Leave a Team after creating a direct grant, so this project is readable only through sharing.
	sharedTeam := requestJSON[api.Team](t, f, http.MethodPost, "/api/v1/teams", api.CreateTeamRequest{Name: "Shared inventory Team", ExpectedUserID: f.userID}, http.StatusCreated)
	shared := requestJSON[api.Project](t, f, http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: "Shared inventory project", RepoURL: "https://github.com/example/inventory-shared", TeamID: &sharedTeam.ID, ExpectedUserID: f.userID}, http.StatusCreated)
	sharedTask := createTask(t, f, shared, "Shared inventory", map[string]any{"assignedTo": f.userID, "status": "todo"})
	sharedTask = setStatus(t, f, sharedTask, "in_progress", nil)
	requestJSON[api.AddTeamMemberReceipt](t, f, http.MethodPost, "/api/v1/teams/"+sharedTeam.ID+"/members", map[string]any{"expectedUserId": f.userID, "user": map[string]any{"externalUserId": "inventory:" + uuid.NewString(), "profile": map[string]any{"name": "Other admin"}}, "role": "admin"}, http.StatusOK)
	requestJSON[api.RemoveTeamMemberReceipt](t, f, http.MethodDelete, "/api/v1/teams/"+sharedTeam.ID+"/members/"+f.userID, api.RemoveTeamMemberRequest{Version: sharedTeam.Membership.Version, ExpectedUserID: f.userID}, http.StatusOK)
	seen := map[string]protocol.PersonalTaskItem{}
	path := "/api/v1/me/in-progress-tasks?limit=1"
	revision := ""
	for {
		page := requestJSON[protocol.PersonalTaskPage](t, f, http.MethodGet, path, nil, http.StatusOK)
		if page.ResponseTaskAt.IsZero() || page.ResponseSessionAt.IsZero() {
			t.Fatal("response clocks missing")
		}
		if revision == "" {
			revision = page.InventoryRevision
		} else if revision != page.InventoryRevision {
			t.Fatal("inventory changed between pages")
		}
		for _, item := range page.Items {
			seen[item.Task.ID] = item
		}
		if page.NextCursor == nil {
			break
		}
		path = "/api/v1/me/in-progress-tasks?limit=1&cursor=" + *page.NextCursor
	}
	c, ok := seen[child.ID]
	if !ok || c.Project.ID != project.ID || c.Project.OwnerTeam.ID != team.ID || c.Task.Goal == nil || c.Task.Goal.ID != goal.ID || c.Session.Observation != "observed" {
		t.Fatalf("team child: %+v", c)
	}
	p, ok := seen[independent.ID]
	if !ok || p.Project.ID != personal.ID || p.Project.OwnerTeam.Kind != "personal" || p.Task.Goal != nil || p.Session.Observation != "observed" {
		t.Fatalf("personal task: %+v", p)
	}
	sharedItem, ok := seen[sharedTask.ID]
	if !ok || sharedItem.Project.ID != shared.ID || sharedItem.Project.OwnerTeam.ID != sharedTeam.ID || sharedItem.Session.Observation != "observed" {
		t.Fatalf("shared task: %+v", sharedItem)
	}
	workerItem, ok := seen[workerTask.ID]
	if !ok || workerItem.Task.Worker == nil || workerItem.Task.Worker.State != "active" || workerItem.Task.Worker.WorkerID != workerID || workerItem.Task.Worker.Machine.ID != machineID || workerItem.Task.Worker.Machine.Name != "Inventory machine" || workerItem.Task.CreatedAt.IsZero() || workerItem.Task.RequiredPlatform == nil || *workerItem.Task.RequiredPlatform != "linux" || len(workerItem.Task.Tags) != 1 || workerItem.Task.Tags[0].ID != tag.ID || workerItem.Task.Tags[0].Name != tag.Name || workerItem.Task.BlockedBy == nil || workerItem.Task.Ready {
		t.Fatalf("claimed worker missing: %+v", workerItem)
	}
	firstPage := requestJSON[protocol.PersonalTaskPage](t, f, http.MethodGet, "/api/v1/me/in-progress-tasks?limit=1", nil, http.StatusOK)
	if firstPage.NextCursor == nil {
		t.Fatal("expected continuation")
	}
	tag = requestJSON[catalogTag](t, f, http.MethodPatch, tagsPath+"/"+tag.ID, map[string]any{"version": tag.Version, "name": "Renamed inventory tag"}, http.StatusOK)
	reset := requestJSON[api.ErrorResponse](t, f, http.MethodGet, "/api/v1/me/in-progress-tasks?limit=1&cursor="+*firstPage.NextCursor, nil, http.StatusConflict)
	if reset.Error.Code != "reset_required" {
		t.Fatalf("tag rename did not reset inventory: %+v", reset)
	}
	workerTask = requestJSON[api.Task](t, f, http.MethodGet, taskPath(workerTask), nil, http.StatusOK)
	workerTask = setStatus(t, f, workerTask, "done", &claimID)
	workerTask = setStatus(t, f, workerTask, "in_progress", nil)
	page := requestJSON[protocol.PersonalTaskPage](t, f, http.MethodGet, "/api/v1/me/in-progress-tasks", nil, http.StatusOK)
	foundCompleted := false
	for _, item := range page.Items {
		if item.Task.ID == workerTask.ID {
			foundCompleted = true
			if item.Task.Worker == nil || item.Task.Worker.State != "completed" || item.Task.Worker.WorkerID != workerID || len(item.Task.Tags) != 1 || item.Task.Tags[0].Name != tag.Name || item.Session.Registration != "not_applicable" || item.Session.Reason != "no_execution" {
				t.Fatalf("manual restart retained incorrect execution: %+v", item)
			}
		}
	}
	if !foundCompleted {
		t.Fatal("reopened task absent")
	}
	workerTask = setStatus(t, f, workerTask, "todo", nil)
	newClaimID := uuid.NewString()
	workerTask = requestJSON[api.Task](t, f, http.MethodPost, taskPath(workerTask)+"/worker-claim", map[string]any{"version": workerTask.Version, "claimId": newClaimID, "workerId": workerID, "machine": map[string]any{"id": machineID, "name": "Inventory machine"}, "platform": "linux", "agent": "codex", "agentControlMode": "web", "worktreeId": uuid.NewString()}, http.StatusOK)
	workerTask = requestJSON[api.Task](t, f, http.MethodPost, taskPath(workerTask)+"/worker-claim/release", map[string]any{"version": workerTask.Version, "claimId": newClaimID, "stoppedConfirmed": true}, http.StatusOK)
	workerTask = setStatus(t, f, workerTask, "in_progress", nil)
	page = requestJSON[protocol.PersonalTaskPage](t, f, http.MethodGet, "/api/v1/me/in-progress-tasks", nil, http.StatusOK)
	foundReleased := false
	for _, item := range page.Items {
		if item.Task.ID == workerTask.ID {
			foundReleased = true
			if item.Task.Worker != nil {
				t.Fatalf("released worker retained: %+v", item.Task.Worker)
			}
		}
	}
	if !foundReleased {
		t.Fatal("released task absent after restart")
	}
	assertTaskContent(t, requestJSON[api.Task](t, f, http.MethodGet, taskPath(child), nil, http.StatusOK), child)
	goalReadback := requestJSON[api.Task](t, f, http.MethodGet, taskPath(goal), nil, http.StatusOK)
	assertTaskContent(t, goalReadback, goal)
	if goalReadback.StartedAt == nil || !goalReadback.StartedAt.Equal(*goal.StartedAt) || goalReadback.CompletedAt != nil || goalReadback.CancelledAt != nil {
		t.Fatalf("goal lifecycle readback differs: %+v", goalReadback)
	}
}
