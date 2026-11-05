package server

import (
	"bytes"
	"context"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func moveHTTPFixture(t *testing.T, logs io.Writer) (*store.Store, *resourceTestHandler, api.Task, string) {
	t.Helper()
	database, handler, task := stepsHTTPFixture(t, logs)
	for index, id := range []string{"00000000", "abcdef01", "12345678", "fedcba98"} {
		seedHTTPStep(t, database, task.ID, id, index, "same", "# private-move-markdown")
	}
	return database, handler, task, taskPath(task) + "/steps"
}

func stepsHTTPFixture(t *testing.T, logs io.Writer) (*store.Store, *resourceTestHandler, api.Task) {
	t.Helper()
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, logs)
	project := decodeResponse[api.Project](t, projectRequest(handler, "POST", "/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Steps", RepoURL: "https://example.com/steps", ExpectedUserID: handler.principal.UserID})), 201)
	task := decodeResponse[api.Task](t, projectRequest(handler, "POST", "/api/v1/projects/"+project.ID+"/tasks", `{"title":"Parent"}`), 201)
	return database, handler, task
}

func seedHTTPStep(t *testing.T, database *store.Store, taskID, id string, position int, title, description string) {
	t.Helper()
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at)
 VALUES($1,$2,$3,$4,$5,'done','2026-11-03T10:11:12.123456Z','2026-11-03T11:12:13.654321Z')`, taskID, id, position, title, description); err != nil {
		t.Fatal(err)
	}
}

func TestStepsHTTPDeleteLifecycleReferencesAndIDReuse(t *testing.T) {
	var logs bytes.Buffer
	database, handler, task, path := moveHTTPFixture(t, &logs)
	for index, status := range []string{"todo", "in_progress", "done", "skipped"} {
		if _, err := database.Pool.Exec(context.Background(), `UPDATE task_steps SET status=$2 WHERE task_id=$1 AND position=$3`, task.ID, status, index); err != nil {
			t.Fatal(err)
		}
	}
	property := `[{"url":"opaque-pr-reference","title":"Evidence"}]`
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests',$2)`, task.ID, property); err != nil {
		t.Fatal(err)
	}
	attachmentPath := attachmentFilePath(task, "plan.md")
	payload := []byte("# Durable attachment\nReferences survive a Step deletion.\n")
	metadata := decodeResponse[api.Attachment](t, attachmentRequest(handler, "PUT", attachmentPath, "text/markdown", payload), 201)
	if _, err := database.Pool.Exec(context.Background(), `UPDATE task_steps SET description='[Plan](plan.md) https://reference-secret.invalid token-secret' WHERE task_id=$1 AND id='abcdef01'`, task.ID); err != nil {
		t.Fatal(err)
	}
	original := decodeResponse[api.StepsResource](t, projectRequest(handler, "GET", path, ""), 200)
	byID := map[string]api.TaskStep{}
	for _, step := range original.Steps {
		byID[step.ID] = step
	}
	parent := readHTTPTask(t, handler, task)
	version := int64(1)
	remaining := []string{"00000000", "abcdef01", "12345678", "fedcba98"}
	for _, id := range []string{"ABCDEF01", "fedcba98", "00000000", "12345678"} {
		response := projectRequest(handler, "DELETE", path+"/"+id, jsonBody(t, map[string]any{"version": version}))
		resource := decodeResponse[api.StepsResource](t, response, 200)
		version++
		canonical := strings.ToLower(id)
		next := make([]string, 0, len(remaining)-1)
		for _, existing := range remaining {
			if existing != canonical {
				next = append(next, existing)
			}
		}
		remaining = next
		if resource.ProjectID != task.ProjectID || resource.TaskID != task.ID || resource.Version != version || resource.Steps == nil || len(resource.Steps) != len(remaining) || response.Header().Get("Location") != "" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != handler.principal.UserID {
			t.Fatal("delete receipt metadata or empty array invalid")
		}
		for index, step := range resource.Steps {
			if step.ID != remaining[index] || step != byID[step.ID] {
				t.Fatal("deletion changed retained content/time or order")
			}
		}
		if !bytes.Equal(response.Body.Bytes(), projectRequest(handler, "GET", path, "").Body.Bytes()) {
			t.Fatal("DELETE and GET differ from frozen remaining collection")
		}
		assertProjectError(t, projectRequest(handler, "GET", path+"/"+canonical, ""), 404, "not_found")
		assertProjectError(t, projectRequest(handler, "DELETE", path+"/"+canonical, jsonBody(t, map[string]any{"version": version})), 404, "not_found")
		assertProjectError(t, projectRequest(handler, "DELETE", path+"/"+canonical, jsonBody(t, map[string]any{"version": version - 1})), 409, "version_conflict")
	}
	empty := projectRequest(handler, "GET", path, "")
	if !bytes.Contains(empty.Body.Bytes(), []byte(`"steps":[]`)) {
		t.Fatal("last deletion did not expose explicit empty array")
	}
	file := attachmentRequest(handler, "GET", attachmentPath, "", nil)
	if file.Code != 200 || !bytes.Equal(file.Body.Bytes(), payload) {
		t.Fatal("Step deletion removed or rewrote referenced attachment bytes")
	}
	attachments := decodeResponse[api.AttachmentPage](t, projectRequest(handler, "GET", taskPath(task)+"/attachments", ""), 200)
	if len(attachments.Items) != 1 || !reflect.DeepEqual(attachments.Items[0], metadata) {
		t.Fatal("Step deletion changed attachment metadata")
	}
	afterParent := readHTTPTask(t, handler, task)
	afterParent.Version, afterParent.UpdatedAt = parent.Version, parent.UpdatedAt
	if !reflect.DeepEqual(afterParent, parent) {
		t.Fatal("Step deletion changed parent PR/business fields")
	}
	recreated := decodeResponse[api.StepsResource](t, projectRequest(handler, "POST", path, jsonBody(t, map[string]any{"version": version, "id": "ABCDEF01", "title": "new record"})), 201)
	if len(recreated.Steps) != 1 || recreated.Version != version+1 || recreated.Steps[0].ID != "abcdef01" || recreated.Steps[0].Title != "new record" || recreated.Steps[0].Description != "" || recreated.Steps[0].Status != "todo" || !recreated.Steps[0].CreatedAt.After(byID["abcdef01"].CreatedAt) || recreated.Steps[0].CreatedAt != recreated.Steps[0].UpdatedAt {
		t.Fatal("ID reuse restored deleted data rather than creating new record")
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
