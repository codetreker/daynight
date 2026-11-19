package task

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

const relationProject = "a1111111-a111-4111-8111-a11111111111"
const relationGoal = "b2222222-b222-4222-8222-b22222222222"
const relationUser = "c3333333-c333-4333-8333-c33333333333"
const relationPath = "/api/v1/projects/" + relationProject + "/tasks/" + relationGoal + "/goal-dependencies"
const relationClear = `{"ifRevision":"9007199254740993","mode":"replace","prerequisites":[]}`

type relationOperations struct {
	t     *testing.T
	show  func(context.Context, model.Principal, string, string, model.PageRequest) (taskcore.GoalDependencies, error)
	edit  func(context.Context, model.Principal, string, string, taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error)
	calls atomic.Int32
}

func (s *relationOperations) ShowGoalDependencies(ctx context.Context, p model.Principal, project, goal string, page model.PageRequest) (taskcore.GoalDependencies, error) {
	s.calls.Add(1)
	if s.show == nil {
		s.t.Error("unexpected show")
		return taskcore.GoalDependencies{}, errors.New("unexpected show")
	}
	return s.show(ctx, p, project, goal, page)
}
func (s *relationOperations) EditGoalDependencies(ctx context.Context, p model.Principal, project, goal string, input taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error) {
	s.calls.Add(1)
	if s.edit == nil {
		s.t.Error("unexpected edit")
		return taskcore.GoalDependencyReceipt{}, errors.New("unexpected edit")
	}
	return s.edit(ctx, p, project, goal, input)
}

func relationFixture(t *testing.T, ops *relationOperations, output io.Writer) http.Handler {
	t.Helper()
	logger := slog.New(slog.NewJSONHandler(output, nil))
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, credential string) (model.Principal, error) {
		if kind != model.PATCredential || credential != "test-pat" {
			return model.Principal{}, authhttp.Failure()
		}
		return model.Principal{Kind: kind, UserID: relationUser, CredentialID: relationUser}, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	GoalDependencyRoutes(mux, ops, auth, logger)
	return httpx.RequestLogging(logger, httpx.LimitRequestTarget(logger, mux))
}

func relationRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer test-pat")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Request-ID", "relation-test")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestGoalDependencyHTTPReadAndReceipt(t *testing.T) {
	ops := &relationOperations{t: t}
	ops.show = func(_ context.Context, p model.Principal, project, goal string, page model.PageRequest) (taskcore.GoalDependencies, error) {
		if p.UserID != relationUser || project != relationProject || goal != relationGoal || page.Limit != 7 || page.Cursor == nil || *page.Cursor != "page-token" {
			t.Fatalf("read propagation: %+v %s %s %+v", p, project, goal, page)
		}
		revision := int64(9007199254740993)
		edge := relationUser
		return taskcore.GoalDependencies{GoalID: goal, CanEdit: true, Revision: &revision, CompletionBlocked: true, Prerequisites: []taskcore.GoalDependencyPrerequisite{{EdgeID: &edge}}, NextCursor: page.Cursor}, nil
	}
	ops.edit = func(_ context.Context, p model.Principal, project, goal string, input taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error) {
		if p.UserID != relationUser || project != relationProject || goal != relationGoal || !reflect.DeepEqual(input, taskcore.GoalDependencyEdit{IfRevision: 9007199254740993, Mode: "replace", Prerequisites: []taskcore.GoalDependencyReference{}}) {
			t.Fatalf("write propagation: %+v %s %s %+v", p, project, goal, input)
		}
		return taskcore.GoalDependencyReceipt{GoalID: goal, Revision: input.IfRevision + 1, Changed: true}, nil
	}
	h := relationFixture(t, ops, io.Discard)
	w := relationRequest(h, "GET", relationPath+"?limit=7&cursor=page-token", "")
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Daynight-User-ID") != relationUser || !strings.Contains(w.Body.String(), `"revision":"9007199254740993"`) || !strings.Contains(w.Body.String(), `"target":null`) || !strings.Contains(w.Body.String(), `"nextCursor":"page-token"`) {
		t.Fatalf("read response: %d %v %s", w.Code, w.Header(), w.Body)
	}
	w = relationRequest(h, "PATCH", relationPath, relationClear)
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || w.Body.String() != `{"goalId":"`+relationGoal+`","revision":"9007199254740994","changed":true}`+"\n" || ops.calls.Load() != 2 {
		t.Fatalf("receipt: %d %s calls=%d", w.Code, w.Body, ops.calls.Load())
	}
}

func TestGoalDependencyHTTPRejectsBeforeBusinessWork(t *testing.T) {
	for _, tc := range []struct{ method, path, body string }{
		{"GET", strings.Replace(relationPath, relationProject, "bad", 1), ""},
		{"GET", strings.Replace(relationPath, relationGoal, "bad", 1), ""},
		{"GET", relationPath + "?limit=0", ""}, {"GET", relationPath + "?limit=51", ""},
		{"GET", relationPath + "?limit=abc", ""}, {"GET", relationPath + "?limit=1&limit=2", ""},
		{"GET", relationPath + "?cursor=", ""}, {"GET", relationPath + "?unknown=true", ""},
		{"GET", relationPath + "?limit=%zz", ""},
		{"PATCH", relationPath + "?limit=1", relationClear},
		{"PATCH", strings.Replace(relationPath, relationGoal, "bad", 1), relationClear},
		{"PATCH", relationPath, `{"ifRevision":1,"mode":"replace","prerequisites":[]}`},
		{"PATCH", relationPath, `{"ifRevision":"1","mode":"replace","prerequisites":null}`},
		{"PATCH", relationPath, `{"ifRevision":"1","mode":"replace","prerequisites":[],"mode":"edit"}`},
	} {
		t.Run(tc.method+tc.path+tc.body, func(t *testing.T) {
			ops := &relationOperations{t: t}
			w := relationRequest(relationFixture(t, ops, io.Discard), tc.method, tc.path, tc.body)
			if w.Code != 400 || !strings.Contains(w.Body.String(), `"code":"invalid_input"`) || ops.calls.Load() != 0 || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("refusal: %d %s calls=%d", w.Code, w.Body, ops.calls.Load())
			}
		})
	}
}

func TestGoalDependencyHTTPAuthenticationMethodsAndDefaults(t *testing.T) {
	ops := &relationOperations{t: t, show: func(_ context.Context, _ model.Principal, _, goal string, page model.PageRequest) (taskcore.GoalDependencies, error) {
		if page.Limit != 20 || page.Cursor != nil {
			t.Fatalf("default page: %+v", page)
		}
		return taskcore.GoalDependencies{GoalID: goal}, nil
	}}
	h := relationFixture(t, ops, io.Discard)
	w := relationRequest(h, "GET", relationPath, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"prerequisites":[]`) || strings.Contains(w.Body.String(), `"revision"`) {
		t.Fatalf("default read: %d %s", w.Code, w.Body)
	}
	w = relationRequest(h, "POST", relationPath, "")
	if w.Code != 405 || w.Header().Get("Allow") != "GET, HEAD, PATCH" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("method: %d %v", w.Code, w.Header())
	}
	r := httptest.NewRequest("GET", relationPath, nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 || ops.calls.Load() != 1 {
		t.Fatalf("authentication: %d %s calls=%d", w.Code, w.Body, ops.calls.Load())
	}
}

func TestGoalDependencyHTTPErrorMappingAndNoReplay(t *testing.T) {
	for code, status := range map[string]int{"goal_dependency_revision_conflict": 409, "goal_dependency_cycle": 409, "goal_dependency_team_mismatch": 409, "goal_dependency_unsatisfied": 409, "goal_dependency_done_successor": 409, "goal_dependency_referenced": 409, "goal_dependency_target_unavailable": 400, "version_exhausted": 409, "write_outcome_unknown": 503, "not_found": 404, "task_deleted": 410, "forbidden": 403} {
		for _, method := range []string{"GET", "PATCH"} {
			t.Run(method+code, func(t *testing.T) {
				failure := &model.Fault{Code: code, Message: "Operation refused."}
				ops := &relationOperations{t: t, show: func(context.Context, model.Principal, string, string, model.PageRequest) (taskcore.GoalDependencies, error) {
					return taskcore.GoalDependencies{}, failure
				}, edit: func(context.Context, model.Principal, string, string, taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error) {
					return taskcore.GoalDependencyReceipt{}, failure
				}}
				w := relationRequest(relationFixture(t, ops, io.Discard), method, relationPath, relationClear)
				if w.Code != status || !strings.Contains(w.Body.String(), `"code":"`+code+`"`) || !strings.Contains(w.Body.String(), `"requestId":"relation-test"`) || ops.calls.Load() != 1 {
					t.Fatalf("error mapping: %d %s calls=%d", w.Code, w.Body, ops.calls.Load())
				}
			})
		}
	}
	for _, method := range []string{"GET", "PATCH"} {
		t.Run(method+"internal", func(t *testing.T) {
			failure := errors.New("private SQL and target")
			ops := &relationOperations{t: t, show: func(context.Context, model.Principal, string, string, model.PageRequest) (taskcore.GoalDependencies, error) {
				return taskcore.GoalDependencies{}, failure
			}, edit: func(context.Context, model.Principal, string, string, taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error) {
				return taskcore.GoalDependencyReceipt{}, failure
			}}
			w := relationRequest(relationFixture(t, ops, io.Discard), method, relationPath, relationClear)
			if w.Code != 500 || strings.Contains(w.Body.String(), "private") || ops.calls.Load() != 1 {
				t.Fatalf("internal error: %d %s", w.Code, w.Body)
			}
		})
	}
}

func TestGoalDependencyHTTPCancellationPropagatesAndDrains(t *testing.T) {
	for _, method := range []string{"GET", "PATCH"} {
		t.Run(method, func(t *testing.T) {
			started := make(chan struct{})
			ops := &relationOperations{t: t}
			block := func(ctx context.Context) error { close(started); <-ctx.Done(); return ctx.Err() }
			ops.show = func(ctx context.Context, _ model.Principal, _, _ string, _ model.PageRequest) (taskcore.GoalDependencies, error) {
				return taskcore.GoalDependencies{}, block(ctx)
			}
			ops.edit = func(ctx context.Context, _ model.Principal, _, _ string, _ taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error) {
				return taskcore.GoalDependencyReceipt{}, block(ctx)
			}
			h := relationFixture(t, ops, io.Discard)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			r := httptest.NewRequest(method, relationPath, strings.NewReader(relationClear)).WithContext(ctx)
			r.Header.Set("Authorization", "Bearer test-pat")
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			done := make(chan struct{})
			go func() { defer close(done); h.ServeHTTP(w, r) }()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("business work did not start")
			}
			cancel()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("business work did not exit")
			}
			if ops.calls.Load() != 1 || w.Body.Len() != 0 {
				t.Fatalf("cancellation: calls=%d body=%s", ops.calls.Load(), w.Body)
			}
		})
	}
}

type relationFailWriter struct{ header http.Header }

func (w *relationFailWriter) Header() http.Header     { return w.header }
func (*relationFailWriter) WriteHeader(int)           {}
func (*relationFailWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestGoalDependencyHTTPTransportFailureDoesNotRepeatWrite(t *testing.T) {
	var logs bytes.Buffer
	ops := &relationOperations{t: t, edit: func(context.Context, model.Principal, string, string, taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error) {
		return taskcore.GoalDependencyReceipt{GoalID: relationGoal, Revision: 2}, nil
	}}
	h := relationFixture(t, ops, &logs)
	r := httptest.NewRequest("PATCH", relationPath, strings.NewReader(relationClear))
	r.Header.Set("Authorization", "Bearer test-pat")
	r.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(&relationFailWriter{header: http.Header{}}, r)
	if ops.calls.Load() != 1 || !strings.Contains(logs.String(), `"phase":"response"`) {
		t.Fatalf("transport failure: calls=%d logs=%s", ops.calls.Load(), &logs)
	}
}

func TestGoalDependencyHTTPBodyReadFailure(t *testing.T) {
	ops := &relationOperations{t: t}
	h := relationFixture(t, ops, io.Discard)
	r := httptest.NewRequest("PATCH", relationPath, strings.NewReader(relationClear))
	r.Header.Set("Authorization", "Bearer test-pat")
	r.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 || ops.calls.Load() != 0 {
		t.Fatalf("body refusal: %d %s", w.Code, w.Body)
	}
}

func TestGoalDependencyHTTPUnconfirmedCommit(t *testing.T) {
	var logs bytes.Buffer
	ops := &relationOperations{t: t, edit: func(context.Context, model.Principal, string, string, taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error) {
		return taskcore.GoalDependencyReceipt{}, &service.GoalWriteUnknown{Cause: &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private SQL")}}
	}}
	w := relationRequest(relationFixture(t, ops, &logs), "PATCH", relationPath, relationClear)
	if w.Code != 503 || !strings.Contains(w.Body.String(), `"code":"write_outcome_unknown"`) || strings.Contains(w.Body.String(), "private") || !strings.Contains(logs.String(), `"tx_outcome":"unknown"`) || ops.calls.Load() != 1 {
		t.Fatalf("unknown commit: %d %s logs=%s calls=%d", w.Code, w.Body, &logs, ops.calls.Load())
	}
}
