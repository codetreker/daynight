package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"math"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/jackc/pgx/v5/pgxpool"
)

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

func TestStepsHTTPDeleteStrictInputScopeAndVersion(t *testing.T) {
	database, handler, task, path := moveHTTPFixture(t, io.Discard)
	endpoint := path + "/abcdef01"
	bad := []string{"", `{}`, `null`, `[]`, `{`, `{"version":1} {}`, `{"Version":1}`, `{"version":1,"version":1}`, `{"version":1,"\u0076ersion":1}`, `{"version":"\ud800"}`, `{"version":"` + string([]byte{0xff}) + `"}`}
	for _, value := range []string{"null", "false", "[]", "{}", "0", "-1", "1.0", "1e0", "9223372036854775808", `"1"`} {
		bad = append(bad, `{"version":`+value+`}`)
	}
	for _, field := range []string{"id", "title", "description", "status", "createdAt", "updatedAt", "before", "after", "position", "unknown"} {
		bad = append(bad, `{"version":1,"`+field+`":"x"}`)
	}
	for index, body := range bad {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			assertProjectError(t, projectRequest(handler, "DELETE", endpoint, body), 400, "invalid_input")
		})
	}
	for _, suffix := range []string{"?", "?version=1", "?bad=%xx"} {
		assertProjectError(t, projectRequest(handler, "DELETE", endpoint+suffix, `{"version":1}`), 400, "invalid_input")
	}
	for _, id := range []string{"abc", "000000000", "0000000g", task.ID} {
		assertProjectError(t, projectRequest(handler, "DELETE", path+"/"+id, `{"version":1}`), 400, "invalid_input")
	}
	request := httptest.NewRequest("DELETE", endpoint, strings.NewReader(`{"version":1}`))
	authorizeResourceRequest(handler, request)
	request.Header.Set("X-Request-ID", "project-test")
	request.Header.Set("Content-Type", "text/plain")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertProjectError(t, response, 400, "invalid_input")
	good := `{"version":1}`
	assertProjectError(t, projectRequest(handler, "DELETE", endpoint, good+strings.Repeat(" ", httpx.MaxJSONBody-len(good)+1)), 400, "invalid_input")
	for _, tc := range []struct{ endpoint, allow string }{{path, "GET, HEAD, POST"}, {path + "/abcdef01/status", "PUT"}, {path + "/abcdef01/position", "PUT"}} {
		response := projectRequest(handler, "DELETE", tc.endpoint, `{"version":1}`)
		assertProjectError(t, response, 405, "method_not_allowed")
		if response.Header().Get("Allow") != tc.allow {
			t.Fatal("incorrect DELETE method fallback")
		}
	}
	response = projectRequest(handler, "PUT", endpoint, `{}`)
	assertProjectError(t, response, 405, "method_not_allowed")
	if response.Header().Get("Allow") != "GET, HEAD, PATCH, DELETE" {
		t.Fatal("item Allow omits DELETE")
	}
	other := createHTTPTask(t, handler, task.ProjectID, "Other")
	seedHTTPStep(t, database, other.ID, "ffffffff", 0, "Other", "Task local")
	assertProjectError(t, projectRequest(handler, "DELETE", path+"/ffffffff", `{"version":1}`), 404, "not_found")
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, projectRequest(handler, "DELETE", path+"/ffffffff", `{"version":9223372036854775807}`), 404, "not_found")
	assertProjectError(t, projectRequest(handler, "DELETE", endpoint, `{"version":9223372036854775807}`), 409, "version_exhausted")
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=1 WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	exact := good + strings.Repeat(" ", httpx.MaxJSONBody-len(good))
	resource := decodeResponse[api.StepsResource](t, projectRequest(handler, "DELETE", endpoint, exact), 200)
	if len(exact) != httpx.MaxJSONBody || resource.Version != 2 || len(resource.Steps) != 3 {
		t.Fatal("exact request boundary failed")
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, projectRequest(handler, "DELETE", path+"/ffffffff", `{"version":1}`), 410, "task_deleted")
}

func TestStepsHTTPDeleteCommittedResponseLossAndReadOnlyReconcile(t *testing.T) {
	for _, mode := range []string{"short", "failed", "canceled_before_body"} {
		t.Run(mode, func(t *testing.T) {
			var logs bytes.Buffer
			database, handler, _, path := moveHTTPFixture(t, &logs)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "canceled_before_body" {
				config := database.Pool.Config().Copy()
				config.ConnConfig.Tracer = &stepCommitCancelTracer{cancel: cancel}
				pool, err := pgxpool.NewWithConfig(context.Background(), config)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(pool.Close)
				handler = projectTestHandler(t, &store.Store{Pool: pool}, &logs)
			}
			request := httptest.NewRequest("DELETE", path+"/ABCDEF01", strings.NewReader(`{"version":1}`)).WithContext(ctx)
			authorizeResourceRequest(handler, request)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Request-ID", "steps-delete-lost")
			writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: mode == "short"}
			handler.ServeHTTP(writer, request)
			if mode == "canceled_before_body" && writer.calls != 0 || mode != "canceled_before_body" && (writer.calls != 1 || writer.Code != 200) {
				t.Fatal("lost delete response replayed or returned wrong status")
			}
			if !strings.Contains(logs.String(), `"tx_outcome":"committed"`) || !strings.Contains(logs.String(), `"written_bytes":0`) {
				t.Fatal("delete committed response facts missing")
			}
			request = httptest.NewRequest("GET", path+"/abcdef01", nil)
			authorizeResourceRequest(handler, request)
			request.Header.Set("X-Request-ID", "steps-delete-lost.r1")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != 404 || !strings.Contains(logs.String(), `"outcome":"absent"`) {
				t.Fatal("current target absence not observable")
			}
			request = httptest.NewRequest("GET", path, nil)
			authorizeResourceRequest(handler, request)
			request.Header.Set("X-Request-ID", "steps-delete-lost.r2")
			response = httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			resource := decodeResponse[api.StepsResource](t, response, 200)
			if resource.Version != 2 || len(resource.Steps) != 3 || resource.Steps[0].ID != "00000000" || resource.Steps[1].ID != "12345678" || resource.Steps[2].ID != "fedcba98" || !strings.Contains(logs.String(), `"read_kind":"reconcile"`) || !strings.Contains(logs.String(), `"outcome":"current_state"`) {
				t.Fatal("remaining current state or no-replay fact invalid")
			}
			if strings.Contains(logs.String(), "private-move-markdown") || strings.Contains(logs.String(), "private response failure") {
				t.Fatal("deleted content/error leaked")
			}
		})
	}
}
