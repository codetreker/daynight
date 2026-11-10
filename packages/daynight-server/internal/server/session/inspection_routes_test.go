package session

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type inspectionRouteAuth struct{ principal model.Principal }

func (a inspectionRouteAuth) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { next(w, r, a.principal) }
}

type inspectionRouteOperation func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error)

func (f inspectionRouteOperation) Inspect(ctx context.Context, p model.Principal, project, task, id string) (sp.TaskSessionInspection, error) {
	return f(ctx, p, project, task, id)
}

func TestTaskSessionInspectionRoutes(t *testing.T) {
	const project = "11111111-1111-4111-8111-111111111111"
	const task = "22222222-2222-4222-8222-222222222222"
	const session = "33333333-3333-4333-8333-333333333333"
	path := "/api/v1/projects/" + project + "/tasks/" + task + "/sessions/" + session + "/inspection"
	principal := model.Principal{Kind: model.PATCredential, UserID: "44444444-4444-4444-8444-444444444444", CredentialID: "credential"}
	for _, test := range []struct {
		name, method, path string
		failure            error
		status, calls      int
	}{
		{"success", "GET", path, nil, 200, 1},
		{"head", "HEAD", path, nil, 200, 1},
		{"unknown query", "GET", path + "?unknown=true", nil, 400, 0},
		{"wrong method", "POST", path, nil, 405, 0},
		{"missing session", "GET", path, &model.Fault{Code: "not_found", Message: "missing"}, 404, 1},
		{"revoked access", "GET", path, &model.Fault{Code: "forbidden", Message: "denied"}, 403, 1},
		{"failed read", "GET", path, errors.New("private storage detail"), 500, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			op := inspectionRouteOperation(func(ctx context.Context, p model.Principal, actualProject, actualTask, actualID string) (sp.TaskSessionInspection, error) {
				calls++
				if p != principal || actualProject != project || actualTask != task || actualID != session || ctx.Err() != nil {
					t.Errorf("inspection identity/context changed: %+v %s %s %s", p, actualProject, actualTask, actualID)
				}
				return sp.TaskSessionInspection{SchemaVersion: 1, ProjectID: project, TaskID: task, SessionID: session, CurrentBinding: false, Source: "archive"}, test.failure
			})
			mux := http.NewServeMux()
			RegisterInspectionRoutes(mux, op, inspectionRouteAuth{principal}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
			if response.Code != test.status || calls != test.calls {
				t.Fatalf("status=%d calls=%d body=%s", response.Code, calls, response.Body.String())
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("inspection must not be cached")
			}
			if test.status == 200 {
				var result sp.TaskSessionInspection
				if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.SessionID != session || result.CurrentBinding || result.Source != "archive" {
					t.Fatalf("inspection projection: %s %v", response.Body.String(), err)
				}
			}
		})
	}
}
