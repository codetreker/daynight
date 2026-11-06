package task_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"math"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/jackc/pgx/v5/pgxpool"
)

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
				handler = projectTestHandler(t, &postgres.Store{Pool: pool}, &logs)
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
