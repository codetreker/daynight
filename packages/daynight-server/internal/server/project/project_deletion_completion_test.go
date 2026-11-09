package project

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

type deletionFaultStore struct {
	*postgres.Store
	completion store.Completion
	err        error
	readErr    error
}

func (s *deletionFaultStore) ReadSnapshot(ctx context.Context, operation func(store.SnapshotScope) error) error {
	if s.readErr != nil {
		return s.readErr
	}
	return s.Store.ReadSnapshot(ctx, operation)
}

func (s *deletionFaultStore) WriteProjectDeletion(context.Context, string, func(store.ProjectDeletionScope) error) (store.Completion, error) {
	return s.completion, s.err
}

func TestProjectDeletionHTTPCompletionClassification(t *testing.T) {
	h := membershipTestHarness(t)
	tests := []struct {
		name                string
		outcome             store.TransactionOutcome
		cause               error
		status              int
		code, outcomeDetail string
	}{
		{"operation failure", store.TransactionNotCommitted, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: errors.New("private")}, 500, "internal_error", "not_committed"},
		{"project vanished at lock", store.TransactionNotCommitted, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}, 404, "not_found", ""},
		{"unknown commit", store.TransactionUnknown, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private commit")}, 503, "write_outcome_unknown", ""},
		{"failed rollback", store.TransactionUnknown, &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.New("private rollback")}, 503, "write_outcome_unknown", ""},
		{"cleanup despite rollback outcome", store.TransactionNotCommitted, &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: errors.New("private cleanup")}, 503, "write_outcome_unknown", ""},
		{"empty committed", store.TransactionCommitted, nil, 503, "write_outcome_unknown", ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mux := http.NewServeMux()
			h.Auth.RegisterRoutes(mux)
			logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
			db := &deletionFaultStore{Store: h.Database, completion: store.Completion{Outcome: test.outcome}, err: test.cause}
			RegisterRoutes(mux, projectservice.NewProjects(db), h.Auth, logger)
			h.Handler = httpx.RequestLogging(logger, mux)
			response := h.call("DELETE", "/api/v1/projects/"+h.project.ID, "", h.admin)
			assertProjectError(t, response, test.status, test.code)
			body := decodeResponse[api.ErrorResponse](t, response, test.status)
			if test.outcomeDetail != "" {
				if body.Error.Details == nil || body.Error.Details.WriteOutcome == nil || *body.Error.Details.WriteOutcome != test.outcomeDetail {
					t.Fatalf("error details: %s", response.Body)
				}
			} else if body.Error.Details != nil && body.Error.Details.WriteOutcome != nil {
				t.Fatalf("unexpected write outcome: %s", response.Body)
			}
			if strings.Contains(h.Logs.String(), "private commit") || strings.Contains(h.Logs.String(), "private rollback") || strings.Contains(h.Logs.String(), "private cleanup") {
				t.Fatalf("unsafe diagnostics: %s", &h.Logs)
			}
		})
	}
}

func TestProjectDeletionHTTPLostSuccessResponse(t *testing.T) {
	h := membershipTestHarness(t)
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	RegisterRoutes(mux, projectservice.NewProjects(h.Database), h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	base := "/api/v1/projects/" + h.project.ID
	request := httptest.NewRequest("DELETE", base, nil)
	request.Header.Set("Origin", h.Origin)
	request.Header.Set("X-Request-ID", "deletion-test")
	request.AddCookie(h.admin)
	w := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder()}
	h.Handler.ServeHTTP(w, request)
	if w.calls != 1 || w.Body.Len() != 0 {
		t.Fatalf("response replayed: %d %q", w.calls, w.Body.String())
	}
	var deleted bool
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT deleted_at IS NOT NULL FROM projects WHERE id=$1`, h.project.ID).Scan(&deleted); err != nil || !deleted {
		t.Fatalf("mutation did not commit: %v %v", deleted, err)
	}
	assertProjectError(t, h.call("GET", base, "", h.admin), 404, "not_found")
	if !strings.Contains(h.Logs.String(), `"component":"project_deletion"`) || !strings.Contains(h.Logs.String(), `"phase":"response"`) {
		t.Fatalf("response failure logs: %s", &h.Logs)
	}
}

func TestProjectDeletionHTTPPreflightFailure(t *testing.T) {
	h := membershipTestHarness(t)
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	db := &deletionFaultStore{Store: h.Database, readErr: errors.New("preflight unavailable")}
	RegisterRoutes(mux, projectservice.NewProjects(db), h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	response := h.call("DELETE", "/api/v1/projects/"+h.project.ID, "", h.admin)
	body := decodeResponse[api.ErrorResponse](t, response, 500)
	if body.Error.Code != "internal_error" || body.Error.Details == nil || body.Error.Details.WriteOutcome == nil || *body.Error.Details.WriteOutcome != "not_committed" {
		t.Fatalf("preflight outcome: %s", response.Body)
	}
}
