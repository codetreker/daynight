package session

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

type groupRouteRead func(context.Context, model.Principal, string, core.HistoryDirectoryRequest) (core.HistoryDirectoryPage, error)

func (f groupRouteRead) Read(c context.Context, p model.Principal, id string, q core.HistoryDirectoryRequest) (core.HistoryDirectoryPage, error) {
	return f(c, p, id, q)
}

func TestGroupDirectoryRoutes(t *testing.T) {
	const project = "11111111-1111-4111-8111-111111111111"
	const target = "22222222-2222-4222-8222-222222222222"
	base := "/api/v1/projects/" + project + "/history-directory"
	p := model.Principal{Kind: model.PATCredential, UserID: "actor"}
	for _, test := range []struct {
		name, path, method, kind, target string
		status, calls                    int
		fail                             error
	}{
		{"groups", base, "GET", "groups", "", 200, 1, nil},
		{"members", base + "/" + target + "/members", "GET", "members", target, 200, 1, nil},
		{"sessions", base + "/tasks/" + target + "/sessions", "GET", "sessions", target, 200, 1, nil},
		{"query", base + "?cursor=old&limit=2", "GET", "groups", "", 200, 1, nil},
		{"head", base, "HEAD", "groups", "", 200, 1, nil},
		{"method", base, "POST", "", "", 405, 0, nil},
		{"unknown parameter", base + "?view=inspection", "GET", "", "", 400, 0, nil},
		{"duplicate", base + "?limit=1&limit=2", "GET", "", "", 400, 0, nil},
		{"limit", base + "?limit=201", "GET", "", "", 400, 0, nil},
		{"leading zero", base + "?limit=01", "GET", "", "", 400, 0, nil},
		{"cursor", base + "?cursor=" + strings.Repeat("x", 4097), "GET", "", "", 400, 0, nil},
		{"bad project", strings.Replace(base, project, "bad", 1), "GET", "", "", 400, 0, nil},
		{"bad target", base + "/bad/members", "GET", "", "", 400, 0, nil},
		{"revocation", base, "GET", "groups", "", 403, 1, &model.Fault{Code: "forbidden", Message: "denied"}},
		{"changed", base, "GET", "groups", "", 409, 1, &model.Fault{Code: "reset_required", Message: "restart"}},
		{"database failure", base, "GET", "groups", "", 500, 1, errors.New("private database detail")},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			reader := groupRouteRead(func(ctx context.Context, got model.Principal, id string, q core.HistoryDirectoryRequest) (core.HistoryDirectoryPage, error) {
				calls++
				if ctx.Err() != nil || got != p || id != project || q.Kind != test.kind || q.Target != test.target {
					t.Fatalf("wrong call: %v %s %+v", got, id, q)
				}
				if test.name == "query" {
					if q.Cursor != "old" || q.Limit != 2 {
						t.Fatal(q)
					}
				} else if q.Limit != 20 {
					t.Fatal(q)
				}
				return core.HistoryDirectoryPage{Version: 1, GraphVersion: "123", Items: []core.HistoryDirectoryGroup{}}, test.fail
			})
			mux := http.NewServeMux()
			RegisterGroupDirectoryRoutes(mux, reader, inspectionRouteAuth{p}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
			if response.Code != test.status || calls != test.calls {
				t.Fatalf("status %d calls %d body %s", response.Code, calls, response.Body.String())
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("missing cache policy")
			}
			if test.status == 200 && response.Header().Get("Daynight-Task-History-Directory-Version") != "1" {
				t.Fatal("missing version")
			}
			if strings.Contains(response.Body.String(), "private database detail") {
				t.Fatal("private error leaked")
			}
		})
	}
}

func TestGroupDirectoryPassesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	calls := 0
	reader := groupRouteRead(func(got context.Context, _ model.Principal, _ string, _ core.HistoryDirectoryRequest) (core.HistoryDirectoryPage, error) {
		calls++
		if !errors.Is(got.Err(), context.Canceled) {
			t.Fatal("cancellation lost")
		}
		return core.HistoryDirectoryPage{}, got.Err()
	})
	mux := http.NewServeMux()
	RegisterGroupDirectoryRoutes(mux, reader, inspectionRouteAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(ctx, "GET", "/api/v1/projects/11111111-1111-4111-8111-111111111111/history-directory", nil))
	if calls != 1 {
		t.Fatal(calls)
	}
}

func TestGroupedHistoryLeavesInspectionDirectoryShapeUnchanged(t *testing.T) {
	const path = "/api/v1/projects/11111111-1111-4111-8111-111111111111/tasks/22222222-2222-4222-8222-222222222222/sessions"
	h := newRoutes(serviceCalls{}, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h.history = historyRouteMock{list: func(context.Context, model.Principal, string, string, string, int) (sp.TaskSessionList, error) {
		return sp.TaskSessionList{Items: []sp.TaskSessionDirectoryItem{{SessionID: "original", ClaimID: "old", Archive: sp.SessionDirectoryArchive{State: "ready"}}}}, nil
	}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+sessionBase, inspectionRouteAuth{}.Require(h.Parameters(func(http.ResponseWriter, *http.Request, model.Principal) { t.Fatal("legacy dispatch") })))
	RegisterGroupDirectoryRoutes(mux, groupRouteRead(func(context.Context, model.Principal, string, core.HistoryDirectoryRequest) (core.HistoryDirectoryPage, error) {
		t.Fatal("group reader received old request")
		return core.HistoryDirectoryPage{}, nil
	}), inspectionRouteAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", path+"?view=inspection", nil))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	// Freeze old field names independently of the current production DTO.
	var old struct {
		Items []struct {
			SessionID, ClaimID, ExecutionGeneration, AgentControlMode, ContentKind, CreatedAt string
			EndedAt                                                                           *string
			CurrentBinding                                                                    bool
			Archive                                                                           struct {
				State                            string
				SHA256, ByteLength, Completeness *string
			}
		}
		NextCursor *string
	}
	decoder := json.NewDecoder(w.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&old); err != nil {
		t.Fatal(err)
	}
	if len(old.Items) != 1 || old.Items[0].ClaimID != "old" || old.Items[0].Archive.State != "ready" {
		t.Fatal(old)
	}
	if w.Header().Get("Daynight-Task-History-Directory-Version") != "" {
		t.Fatal("old response declared grouped capability")
	}
}
