package task_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

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
