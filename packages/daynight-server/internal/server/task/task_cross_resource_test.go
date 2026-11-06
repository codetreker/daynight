package task_test

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestStepsHTTPDeletePreservesReferencedAttachment(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	task := createHTTPTask(t, handler, taskProject(t, handler).ID, "Attachment owner")
	attachmentPath := taskPath(task) + "/attachments/files/plans/evidence.bin"
	content := []byte{0, 0xff, 0x80, '\n', 'x'}
	attachmentRequest := func(method string, body []byte) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, attachmentPath, bytes.NewReader(body))
		authorizeResourceRequest(handler, request)
		request.Header.Set("X-Request-ID", "project-test")
		if method == http.MethodPut {
			request.Header.Set("Content-Type", "application/octet-stream")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	created := decodeResponse[api.Attachment](t, attachmentRequest(http.MethodPut, content), http.StatusCreated)
	if created.Path != "plans/evidence.bin" || created.SizeBytes != int64(len(content)) || created.ContentType != "application/octet-stream" {
		t.Fatalf("attachment creation: %+v", created)
	}
	stepsPath := taskPath(task) + "/steps"
	added := decodeResponse[api.StepsResource](t, projectRequest(handler, http.MethodPost, stepsPath, jsonBody(t, map[string]any{
		"version": task.Version, "id": "abcdef01", "title": "Review evidence", "description": "[Evidence](plans/evidence.bin)",
	})), http.StatusCreated)
	if len(added.Steps) != 1 || added.Steps[0].Description != "[Evidence](plans/evidence.bin)" {
		t.Fatal("step did not retain its attachment reference")
	}
	removed := decodeResponse[api.StepsResource](t, projectRequest(handler, http.MethodDelete, stepsPath+"/abcdef01", jsonBody(t, map[string]any{"version": added.Version})), http.StatusOK)
	if removed.Version != added.Version+1 || removed.Steps == nil || len(removed.Steps) != 0 {
		t.Fatalf("step deletion: %+v", removed)
	}
	page := decodeResponse[api.AttachmentPage](t, projectRequest(handler, http.MethodGet, taskPath(task)+"/attachments", ""), http.StatusOK)
	if len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], created) {
		t.Fatalf("step deletion changed attachment metadata: %+v", page)
	}
	read := attachmentRequest(http.MethodGet, nil)
	if read.Code != http.StatusOK || !bytes.Equal(read.Body.Bytes(), content) {
		t.Fatalf("step deletion changed attachment bytes: status=%d body=%x", read.Code, read.Body.Bytes())
	}
}

func TestThreadHTTPAgentPostPreservesActiveClaim(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPWorkerTask(t, handler, project.ID, "Thread owner"), map[string]any{"allowAgents": true})
	claimed := claimHTTPWorker(t, handler, task, workerClaimBody(task.Version))
	worker := apiWorker(t, claimed.Properties)
	if worker == nil || worker.State != "active" {
		t.Fatal("fixture did not create an active claim")
	}
	message := decodeResponse[api.ThreadMessage](t, projectRequest(handler, http.MethodPost, threadPath(claimed), jsonBody(t, map[string]any{
		"body": "Agent discussion", "claimId": worker.ClaimID,
	})), http.StatusCreated)
	if !message.Author.Agent || message.Author.UserID != handler.principal.UserID {
		t.Fatalf("agent attribution: %+v", message.Author)
	}
	read := readHTTPTask(t, handler, claimed)
	if !reflect.DeepEqual(read, claimed) || !reflect.DeepEqual(apiWorker(t, read.Properties), worker) {
		t.Fatal("agent post changed task or active worker claim")
	}
	page := decodeResponse[api.ThreadPage](t, projectRequest(handler, http.MethodGet, threadPath(claimed)+"?details=true", ""), http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].ID != message.ID || page.Items[0].Author.Execution == nil || page.Items[0].Author.Execution.ClaimID != worker.ClaimID || page.Items[0].Author.Execution.WorkerID != worker.WorkerID {
		t.Fatal("agent post lost verified execution attribution")
	}
}
