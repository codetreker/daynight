package task_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestStepsHTTPDeleteStrictInputScopeAndVersion(t *testing.T) {
	t.Run("protocol", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		endpoint := stepHTTPPath() + "/abcdef01"
		bad := []string{"", `{}`, `null`, `[]`, `{`, `{"version":1} {}`, `{"Version":1}`, `{"version":1,"version":1}`, `{"version":1,"\u0076ersion":1}`, `{"version":"\ud800"}`, `{"version":"` + string([]byte{0xff}) + `"}`}
		for _, value := range []string{"null", "false", "[]", "{}", "0", "-1", "1.0", "1e0", "9223372036854775808", `"1"`} {
			bad = append(bad, `{"version":`+value+`}`)
		}
		for _, field := range []string{"id", "title", "description", "status", "createdAt", "updatedAt", "before", "after", "position", "unknown"} {
			bad = append(bad, `{"version":1,"`+field+`":"x"}`)
		}
		for index, body := range bad {
			t.Run(fmt.Sprint(index), func(t *testing.T) {
				assertProjectError(t, projectRequest(h, "DELETE", endpoint, body), 400, "invalid_input")
			})
		}
		for _, suffix := range []string{"?", "?version=1", "?bad=%xx"} {
			assertProjectError(t, projectRequest(h, "DELETE", endpoint+suffix, `{"version":1}`), 400, "invalid_input")
		}
		for _, id := range []string{"abc", "000000000", "0000000g", testTaskID} {
			assertProjectError(t, projectRequest(h, "DELETE", stepHTTPPath()+"/"+id, `{"version":1}`), 400, "invalid_input")
		}
		request := httptest.NewRequest("DELETE", endpoint, strings.NewReader(`{"version":1}`))
		authorizeResourceRequest(h, request)
		request.Header.Set("X-Request-ID", "project-test")
		request.Header.Set("Content-Type", "text/plain")
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		assertProjectError(t, response, 400, "invalid_input")
		good := `{"version":1}`
		assertProjectError(t, projectRequest(h, "DELETE", endpoint, good+strings.Repeat(" ", httpx.MaxJSONBody-len(good)+1)), 413, "payload_too_large")
		for _, tc := range []struct{ endpoint, allow string }{{stepHTTPPath(), "GET, HEAD, POST"}, {endpoint + "/status", "PUT"}, {endpoint + "/position", "PUT"}} {
			response := projectRequest(h, "DELETE", tc.endpoint, good)
			assertProjectError(t, response, 405, "method_not_allowed")
			if response.Header().Get("Allow") != tc.allow {
				t.Fatal("incorrect DELETE fallback")
			}
		}
		response = projectRequest(h, "PUT", endpoint, `{}`)
		assertProjectError(t, response, 405, "method_not_allowed")
		if response.Header().Get("Allow") != "GET, HEAD, PATCH, DELETE" {
			t.Fatal("item Allow omitted DELETE")
		}
		if h.Steps.TotalCalls() != 0 {
			t.Fatal("protocol rejection invoked Step service")
		}
	})
	for _, tc := range []struct {
		name, id, code string
		version        int64
		status         int
	}{
		{"missing scoped child", "ffffffff", "not_found", 1, 404},
		{"missing before exhaustion", "ffffffff", "not_found", 9223372036854775807, 404},
		{"exhausted", "ABCDEF01", "version_exhausted", 9223372036854775807, 409},
		{"deleted parent", "ffffffff", "task_deleted", 1, 410},
		{"stale version", "ABCDEF01", "version_conflict", 1, 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Steps.DeleteFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error) {
				checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
				if id != strings.ToLower(tc.id) || input.Version != tc.version {
					t.Fatal("Delete scope or exact version changed")
				}
				return taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}, &model.Fault{Code: tc.code, Message: "Step deletion refused."}
			}
			assertProjectError(t, projectRequest(h, "DELETE", stepHTTPPath()+"/"+tc.id, jsonBody(t, map[string]any{"version": tc.version})), tc.status, tc.code)
		})
	}
	t.Run("exact request boundary", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		result := stepHTTPWrite(t, 2, stepHTTPRows()[1:], true)
		h.Steps.DeleteFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error) {
			checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
			if id != "abcdef01" || input.Version != 1 {
				t.Fatal("Delete input changed at byte boundary")
			}
			return result, nil
		}
		good := `{"version":1}`
		exact := good + strings.Repeat(" ", httpx.MaxJSONBody-len(good))
		response := projectRequest(h, "DELETE", stepHTTPPath()+"/ABCDEF01", exact)
		if len(exact) != httpx.MaxJSONBody || response.Code != 200 || !bytes.Equal(response.Body.Bytes(), result.JSON) {
			t.Fatal("exact request boundary changed receipt")
		}
	})
}

func TestStepsHTTPDeleteCommittedResponseLossAndReadOnlyReconcile(t *testing.T) {
	stepHTTPResponseLoss(t, "delete")
}

func TestStepsHTTPDeleteLifecycleReferencesAndIDReuse(t *testing.T) {
	var logs bytes.Buffer
	f, handler, task := stepsMaterialFixture(t, &logs)
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
	for index, id := range []string{"ABCDEF01", "fedcba98", "00000000", "12345678"} {
		canonical := strings.ToLower(id)
		from := 0
		next := []model.TaskStep{}
		for position, step := range current {
			if step.ID == canonical {
				from = position
			} else {
				next = append(next, step)
			}
		}
		for position := range next {
			next[position].Position = int64(position)
		}
		at := updated.Add(time.Duration(index+1) * time.Minute)
		f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: current, Operation: "delete", ID: canonical, From: int64(from), To: int64(len(current) - from - 1), Observed: at})
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
		f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: next, Refused: true})
		assertProjectError(t, projectRequest(handler, "DELETE", path+"/"+canonical, jsonBody(t, map[string]any{"version": header.Version})), 404, "not_found")
		f.expectStepsWrite(stepHTTPWritePlan{Header: header, Stale: true})
		assertProjectError(t, projectRequest(handler, "DELETE", path+"/"+canonical, jsonBody(t, map[string]any{"version": header.Version - 1})), 409, "version_conflict")
		current = next
	}
	f.expectStepsRead(header, current)
	if !bytes.Contains(projectRequest(handler, "GET", path, "").Body.Bytes(), []byte(`"steps":[]`)) {
		t.Fatal("last deletion omitted empty array")
	}
	f.expectAttachmentRead(metadata)
	file := projectRequest(handler, "GET", taskPath(task)+"/attachments/files/plan.md", "")
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
	parent := readHTTPTask(t, taskComponentHandler(t, f.store, io.Discard, f.principal), task)
	after := f.target
	after.Version = header.Version
	after.UpdatedAt = updated.Add(4 * time.Minute)
	f.expectRead(after)
	observed := readHTTPTask(t, taskComponentHandler(t, f.store, io.Discard, f.principal), task)
	observed.Version, observed.UpdatedAt = parent.Version, parent.UpdatedAt
	if !reflect.DeepEqual(observed, parent) {
		t.Fatal("Step deletion changed parent PR/business fields")
	}
	at := updated.Add(5 * time.Minute)
	candidate := model.TaskStep{ID: "abcdef01", Position: 0, Title: "new record", Status: model.TaskStepTodo, CreatedAt: at, UpdatedAt: at}
	f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: current, Operation: "add", Candidate: candidate, Observed: at})
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
