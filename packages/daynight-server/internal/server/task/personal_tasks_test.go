package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	protocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestPersonalTaskRoute(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		if kind != model.PATCredential || token != "test-pat" {
			return model.Principal{}, authhttp.Failure()
		}
		return testPrincipal(), nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	var fail error
	var badTime bool
	var noWorker bool
	goalID, goalTitle := testTaskID, "Goal"
	mux := http.NewServeMux()
	taskhttp.PersonalTaskRoutes(mux, func(ctx context.Context, p model.Principal, limit int, cursor *string) (service.PersonalTaskPage, error) {
		calls++
		if p != testPrincipal() || limit != 7 || cursor == nil || *cursor != "token" {
			t.Fatalf("unexpected input: %+v %d %v", p, limit, cursor)
		}
		if fail != nil {
			return service.PersonalTaskPage{}, fail
		}
		observed := testTime
		if badTime {
			observed = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
		}
		worker := &taskcore.PersonalTaskWorker{WorkerID: testUserID, Machine: model.WorkerMachine{ID: testProjectID, Name: "Machine <one>"}}
		if noWorker {
			worker = nil
		}
		return service.PersonalTaskPage{ObservedAt: observed, InventoryRevision: strings.Repeat("a", 64), TotalTaskCount: 1, TotalProjectCount: 1, SessionPartial: true, Items: []service.PersonalTaskItem{{Project: store.PersonalTaskProject{ID: testProjectID, Name: "Project", OwnerTeamID: testUserID, OwnerTeamKind: "personal", ExecutionWarningMinutes: 120}, Task: store.PersonalTaskRow{ID: testTaskID, Version: 9007199254740993, Title: "Task", GoalID: &goalID, GoalTitle: &goalTitle}, MatchedTaskCount: 1, Paused: true, Worker: worker, Session: sp.TaskSessionObservation{SchemaVersion: 1, Observation: "unavailable"}}}}, nil
	}, auth, logger)
	request := func(target, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, target, nil)
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	base := "/api/v1/me/in-progress-tasks"
	w := request(base+"?limit=7&cursor=token", "test-pat")
	var page protocol.PersonalTaskPage
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil {
		t.Fatalf("response %d %s", w.Code, w.Body)
	}
	if w.Header().Get("Daynight-User-ID") != testUserID || w.Header().Get("Cache-Control") != "no-store" || !page.SessionPartial || len(page.Items) != 1 || page.Items[0].Task.Version != "9007199254740993" || page.Items[0].Task.Goal.ID != goalID || !page.Items[0].Task.Paused || page.Items[0].Project.MatchedTaskCount != 1 {
		t.Fatalf("unexpected response: %+v headers %v", page, w.Header())
	}
	var raw map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	task := raw["items"].([]any)[0].(map[string]any)["task"].(map[string]any)
	worker := task["worker"].(map[string]any)
	machine := worker["machine"].(map[string]any)
	if len(worker) != 2 || len(machine) != 2 || worker["workerId"] != testUserID || machine["id"] != testProjectID || machine["name"] != "Machine <one>" {
		t.Fatalf("worker projection: %#v", worker)
	}
	noWorker = true
	if empty := request(base+"?limit=7&cursor=token", "test-pat"); empty.Code != 200 || !strings.Contains(empty.Body.String(), `"worker":null`) {
		t.Fatalf("missing explicit null: %d %s", empty.Code, empty.Body)
	}
	for _, query := range []string{"?limit=0", "?limit=101", "?limit=abc", "?limit=1&limit=2", "?cursor=", "?status=in_progress", "?limit=%zz"} {
		if w := request(base+query, "test-pat"); w.Code != 400 {
			t.Errorf("%s: %d %s", query, w.Code, w.Body)
		}
	}
	if calls != 2 {
		t.Fatalf("invalid input invoked service %d times", calls)
	}
	if w := request(base, "bad-secret"); w.Code != 401 {
		t.Fatalf("unauthenticated: %d", w.Code)
	}
	fail = &model.Fault{Code: "reset_required", Message: "changed"}
	if w := request(base+"?limit=7&cursor=token", "test-pat"); w.Code != 409 || !strings.Contains(w.Body.String(), "reset_required") {
		t.Fatalf("reset: %d %s", w.Code, w.Body)
	}
	fail = &service.PersonalTaskError{Phase: "recheck", Cause: errors.New("private SQL and secret")}
	if w := request(base+"?limit=7&cursor=token", "test-pat"); w.Code != 500 || strings.Contains(w.Body.String(), "secret") {
		t.Fatalf("failure: %d %s", w.Code, w.Body)
	}
	if !strings.Contains(logs.String(), `"phase":"recheck"`) {
		t.Fatalf("missing phase: %s", logs.String())
	}
	fail = nil
	badTime = true
	if w := request(base+"?limit=7&cursor=token", "test-pat"); w.Code != 500 || !strings.Contains(logs.String(), `"phase":"encode"`) {
		t.Fatalf("encode: %d %s %s", w.Code, w.Body, logs.String())
	}
	if strings.Contains(logs.String(), "private SQL and secret") || strings.Contains(logs.String(), "bad-secret") {
		t.Fatalf("sensitive data in logs: %s", logs.String())
	}
}
