package task_test

import (
	"bytes"
	"context"
	"encoding/json"
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

func changeHTTPFixture(t *testing.T, logs io.Writer) (*store.Store, *resourceTestHandler, api.Task, string) {
	t.Helper()
	database, handler, task := stepsHTTPFixture(t, logs)
	seedHTTPStep(t, database, task.ID, "abcdef01", 0, "  title  ", "  # old\n<>&  ")
	seedHTTPStep(t, database, task.ID, "00000000", 1, "same", "other")
	return database, handler, task, taskPath(task) + "/steps"
}

func TestStepsHTTPChangeContentStatusAndNoOp(t *testing.T) {
	var logs bytes.Buffer
	database, handler, task, path := changeHTTPFixture(t, &logs)
	before := decodeResponse[api.StepsResource](t, projectRequest(handler, "GET", path, ""), 200)
	original := before.Steps[0]
	title, description := "  <改名&> 😀 \uFEFF  ", " # raw Markdown-secret\n\"\\\u2028\u2029  "
	response := projectRequest(handler, "PATCH", path+"/ABCDEF01", jsonBody(t, map[string]any{"version": 1, "title": title, "description": description}))
	current := decodeResponse[api.StepsResource](t, response, 200)
	if current.ProjectID != task.ProjectID || current.TaskID != task.ID || current.Version != 2 || current.Steps[0].ID != original.ID || current.Steps[0].Title != title || current.Steps[0].Description != description || current.Steps[0].CreatedAt != original.CreatedAt || current.Steps[0].Status != original.Status || current.Steps[1] != before.Steps[1] || response.Header().Get("Location") != "" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != handler.principal.UserID {
		t.Fatalf("paired edit: %+v", current)
	}
	if !bytes.Equal(response.Body.Bytes(), projectRequest(handler, "GET", path, "").Body.Bytes()) {
		t.Fatal("PATCH did not return frozen public collection")
	}
	response = projectRequest(handler, "PATCH", path+"/abcdef01", `{"version":2,"description":""}`)
	current = decodeResponse[api.StepsResource](t, response, 200)
	if current.Version != 3 || current.Steps[0].Title != title || current.Steps[0].Description != "" || current.Steps[0].CreatedAt != original.CreatedAt {
		t.Fatal("omitted title or clear semantics", current)
	}
	for _, status := range []string{"todo", "in_progress", "done", "skipped", "done", "in_progress"} {
		previous := current
		response = projectRequest(handler, "PUT", path+"/ABCDEF01/status", jsonBody(t, map[string]any{"version": current.Version, "status": status}))
		current = decodeResponse[api.StepsResource](t, response, 200)
		if current.Version != previous.Version+1 || string(current.Steps[0].Status) != status || current.Steps[0].Title != title || current.Steps[0].Description != "" || current.Steps[0].CreatedAt != original.CreatedAt || current.Steps[1] != before.Steps[1] {
			t.Fatal("status changed unrelated fields", current)
		}
	}
	for _, input := range []struct{ method, suffix, body string }{{"PATCH", "/abcdef01", jsonBody(t, map[string]any{"version": current.Version, "title": title})}, {"PUT", "/abcdef01/status", jsonBody(t, map[string]any{"version": current.Version, "status": "in_progress"})}} {
		snapshot := projectRequest(handler, "GET", path, "").Body.Bytes()
		logs.Reset()
		response = projectRequest(handler, input.method, path+input.suffix, input.body)
		noop := decodeResponse[api.StepsResource](t, response, 200)
		if !reflect.DeepEqual(noop, current) || !bytes.Equal(snapshot, response.Body.Bytes()) {
			t.Fatal("no-op changed full resource")
		}
		if !strings.Contains(logs.String(), `"outcome":"unchanged"`) || !strings.Contains(logs.String(), `"tx_outcome":"committed"`) || strings.Contains(logs.String(), `"phase":"persist"`) {
			t.Fatal("no-op business/transaction facts are conflated")
		}
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=$2,status='done' WHERE id=$1`, task.ID, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	maxBefore := projectRequest(handler, "GET", path, "").Body.Bytes()
	for _, input := range []struct{ method, suffix, body string }{{"PATCH", "/abcdef01", `{"version":9223372036854775807,"title":` + jsonBody(t, title) + `}`}, {"PUT", "/abcdef01/status", `{"version":9223372036854775807,"status":"in_progress"}`}} {
		response = projectRequest(handler, input.method, path+input.suffix, input.body)
		if response.Code != 200 || !bytes.Equal(maxBefore, response.Body.Bytes()) {
			t.Fatal("maximum version no-op changed bytes")
		}
	}
	assertProjectError(t, projectRequest(handler, "PATCH", path+"/abcdef01", `{"version":1,"title":`+jsonBody(t, title)+`}`), 409, "version_conflict")
	assertProjectError(t, projectRequest(handler, "PUT", path+"/abcdef01/status", `{"version":1,"status":"in_progress"}`), 409, "version_conflict")
	assertProjectError(t, projectRequest(handler, "PATCH", path+"/ffffffff", `{"version":9223372036854775807,"title":"x"}`), 404, "not_found")
	assertProjectError(t, projectRequest(handler, "PUT", path+"/ffffffff/status", `{"version":9223372036854775807,"status":"done"}`), 404, "not_found")
	assertProjectError(t, projectRequest(handler, "PATCH", path+"/abcdef01", `{"version":9223372036854775807,"title":"changed"}`), 409, "version_exhausted")
	assertProjectError(t, projectRequest(handler, "PUT", path+"/abcdef01/status", `{"version":9223372036854775807,"status":"todo"}`), 409, "version_exhausted")
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	for _, input := range []struct{ method, suffix, body string }{{"PATCH", "/ffffffff", `{"version":1,"title":"x"}`}, {"PUT", "/ffffffff/status", `{"version":1,"status":"todo"}`}} {
		assertProjectError(t, projectRequest(handler, input.method, path+input.suffix, input.body), 410, "task_deleted")
	}
	for _, sentinel := range []string{title, description, "Markdown-secret"} {
		if strings.Contains(logs.String(), sentinel) {
			t.Fatal("content entered diagnostic logs")
		}
	}
}

func TestStepsHTTPChangeStrictInputAndMethods(t *testing.T) {
	_, handler, _, path := changeHTTPFixture(t, io.Discard)
	for _, tc := range []struct {
		method, suffix string
		allowed        []string
		good           string
	}{{"PATCH", "/abcdef01", []string{"version", "title", "description"}, `{"version":1,"title":"x"}`}, {"PUT", "/abcdef01/status", []string{"version", "status"}, `{"version":1,"status":"todo"}`}} {
		t.Run(tc.method, func(t *testing.T) {
			bad := []string{"", `{}`, `null`, `[]`, `{`, tc.good + ` {}`, `{"version":1}`, `{"version":1,"version":1,"title":"x"}`}
			for _, field := range tc.allowed {
				for _, value := range []string{"null", "false", "[]", "{}"} {
					var input map[string]json.RawMessage
					if err := json.Unmarshal([]byte(tc.good), &input); err != nil {
						t.Fatal(err)
					}
					input[field] = json.RawMessage(value)
					encoded, err := json.Marshal(input)
					if err != nil {
						t.Fatal(err)
					}
					bad = append(bad, string(encoded))
				}
			}
			if tc.method == "PATCH" {
				bad = append(bad, `{"version":1,"title":"`+string([]byte{0xff})+`"}`)

				bad = append(bad, `{"version":1,"title":""}`, `{"version":1,"title":"\u0085"}`, `{"version":1,"title":"x","\u0074itle":"y"}`, `{"version":1,"title":"\ud800"}`, `{"version":1,"description":"\udfff"}`, `{"version":1,"description":"\u0000"}`, `{"version":1,"status":"todo"}`)
			} else {
				bad = append(bad, `{"version":1,"status":""}`, `{"version":1,"status":"DONE"}`, `{"version":1,"status":"\ud800"}`, `{"version":1,"status":"todo","\u0073tatus":"done"}`, `{"version":1,"title":"x"}`)
			}
			for _, field := range []string{"id", "createdAt", "updatedAt", "before", "after", "position", "unknown"} {
				bad = append(bad, strings.TrimSuffix(tc.good, "}")+`,"`+field+`":"x"}`)
			}
			for _, version := range []string{`0`, `-1`, `1.0`, `1e0`, `9223372036854775808`, `"1"`} {
				bad = append(bad, strings.Replace(tc.good, `"version":1`, `"version":`+version, 1))
			}
			for index, body := range bad {
				t.Run(fmt.Sprint(index), func(t *testing.T) {
					assertProjectError(t, projectRequest(handler, tc.method, path+tc.suffix, body), 400, "invalid_input")
				})
			}
			for _, suffix := range []string{"?", "?x=1", "?bad=%xx"} {
				assertProjectError(t, projectRequest(handler, tc.method, path+tc.suffix+suffix, tc.good), 400, "invalid_input")
			}
			for _, id := range []string{"abc", "000000000", "0000000g"} {
				endpoint := path + "/" + id
				if tc.method == "PUT" {
					endpoint += "/status"
				}
				assertProjectError(t, projectRequest(handler, tc.method, endpoint, tc.good), 400, "invalid_input")
			}
			request := httptest.NewRequest(tc.method, path+tc.suffix, strings.NewReader(tc.good))
			authorizeResourceRequest(handler, request)
			request.Header.Set("X-Request-ID", "project-test")
			request.Header.Set("Content-Type", "text/plain")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			assertProjectError(t, response, 400, "invalid_input")
			assertProjectError(t, projectRequest(handler, tc.method, path+tc.suffix, strings.TrimSuffix(tc.good, "}")+`,"description":"`+strings.Repeat("x", httpx.MaxJSONBody)+`"}`), 400, "invalid_input")
		})
	}
	for _, tc := range []struct {
		endpoint, allow string
		methods         []string
	}{{path, "GET, HEAD, POST", []string{"PATCH", "PUT", "DELETE"}}, {path + "/abcdef01", "GET, HEAD, PATCH, DELETE", []string{"POST", "PUT"}}, {path + "/abcdef01/status", "PUT", []string{"GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"}}} {
		for _, method := range tc.methods {
			response := projectRequest(handler, method, tc.endpoint, `{}`)
			if response.Code != 405 || response.Header().Get("Allow") != tc.allow || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("method %s %s: %d %s", method, tc.endpoint, response.Code, response.Header().Get("Allow"))
			}
		}
	}
	read := decodeResponse[api.StepsResource](t, projectRequest(handler, "GET", path, ""), 200)
	if read.Version != 1 || read.Steps[0].Title != "  title  " {
		t.Fatal("invalid inputs changed data")
	}
	response := projectRequest(handler, "PATCH", path+"/abcdef01", `{"version":1,"title":"�\ud83d\ude00\\ud800","description":"\ufeff"}`)
	resource := decodeResponse[api.StepsResource](t, response, 200)
	if resource.Steps[0].Title != "�😀\\ud800" || resource.Steps[0].Description != "\uFEFF" {
		t.Fatal("valid Unicode changed")
	}
	prefix := `{"version":2,"description":"`
	exact := prefix + strings.Repeat("X", httpx.MaxJSONBody-len(prefix)-len(`"}`)) + `"}`
	response = projectRequest(handler, "PATCH", path+"/abcdef01", exact)
	boundary := decodeResponse[api.StepsResource](t, response, 200)
	if len(exact) != httpx.MaxJSONBody || len(boundary.Steps[0].Description) != httpx.MaxJSONBody-len(prefix)-len(`"}`) || boundary.Version != 3 {
		t.Fatal("exact request boundary changed or truncated content")
	}

}

func TestStepsHTTPChangeCommittedResponseLossAndReconcile(t *testing.T) {
	for _, method := range []string{"PATCH", "PUT"} {
		for _, mode := range []string{"short", "failed", "canceled_before_body"} {
			t.Run(method+"/"+mode, func(t *testing.T) {
				var logs bytes.Buffer
				database, handler, _, path := changeHTTPFixture(t, &logs)
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
				suffix, body := "/ABCDEF01", `{"version":1,"title":"lost-title-secret","description":"lost-markdown-secret https://secret.invalid token-secret"}`
				if method == "PUT" {
					suffix += "/status"
					body = `{"version":1,"status":"todo"}`
				}
				request := httptest.NewRequest(method, path+suffix, strings.NewReader(body)).WithContext(ctx)
				authorizeResourceRequest(handler, request)
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("X-Request-ID", "steps-change-lost")
				writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: mode == "short"}
				handler.ServeHTTP(writer, request)
				if mode == "canceled_before_body" && writer.calls != 0 || mode != "canceled_before_body" && (writer.calls != 1 || writer.Code != 200) {
					t.Fatal("lost response retried or returned wrong status")
				}
				if !strings.Contains(logs.String(), `"tx_outcome":"committed"`) || !strings.Contains(logs.String(), `"written_bytes":0`) {
					t.Fatal("committed lost response facts missing")
				}
				request = httptest.NewRequest("GET", path+"/abcdef01", nil)
				authorizeResourceRequest(handler, request)
				request.Header.Set("X-Request-ID", "steps-change-lost.r1")
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				item := decodeResponse[api.StepResource](t, response, 200)
				if item.Version != 2 || method == "PATCH" && item.Step.Title != "lost-title-secret" || method == "PUT" && item.Step.Status != "todo" {
					t.Fatal("committed change not readable")
				}
				if !strings.Contains(logs.String(), `"read_kind":"reconcile"`) || !strings.Contains(logs.String(), `"outcome":"found"`) {
					t.Fatal("read-only current facts absent")
				}
				for _, sentinel := range []string{"lost-title-secret", "lost-markdown-secret", "secret.invalid", "token-secret", "private response failure"} {
					if strings.Contains(logs.String(), sentinel) {
						t.Fatal("content leaked into diagnostics")
					}
				}
			})
		}
	}
}
