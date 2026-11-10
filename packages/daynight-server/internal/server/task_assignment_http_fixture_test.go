package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

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
			legacy[field] = copyTaskHTTPSlice(stored[field])
		}
		result.Properties["worker"] = rawProperty(t, legacy)
	}
	return result
}

func assignmentHTTPCreate(f *taskHTTPFixture, declared model.Task, body string, input taskcore.CreateTask) (model.Task, *httptest.ResponseRecorder) {
	f.t.Helper()
	result := expectMutationHTTPCreate(f, input, declared, nil)
	response := projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), body)
	got := decodeResponse[api.Task](f.t, response, http.StatusCreated)
	platformHTTPCheck(f.t, got, assignmentHTTPAPI(f.t, *result))
	return copyTaskHTTPTask(*result), response
}

func assignmentHTTPUpdate(f *taskHTTPFixture, before, after model.Task, patch map[string]any, input taskcore.UpdateTask) model.Task {
	f.t.Helper()
	before, after = copyTaskHTTPTask(before), copyTaskHTTPTask(after)
	input.Version = before.Version
	expectMutationHTTPUpdate(f, before.ID, input, after, nil)
	got := updateHTTPTask(f.t, f.handler, assignmentHTTPAPI(f.t, before), patch)
	platformHTTPCheck(f.t, got, assignmentHTTPAPI(f.t, after))
	return copyTaskHTTPTask(after)
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
