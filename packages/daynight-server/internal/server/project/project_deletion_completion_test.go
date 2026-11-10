package project

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

func TestProjectDeletionHTTPCompletionClassification(t *testing.T) {
	for _, tc := range []struct {
		name         string
		outcome      store.TransactionOutcome
		cause        error
		status       int
		code, detail string
	}{
		{"operation failure", store.TransactionNotCommitted, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: errors.New("private")}, 500, "internal_error", "not_committed"},
		{"project vanished at lock", store.TransactionNotCommitted, &model.Fault{Code: "not_found", Message: "Project not found"}, 404, "not_found", ""},
		{"unknown commit", store.TransactionUnknown, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private commit")}, 503, "write_outcome_unknown", ""},
		{"failed rollback", store.TransactionUnknown, &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.New("private rollback")}, 503, "write_outcome_unknown", ""},
		{"cleanup despite rollback outcome", store.TransactionUnknown, &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: errors.New("private cleanup")}, 503, "write_outcome_unknown", ""},
		{"empty committed", store.TransactionUnknown, errors.New("private missing receipt"), 503, "write_outcome_unknown", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHTTPHarness(t)
			h.Projects.DeleteFunc = func(_ context.Context, _ model.Principal, id string) (projectservice.DeletionReceipt, error) {
				if id != h.Project.ID {
					t.Fatal(id)
				}
				return projectservice.DeletionReceipt{}, &projectservice.DeletionFailure{Outcome: tc.outcome, Cause: tc.cause}
			}
			response := h.call("DELETE", "/api/v1/projects/"+h.Project.ID, "")
			assertProjectError(t, response, tc.status, tc.code)
			body := decodeResponse[api.ErrorResponse](t, response, tc.status)
			if tc.detail != "" {
				if body.Error.Details == nil || body.Error.Details.WriteOutcome == nil || *body.Error.Details.WriteOutcome != tc.detail {
					t.Fatalf("details=%s", response.Body)
				}
			} else if body.Error.Details != nil && body.Error.Details.WriteOutcome != nil {
				t.Fatalf("unexpected details=%s", response.Body)
			}
			if strings.Contains(response.Body.String(), "private") || strings.Contains(h.Logs.String(), "private") {
				t.Fatalf("unsafe output body=%s logs=%s", response.Body, &h.Logs)
			}
			h.assertCalls(map[string]int{"Delete": 1})
		})
	}
}

func TestProjectDeletionHTTPLostSuccessResponse(t *testing.T) {
	for _, short := range []bool{false, true} {
		t.Run(map[bool]string{false: "failed write", true: "short write"}[short], func(t *testing.T) {
			h := newHTTPHarness(t)
			h.Projects.DeleteFunc = func(_ context.Context, _ model.Principal, id string) (projectservice.DeletionReceipt, error) {
				if id != h.Project.ID {
					t.Fatal(id)
				}
				return projectservice.DeletionReceipt{ProjectID: id, Deleted: true}, nil
			}
			writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: short}
			h.Handler.ServeHTTP(writer, h.request("DELETE", "/api/v1/projects/"+h.Project.ID, ""))
			if writer.calls != 1 || writer.Body.Len() != 0 {
				t.Fatalf("response replayed: %d %q", writer.calls, writer.Body.String())
			}
			if !strings.Contains(h.Logs.String(), `"component":"project_deletion"`) || !strings.Contains(h.Logs.String(), `"phase":"response"`) || strings.Contains(h.Logs.String(), "private response failure") {
				t.Fatalf("response logs=%s", &h.Logs)
			}
			h.assertCalls(map[string]int{"Delete": 1})
		})
	}
}

func TestProjectDeletionHTTPPreflightFailure(t *testing.T) {
	h := newHTTPHarness(t)
	h.Projects.DeleteFunc = func(_ context.Context, _ model.Principal, id string) (projectservice.DeletionReceipt, error) {
		if id != h.Project.ID {
			t.Fatal(id)
		}
		return projectservice.DeletionReceipt{}, &projectservice.DeletionFailure{Outcome: store.TransactionNotCommitted, Cause: errors.New("preflight unavailable")}
	}
	response := h.call("DELETE", "/api/v1/projects/"+h.Project.ID, "")
	body := decodeResponse[api.ErrorResponse](t, response, 500)
	if body.Error.Code != "internal_error" || body.Error.Details == nil || body.Error.Details.WriteOutcome == nil || *body.Error.Details.WriteOutcome != "not_committed" {
		t.Fatalf("preflight=%s", response.Body)
	}
	h.assertCalls(map[string]int{"Delete": 1})
}

func TestProjectDeletionHTTPCancellationReachesOperation(t *testing.T) {
	h := newHTTPHarness(t)
	started := make(chan struct{})
	exited := make(chan struct{})
	h.Projects.DeleteFunc = func(ctx context.Context, _ model.Principal, id string) (projectservice.DeletionReceipt, error) {
		if id != h.Project.ID {
			t.Errorf("id=%s", id)
		}
		close(started)
		<-ctx.Done()
		close(exited)
		return projectservice.DeletionReceipt{}, ctx.Err()
	}
	request := h.request("DELETE", "/api/v1/projects/"+h.Project.ID, "")
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); h.Handler.ServeHTTP(response, request.WithContext(ctx)) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("operation did not start")
	}
	cancel()
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("operation did not observe cancellation")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not exit")
	}
	if response.Body.Len() != 0 {
		t.Fatalf("wrote canceled response: %s", response.Body)
	}
	h.assertCalls(map[string]int{"Delete": 1})
}
