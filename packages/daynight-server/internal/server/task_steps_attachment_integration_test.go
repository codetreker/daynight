package server

import (
	"bytes"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestStepsHTTPDeleteLifecycleReferencesAndIDReuse(t *testing.T) {
	var logs bytes.Buffer
	f, handler, task := stepsHTTPFixture(t, &logs)
	f.target.Properties = model.TaskProperties{"pullRequests": []byte(`[{"url":"opaque-pr-reference","title":"Evidence"}]`)}
	header := model.TaskHeader{ProjectID: task.ProjectID, ID: task.ID, Version: 1}
	original := []model.TaskStep{}
	created := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
	updated := time.Date(2026, 11, 3, 11, 12, 13, 654321000, time.UTC)
	for index, id := range []string{"00000000", "abcdef01", "12345678", "fedcba98"} {
		original = append(original, model.TaskStep{ID: id, Position: int64(index), Title: "same", Description: "# private-move-markdown", Status: []model.TaskStepStatus{model.TaskStepTodo, model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped}[index], CreatedAt: created, UpdatedAt: updated})
	}
	original[1].Description = "[Plan](plan.md) https://reference-secret.invalid token-secret"
	payload := []byte("# Durable attachment\nReferences survive a Step deletion.\n")
	metadata := f.referencedAttachment("plan.md", "text/markdown", payload)
	path := taskPath(task) + "/steps"
	current := append([]model.TaskStep(nil), original...)
	for _, id := range []string{"ABCDEF01", "fedcba98", "00000000", "12345678"} {
		canonical := strings.ToLower(id)
		next := []model.TaskStep{}
		for _, step := range current {
			if step.ID != canonical {
				next = append(next, step)
			}
		}
		for position := range next {
			next[position].Position = int64(position)
		}
		f.expectStepsWrite(stepHTTPWritePlan{ID: canonical, Delete: &taskservice.DeleteTaskStep{Version: header.Version}, ResultHeader: model.TaskHeader{ProjectID: header.ProjectID, ID: header.ID, Version: header.Version + 1}, ResultSteps: next})
		response := projectRequest(handler, "DELETE", path+"/"+id, jsonBody(t, map[string]any{"version": header.Version}))
		resource := decodeResponse[api.StepsResource](t, response, 200)
		header.Version++
		if resource.ProjectID != task.ProjectID || resource.TaskID != task.ID || resource.Version != header.Version || resource.Steps == nil || len(resource.Steps) != len(next) || response.Header().Get("Location") != "" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != handler.principal.UserID {
			t.Fatal("delete receipt metadata or explicit array invalid")
		}
		for position, step := range resource.Steps {
			expected := next[position]
			if step.ID != expected.ID || step.Title != expected.Title || step.Description != expected.Description || step.Status != expected.Status || step.CreatedAt != expected.CreatedAt || step.UpdatedAt != expected.UpdatedAt {
				t.Fatal("deletion changed retained content/time or order")
			}
		}
		f.expectStepsRead(header, next)
		if !bytes.Equal(response.Body.Bytes(), projectRequest(handler, "GET", path, "").Body.Bytes()) {
			t.Fatal("DELETE and GET differ from frozen remaining collection")
		}
		f.expectMissingStep(header, canonical)
		assertProjectError(t, projectRequest(handler, "GET", path+"/"+canonical, ""), 404, "not_found")
		f.expectStepsWrite(stepHTTPWritePlan{ID: canonical, Delete: &taskservice.DeleteTaskStep{Version: header.Version}, Refused: true})
		assertProjectError(t, projectRequest(handler, "DELETE", path+"/"+canonical, jsonBody(t, map[string]any{"version": header.Version})), 404, "not_found")
		f.expectStepsWrite(stepHTTPWritePlan{ID: canonical, Delete: &taskservice.DeleteTaskStep{Version: header.Version - 1}, Stale: true})
		assertProjectError(t, projectRequest(handler, "DELETE", path+"/"+canonical, jsonBody(t, map[string]any{"version": header.Version - 1})), 409, "version_conflict")
		current = next
	}
	f.expectStepsRead(header, current)
	if !bytes.Contains(projectRequest(handler, "GET", path, "").Body.Bytes(), []byte(`"steps":[]`)) {
		t.Fatal("last deletion omitted empty array")
	}
	f.expectAttachmentRead(metadata)
	file := attachmentRequest(handler, "GET", attachmentFilePath(task, "plan.md"), "", nil)
	if file.Code != 200 || !bytes.Equal(file.Body.Bytes(), payload) {
		t.Fatal("Step deletion removed or rewrote referenced bytes")
	}
	f.expectAttachmentRead(metadata)
	page := decodeResponse[api.AttachmentPage](t, projectRequest(handler, "GET", taskPath(task)+"/attachments", ""), 200)
	wantMetadata := api.Attachment{Path: metadata.Path, ContentType: metadata.ContentType, SizeBytes: metadata.SizeBytes, CreatedAt: metadata.CreatedAt, UpdatedAt: metadata.UpdatedAt}
	if len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], wantMetadata) {
		t.Fatal("Step deletion changed attachment metadata")
	}
	f.expectRead(f.target)
	parent := readHTTPTask(t, handler, task)
	after := f.target
	after.Version = header.Version
	after.UpdatedAt = updated.Add(4 * time.Minute)
	f.expectRead(after)
	observed := readHTTPTask(t, handler, task)
	observed.Version, observed.UpdatedAt = parent.Version, parent.UpdatedAt
	if !reflect.DeepEqual(observed, parent) {
		t.Fatal("Step deletion changed parent PR/business fields")
	}
	at := updated.Add(5 * time.Minute)
	candidate := model.TaskStep{ID: "abcdef01", Position: 0, Title: "new record", Status: model.TaskStepTodo, CreatedAt: at, UpdatedAt: at}
	f.expectStepsWrite(stepHTTPWritePlan{Add: &taskservice.AddTaskStep{Version: header.Version, ID: "ABCDEF01", Title: "new record"}, ResultHeader: model.TaskHeader{ProjectID: header.ProjectID, ID: header.ID, Version: header.Version + 1}, ResultSteps: []model.TaskStep{candidate}})
	recreated := decodeResponse[api.StepsResource](t, projectRequest(handler, "POST", path, jsonBody(t, map[string]any{"version": header.Version, "id": "ABCDEF01", "title": "new record"})), 201)
	if len(recreated.Steps) != 1 || recreated.Version != header.Version+1 || recreated.Steps[0].ID != "abcdef01" || recreated.Steps[0].Title != "new record" || recreated.Steps[0].Description != "" || recreated.Steps[0].Status != "todo" || !recreated.Steps[0].CreatedAt.After(original[1].CreatedAt) || recreated.Steps[0].CreatedAt != recreated.Steps[0].UpdatedAt {
		t.Fatal("ID reuse restored deleted data")
	}
	for _, sentinel := range []string{"private-move-markdown", "reference-secret.invalid", "token-secret"} {
		if strings.Contains(logs.String(), sentinel) {
			t.Fatal("deleted content/reference leaked into logs")
		}
	}
	if !strings.Contains(logs.String(), `"operation":"delete"`) || !strings.Contains(logs.String(), `"outcome":"changed"`) || !strings.Contains(logs.String(), `"tx_outcome":"committed"`) {
		t.Fatal("delete diagnostics missing")
	}
}
