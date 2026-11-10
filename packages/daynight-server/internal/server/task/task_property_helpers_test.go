package task_test

import (
	"context"
	"encoding/json"
	"maps"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func rawProperty(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func apiWorker(t *testing.T, properties api.TaskProperties) *api.WorkerClaim {
	t.Helper()
	raw, exists := properties["worker"]
	if !exists {
		return nil
	}
	var value *api.WorkerClaim
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		t.Fatalf("invalid worker property: %s: %v", raw, err)
	}
	return value
}

func apiPullRequests(t *testing.T, properties api.TaskProperties) []api.PullRequestProperty {
	t.Helper()
	raw, exists := properties["pullRequests"]
	if !exists {
		return nil
	}
	var value []api.PullRequestProperty
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		t.Fatalf("invalid pullRequests property: %s: %v", raw, err)
	}
	return value
}

func propertyTaskPath(task model.Task) string { return taskCollection(task.ProjectID) + "/" + task.ID }

func requirePropertyCall(t *testing.T, ctx context.Context, principal model.Principal, projectID, taskID string) {
	t.Helper()
	if ctx.Err() != nil || httpx.RequestID(ctx) != "project-test" || principal != testPrincipal() || projectID != testProjectID || taskID != testTaskID {
		t.Fatalf("property operation changed request identity or context: principal=%#v project=%s task=%s error=%v", principal, projectID, taskID, ctx.Err())
	}
}

func propertyHTTPActiveTask(t *testing.T) model.Task {
	t.Helper()
	task := testTask("Active execution")
	task.Status, task.Ready, task.AllowAgents = model.TaskInProgress, false, true
	task.StartedAt = &task.UpdatedAt
	raw, err := taskproperty.EncodeWorker(&model.WorkerClaim{
		ClaimID: testTaskID, State: model.WorkerActive, UserID: testUserID,
		WorkerID: testEpoch, Machine: model.WorkerMachine{ID: testProjectID, Name: "Fixture"},
		Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb,
		WorktreeID: testTaskID, Phase: model.WorkerExecuting, ClaimedAt: task.UpdatedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	task.Properties = maps.Clone(task.Properties)
	task.Properties["worker"] = raw
	return task
}
