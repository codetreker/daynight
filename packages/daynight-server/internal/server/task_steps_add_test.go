package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestStepsHTTPAddPlacementCompleteResourceAndExactVersion(t *testing.T) {
	var logs bytes.Buffer
	database, handler, task := stepsHTTPFixture(t, &logs)
	path := taskPath(task) + "/steps"
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=9007199254740993 WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	title, markdown := "  <同名&> 😀 \uFEFF  ", "  # Markdown-secret\n\"\\\u2028\u2029  "
	version := int64(9007199254740993)
	var previous api.StepsResource
	for index, input := range []map[string]any{
		{"id": "ABCDEF01", "title": title, "description": markdown},
		{"id": "00000000", "title": title, "status": "done", "before": "ABCDEF01"},
		{"id": "12345678", "title": title, "status": "in_progress", "after": "00000000"},
		{"id": "fedcba98", "title": "\uFEFF", "status": "skipped"},
	} {
		input["version"] = version
		response := projectRequest(handler, "POST", path, jsonBody(t, input))
		result := decodeResponse[api.StepsResource](t, response, 201)
		if result.ProjectID != task.ProjectID || result.TaskID != task.ID || result.Version != version+1 || len(result.Steps) != index+1 || response.Header().Get("Location") != path+"/"+strings.ToLower(input["id"].(string)) || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != handler.principal.UserID || response.Body.Bytes()[response.Body.Len()-1] != '\n' {
			t.Fatalf("complete creation receipt: %d %s", response.Code, response.Body)
		}
		if index == 0 && (result.Steps[0].ID != "abcdef01" || result.Steps[0].Description != markdown || result.Steps[0].Status != "todo" || result.Steps[0].CreatedAt != result.Steps[0].UpdatedAt) {
			t.Fatal(result)
		}
		if index == 1 && result.Steps[1] != previous.Steps[0] {
			t.Fatal("insertion changed existing content time")
		}
		if index == 2 && (result.Steps[0].ID != "00000000" || result.Steps[1].ID != "12345678" || result.Steps[2].ID != "abcdef01" || result.Steps[0].Description != "") {
			t.Fatal(result)
		}
		read := projectRequest(handler, "GET", path, "")
		if !bytes.Equal(response.Body.Bytes(), read.Body.Bytes()) {
			t.Fatal("POST and public GET use different encoding or content")
		}
		version = result.Version
		previous = result
	}
	other := decodeResponse[api.Task](t, projectRequest(handler, "POST", taskCollection(task.ProjectID), `{"title":"other"}`), 201)
	decodeResponse[api.StepsResource](t, projectRequest(handler, "POST", taskPath(other)+"/steps", `{"version":1,"id":"abcdef01","title":"same"}`), 201)
	assertProjectError(t, projectRequest(handler, "POST", path, fmt.Sprintf(`{"version":%d,"id":"abcdef01","title":"duplicate","before":"ffffffff"}`, version)), 409, "step_id_conflict")
	assertProjectError(t, projectRequest(handler, "POST", path, `{"version":9007199254740993,"id":"abcdef01","title":"stale","before":"ffffffff"}`), 409, "version_conflict")
	assertProjectError(t, projectRequest(handler, "POST", path, fmt.Sprintf(`{"version":%d,"id":"eeeeeeee","title":"missing","after":"ffffffff"}`, version)), 404, "not_found")
	assertProjectError(t, projectRequest(handler, "POST", path+"/abcdef01", `{}`), 405, "method_not_allowed")
	for _, sentinel := range []string{title, markdown, "Markdown-secret"} {
		if strings.Contains(logs.String(), sentinel) {
			t.Fatal("Step content leaked into logs")
		}
	}
	for _, fact := range []string{`"component":"task_step"`, `"operation":"add"`, `"phase":"prepare"`, `"phase":"persist"`, `"phase":"commit"`, `"tx_outcome":"committed"`, `"response_outcome":"written"`, `"status":201`, `"written_bytes":`} {
		if !strings.Contains(logs.String(), fact) {
			t.Fatalf("missing diagnostic fact %s", fact)
		}
	}
}

func TestStepsHTTPAddStrictInputLeavesCompleteStateUnchanged(t *testing.T) {
	database, handler, task := stepsHTTPFixture(t, io.Discard)
	path := taskPath(task) + "/steps"
	base := `{"version":1,"id":"00000000","title":"x"}`
	bodies := []string{"", `null`, `[]`, `true`, `"x"`, `{`, `{} `, base + ` {}`, `{"Version":1,"id":"00000000","title":"x"}`,
		`{"version":1,"id":"00000000","\u0069d":"00000001","title":"x"}`, `{"version":1,"version":1,"id":"00000000","title":"x"}`,
		`{"version":1,"id":"00000000","title":"\ud800"}`, `{"version":1,"id":"00000000","title":"\udfff"}`, `{"version":1,"id":"00000000","title":"x","description":"\ud800x"}`,
		`{"version":1,"id":"00000000","title":"` + string([]byte{0xff}) + `"}`,
	}
	for _, field := range []string{"version", "id", "title", "description", "status", "before", "after"} {
		for _, value := range []string{"null", "false", "[]", "{}"} {
			input := map[string]json.RawMessage{"version": json.RawMessage("1"), "id": json.RawMessage(`"00000000"`), "title": json.RawMessage(`"x"`)}
			input[field] = json.RawMessage(value)
			encoded, err := json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			bodies = append(bodies, string(encoded))
		}
	}
	for _, version := range []string{`0`, `-1`, `1.0`, `1e0`, `9223372036854775808`, `"1"`} {
		bodies = append(bodies, `{"version":`+version+`,"id":"00000000","title":"x"}`)
	}
	for _, id := range []string{"", "0", "000000000", "0000000g", task.ID} {
		bodies = append(bodies, jsonBody(t, map[string]any{"version": 1, "id": id, "title": "x"}))
	}
	for _, title := range []string{"", " \t\n\u0085\u2000 ", "\x00"} {
		bodies = append(bodies, jsonBody(t, map[string]any{"version": 1, "id": "00000000", "title": title}))
	}
	for _, extra := range []string{`,"status":""`, `,"status":"DONE"`, `,"before":"bad"`, `,"after":"bad"`, `,"before":"00000001","after":"00000002"`, `,"description":"\u0000"`, `,"createdAt":"today"`, `,"updatedAt":"today"`, `,"position":0`, `,"unknown":"x"`} {
		bodies = append(bodies, strings.TrimSuffix(base, "}")+extra+"}")
	}
	for index, body := range bodies {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			assertProjectError(t, projectRequest(handler, "POST", path, body), 400, "invalid_input")
		})
	}
	for _, suffix := range []string{"?", "?x=1", "?bad=%xx"} {
		assertProjectError(t, projectRequest(handler, "POST", path+suffix, base), 400, "invalid_input")
	}
	request := httptest.NewRequest("POST", path, strings.NewReader(base))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "text/plain")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertProjectError(t, response, 400, "invalid_input")
	exact := strings.TrimSuffix(base, "}") + `,"description":"` + strings.Repeat("x", maxJSONBody-len(base)-len(`,"description":""`)) + `"}`
	if len(exact) != maxJSONBody {
		t.Fatalf("request boundary fixture %d", len(exact))
	}
	assertProjectError(t, projectRequest(handler, "POST", path, exact+" "), 400, "invalid_input")
	read := decodeResponse[api.StepsResource](t, projectRequest(handler, "GET", path, ""), 200)
	if read.Version != 1 || len(read.Steps) != 0 {
		t.Fatal("strict refusal changed parent or steps")
	}
	boundaryTask := decodeResponse[api.Task](t, projectRequest(handler, "POST", taskCollection(task.ProjectID), `{"title":"Request boundary"}`), 201)
	boundary := decodeResponse[api.StepsResource](t, projectRequest(handler, "POST", taskPath(boundaryTask)+"/steps", exact), 201)
	if len(boundary.Steps) != 1 || len(boundary.Steps[0].Description) != maxJSONBody-len(base)-len(`,"description":""`) {
		t.Fatal("exact 1 MiB request lost content")
	}
	// Literal replacement characters, valid surrogate pairs and a textual escape
	// are distinct from invalid JSON Unicode and round-trip without rewriting.
	body := `{"version":1,"id":"00000000","title":"�\ud83d\ude00\\ud800","description":""}`
	resource := decodeResponse[api.StepsResource](t, projectRequest(handler, "POST", path, body), 201)
	if resource.Steps[0].Title != "�😀\\ud800" {
		t.Fatal(resource)
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, projectRequest(handler, "POST", path, `{"version":9223372036854775807,"id":"12345678","title":"x"}`), 409, "version_exhausted")
}

type stepCommitCancelTracer struct {
	cancel    context.CancelFunc
	persisted bool
}

func (tracer *stepCommitCancelTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, "UPDATE tasks SET version=version+1,updated_at=$3") {
		tracer.persisted = true
	}
	return context.WithValue(ctx, stepTraceKey{}, strings.EqualFold(data.SQL, "commit") && tracer.persisted)
}

type stepTraceKey struct{}

func (tracer *stepCommitCancelTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if ctx.Value(stepTraceKey{}) == true {
		tracer.cancel()
	}
}

func TestStepsHTTPAddCommittedResponseLossAndReadOnlyReconciliation(t *testing.T) {
	for _, mode := range []string{"short", "failed", "canceled_before_body"} {
		t.Run(mode, func(t *testing.T) {
			var logs bytes.Buffer
			database, handler, task := stepsHTTPFixture(t, &logs)
			path := taskPath(task) + "/steps"
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
			request := httptest.NewRequest("POST", path, strings.NewReader(`{"version":1,"id":"ABCDEF01","title":"secret-title","description":"secret-markdown https://secret.invalid token-secret"}`)).WithContext(ctx)
			authorizeResourceRequest(handler, request)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Request-ID", "steps-lost")
			writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: mode == "short"}
			handler.ServeHTTP(writer, request)
			if mode == "canceled_before_body" && writer.calls != 0 || mode != "canceled_before_body" && (writer.calls != 1 || writer.Code != 201) {
				t.Fatalf("response replay or missing status: %d %d", writer.calls, writer.Code)
			}
			logBeforeRead := logs.String()
			outcome := "failed"
			if mode == "canceled_before_body" {
				outcome = mode
			}
			if !strings.Contains(logBeforeRead, `"tx_outcome":"committed"`) || !strings.Contains(logBeforeRead, `"response_outcome":"`+outcome+`"`) || !strings.Contains(logBeforeRead, `"written_bytes":0`) {
				t.Fatalf("commit/response facts missing: %s", logBeforeRead)
			}
			request = httptest.NewRequest("GET", path+"/abcdef01", nil)
			authorizeResourceRequest(handler, request)
			request.Header.Set("X-Request-ID", "steps-lost.r1")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			item := decodeResponse[api.StepResource](t, response, 200)
			if item.Version != 2 || item.Step.ID != "abcdef01" || item.Step.Title != "secret-title" {
				t.Fatal(item)
			}
			request = httptest.NewRequest("GET", path+"/ffffffff", nil)
			authorizeResourceRequest(handler, request)
			request.Header.Set("X-Request-ID", "steps-lost.r2")
			response = httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != 404 {
				t.Fatal(response.Code)
			}
			if !strings.Contains(logs.String(), `"read_kind":"reconcile"`) || !strings.Contains(logs.String(), `"outcome":"found"`) || !strings.Contains(logs.String(), `"outcome":"absent"`) || !strings.Contains(logs.String(), `"version":2`) {
				t.Fatal("reconciliation current facts missing")
			}
			for _, sentinel := range []string{"secret-title", "secret-markdown", "secret.invalid", "token-secret", "private response failure"} {
				if strings.Contains(logs.String(), sentinel) {
					t.Fatalf("leaked %s", sentinel)
				}
			}
			var count int
			var version int64
			if err := database.Pool.QueryRow(context.Background(), `SELECT version,(SELECT count(*) FROM task_steps WHERE task_id=$1) FROM tasks WHERE id=$1`, task.ID).Scan(&version, &count); err != nil || version != 2 || count != 1 {
				t.Fatal("read reconciliation replayed a write")
			}
		})
	}
}

func TestStepsHTTPAddSafeFailureMetadataAndErrorDetails(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	request := httptest.NewRequest("POST", "/steps", nil)
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{&service.Fault{Code: "step_id_conflict", Message: "fault-message-sentinel"}, 409, "step_id_conflict"},
		{&service.Fault{Code: "version_conflict", Message: "fault-message-sentinel"}, 409, "version_conflict"},
		{&service.Fault{Code: "version_exhausted", Message: "fault-message-sentinel"}, 409, "version_exhausted"},
		{&service.Fault{Code: "steps_limit_exceeded", Message: "fault-message-sentinel", StepsLimit: &service.StepsLimitDetails{EncodedBytes: 67108865, MaxEncodedBytes: 67108864}}, 409, "steps_limit_exceeded"},
		{&store.TransactionError{Phase: "cleanup", Cause: &service.Fault{Code: "step_id_conflict", Message: "fault-message-sentinel"}, Outcome: store.TransactionNotCommitted, CleanupFailed: true}, 500, "internal_error"},
		{&store.TransactionError{Phase: "commit", Cause: &pgconn.PgError{Code: "23505", Message: "database-message-sentinel", Detail: "database-detail-sentinel"}, Outcome: store.TransactionUnknown, CommitAttempted: true}, 500, "internal_error"},
		{errors.Join(&service.Fault{Code: "not_found", Message: "fault-message-sentinel"}, errors.New("cleanup-sentinel")), 500, "internal_error"},
	} {
		response := httptest.NewRecorder()
		writeStepsError(response, request, logger, "commit", tc.err)
		resource := decodeResponse[api.ErrorResponse](t, response, tc.status)
		if resource.Error.Code != tc.code {
			t.Fatal(resource)
		}
		if tc.code == "steps_limit_exceeded" && (!reflect.DeepEqual(resource.Error.Details.EncodedBytes, new(int64(67108865))) || *resource.Error.Details.MaxEncodedBytes != 67108864) {
			t.Fatal(resource)
		}
	}
	for _, sentinel := range []string{"fault-message-sentinel", "database-message-sentinel", "database-detail-sentinel", "cleanup-sentinel"} {
		if strings.Contains(logs.String(), sentinel) {
			t.Fatal("arbitrary error text entered logs")
		}
	}
	if !strings.Contains(logs.String(), `"sqlstate":"23505"`) {
		t.Fatal("SQLSTATE cause missing")
	}
	for _, value := range []string{"", "secret", "23x05"} {
		if validSQLState(value) {
			t.Fatal("unsafe SQLSTATE accepted")
		}
	}
	for _, id := range []string{"plain", "x.r0", "x.rbad", "x.r18446744073709551616"} {
		if stepsReadKind(id) != "normal" {
			t.Fatal(id)
		}
	}
}
