package task_test

import (
	"bytes"
	"context"
	"encoding/json"
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

func moveHTTPFixture(t *testing.T, logs io.Writer) (*postgres.Store, *resourceTestHandler, api.Task, string) {
	t.Helper()
	database, handler, task := stepsHTTPFixture(t, logs)
	for index, id := range []string{"00000000", "abcdef01", "12345678", "fedcba98"} {
		seedHTTPStep(t, database, task.ID, id, index, "same", "# private-move-markdown")
	}
	return database, handler, task, taskPath(task) + "/steps"
}

func TestStepsHTTPMovePlacementsAndUnchangedReceipts(t *testing.T) {
	var logs bytes.Buffer
	database, handler, task, path := moveHTTPFixture(t, &logs)
	original := decodeResponse[api.StepsResource](t, projectRequest(handler, "GET", path, ""), 200)
	byID := map[string]api.TaskStep{}
	for _, step := range original.Steps {
		byID[step.ID] = step
	}
	version := int64(1)
	for _, tc := range []struct {
		id        string
		placement map[string]any
		order     []string
		changed   bool
	}{
		{"00000000", map[string]any{"after": "12345678"}, []string{"abcdef01", "12345678", "00000000", "fedcba98"}, true},
		{"FEDCBA98", map[string]any{"before": "ABCDEF01"}, []string{"fedcba98", "abcdef01", "12345678", "00000000"}, true},
		{"12345678", map[string]any{"position": "first"}, []string{"12345678", "fedcba98", "abcdef01", "00000000"}, true},
		{"fedcba98", map[string]any{"position": "last"}, []string{"12345678", "abcdef01", "00000000", "fedcba98"}, true},
		{"abcdef01", map[string]any{"before": "00000000"}, []string{"12345678", "abcdef01", "00000000", "fedcba98"}, false},
		{"00000000", map[string]any{"after": "ABCDEF01"}, []string{"12345678", "abcdef01", "00000000", "fedcba98"}, false},
		{"12345678", map[string]any{"position": "first"}, []string{"12345678", "abcdef01", "00000000", "fedcba98"}, false},
		{"fedcba98", map[string]any{"position": "last"}, []string{"12345678", "abcdef01", "00000000", "fedcba98"}, false},
	} {
		tc.placement["version"] = version
		logs.Reset()
		before := projectRequest(handler, "GET", path, "").Body.Bytes()
		response := projectRequest(handler, "PUT", path+"/"+tc.id+"/position", jsonBody(t, tc.placement))
		resource := decodeResponse[api.StepsResource](t, response, 200)
		if tc.changed {
			version++
		}
		if resource.ProjectID != task.ProjectID || resource.TaskID != task.ID || resource.Version != version || len(resource.Steps) != 4 || response.Header().Get("Location") != "" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != handler.principal.UserID {
			t.Fatal("move receipt metadata invalid")
		}
		for index, step := range resource.Steps {
			if step.ID != tc.order[index] || step != byID[step.ID] {
				t.Fatal("move changed identity/content/time or order")
			}
		}
		if !bytes.Equal(response.Body.Bytes(), projectRequest(handler, "GET", path, "").Body.Bytes()) {
			t.Fatal("move response differs from frozen GET collection")
		}
		if !tc.changed && (!bytes.Equal(before, response.Body.Bytes()) || strings.Contains(logs.String(), `"phase":"persist"`) || !strings.Contains(logs.String(), `"outcome":"unchanged"`)) {
			t.Fatal("no-op changed bytes or claimed persistence")
		}
		if !strings.Contains(logs.String(), `"operation":"move"`) || !strings.Contains(logs.String(), `"tx_outcome":"committed"`) || strings.Contains(logs.String(), "private-move-markdown") {
			t.Fatal("move diagnostics missing or leaked content")
		}
	}
	assertProjectError(t, projectRequest(handler, "PUT", path+"/abcdef01/position", `{"version":1,"after":"ABCDEF01"}`), 409, "version_conflict")
	assertProjectError(t, projectRequest(handler, "PUT", path+"/abcdef01/position", jsonBody(t, map[string]any{"version": version, "after": "ABCDEF01"})), 400, "invalid_input")
	assertProjectError(t, projectRequest(handler, "PUT", path+"/ffffffff/position", jsonBody(t, map[string]any{"version": version, "position": "first"})), 404, "not_found")
	assertProjectError(t, projectRequest(handler, "PUT", path+"/abcdef01/position", jsonBody(t, map[string]any{"version": version, "before": "ffffffff"})), 404, "not_found")
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=$2,status='done' WHERE id=$1`, task.ID, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	maxBefore := projectRequest(handler, "GET", path, "").Body.Bytes()
	response := projectRequest(handler, "PUT", path+"/12345678/position", `{"version":9223372036854775807,"position":"first"}`)
	if response.Code != 200 || !bytes.Equal(maxBefore, response.Body.Bytes()) {
		t.Fatal("maximum-version no-op changed full bytes")
	}
	assertProjectError(t, projectRequest(handler, "PUT", path+"/12345678/position", `{"version":9223372036854775807,"position":"last"}`), 409, "version_exhausted")
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, projectRequest(handler, "PUT", path+"/ffffffff/position", `{"version":1,"position":"first"}`), 410, "task_deleted")
}

func TestStepsHTTPMoveStrictInputAndMethods(t *testing.T) {
	_, handler, _, path := moveHTTPFixture(t, io.Discard)
	endpoint := path + "/abcdef01/position"
	good := `{"version":1,"position":"first"}`
	bad := []string{"", `{}`, `null`, `[]`, `{`, good + ` {}`, `{"version":1}`, `{"position":"first"}`, `{"version":1,"before":"00000000","after":"12345678"}`, `{"version":1,"before":"00000000","position":"first"}`, `{"version":1,"after":"00000000","position":"last"}`, `{"version":1,"position":"FIRST"}`, `{"version":1,"position":""}`, `{"version":1,"position":"middle"}`, `{"version":1,"first":true}`, `{"version":1,"last":true}`, `{"version":1,"position":"\ud800"}`, `{"version":1,"before":"\udfff"}`, `{"version":1,"position":"` + string([]byte{0xff}) + `"}`, `{"version":1,"position":"first","\u0070osition":"last"}`}
	for _, field := range []string{"version", "before", "after", "position"} {
		for _, value := range []string{"null", "false", "1", "[]", "{}"} {
			input := map[string]json.RawMessage{"version": json.RawMessage("1")}
			if field == "version" {
				input["position"] = json.RawMessage(`"first"`)
			}
			input[field] = json.RawMessage(value)
			encoded, err := json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			if field == "version" && value == "1" {
				continue
			}
			bad = append(bad, string(encoded))
		}
	}
	for _, version := range []string{`0`, `-1`, `1.0`, `1e0`, `9223372036854775808`, `"1"`} {
		bad = append(bad, strings.Replace(good, `"version":1`, `"version":`+version, 1))
	}
	for _, field := range []string{"id", "title", "description", "status", "createdAt", "updatedAt", "unknown"} {
		bad = append(bad, strings.TrimSuffix(good, "}")+`,"`+field+`":"x"}`)
	}
	for _, field := range []string{"before", "after"} {
		for _, id := range []string{"", "abc", "000000000", "0000000g"} {
			bad = append(bad, jsonBody(t, map[string]any{"version": 1, field: id}))
		}
	}
	for index, body := range bad {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			assertProjectError(t, projectRequest(handler, "PUT", endpoint, body), 400, "invalid_input")
		})
	}
	for _, suffix := range []string{"?", "?x=1", "?bad=%xx"} {
		assertProjectError(t, projectRequest(handler, "PUT", endpoint+suffix, good), 400, "invalid_input")
	}
	for _, id := range []string{"abc", "000000000", "0000000g"} {
		assertProjectError(t, projectRequest(handler, "PUT", path+"/"+id+"/position", good), 400, "invalid_input")
	}
	request := httptest.NewRequest("PUT", endpoint, strings.NewReader(good))
	authorizeResourceRequest(handler, request)
	request.Header.Set("X-Request-ID", "project-test")
	request.Header.Set("Content-Type", "text/plain")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertProjectError(t, response, 400, "invalid_input")
	assertProjectError(t, projectRequest(handler, "PUT", endpoint, `{"version":1,"position":"`+strings.Repeat("x", httpx.MaxJSONBody)+`"}`), 400, "invalid_input")
	for _, method := range []string{"GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"} {
		response := projectRequest(handler, method, endpoint, `{}`)
		if response.Code != 405 || response.Header().Get("Allow") != "PUT" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("position method fallback invalid")
		}
	}
	// Request whitespace is part of the 1 MiB budget and cannot change placement.
	exact := good + strings.Repeat(" ", httpx.MaxJSONBody-len(good))
	resource := decodeResponse[api.StepsResource](t, projectRequest(handler, "PUT", endpoint, exact), 200)
	if len(exact) != httpx.MaxJSONBody || resource.Version != 2 || resource.Steps[0].ID != "abcdef01" {
		t.Fatal("exact request boundary failed")
	}
}

func TestStepsHTTPMoveCommittedResponseLossAndReadOnlyReconcile(t *testing.T) {
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
			request := httptest.NewRequest("PUT", path+"/ABCDEF01/position", strings.NewReader(`{"version":1,"position":"last"}`)).WithContext(ctx)
			authorizeResourceRequest(handler, request)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Request-ID", "steps-move-lost")
			writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: mode == "short"}
			handler.ServeHTTP(writer, request)
			if mode == "canceled_before_body" && writer.calls != 0 || mode != "canceled_before_body" && (writer.calls != 1 || writer.Code != 200) {
				t.Fatal("lost response replayed or returned wrong status")
			}
			if !strings.Contains(logs.String(), `"tx_outcome":"committed"`) || !strings.Contains(logs.String(), `"written_bytes":0`) {
				t.Fatal("move committed response facts missing")
			}
			request = httptest.NewRequest("GET", path, nil)
			authorizeResourceRequest(handler, request)
			request.Header.Set("X-Request-ID", "steps-move-lost.r1")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			resource := decodeResponse[api.StepsResource](t, response, 200)
			if resource.Version != 2 || resource.Steps[3].ID != "abcdef01" || !strings.Contains(logs.String(), `"read_kind":"reconcile"`) || !strings.Contains(logs.String(), `"outcome":"current_state"`) {
				t.Fatal("move current order not reconciled")
			}
			if strings.Contains(logs.String(), "private-move-markdown") || strings.Contains(logs.String(), "private response failure") {
				t.Fatal("move content or errors leaked")
			}
		})
	}
}
