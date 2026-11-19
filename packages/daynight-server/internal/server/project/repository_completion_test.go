package project

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestRepositoryHTTPCompletionFailureAndMissingProject(t *testing.T) {
	for _, tc := range []struct {
		name        string
		failure     error
		status      int
		code, phase string
	}{
		{"rollback failure", &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: errors.New("private cleanup details")}, http.StatusInternalServerError, "internal_error", "completion"},
		{"missing locked project", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}, http.StatusNotFound, "not_found", "save"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, m := repositoryHarness(t)
			m.save = func(context.Context, model.Principal, string, coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error) {
				return coreproject.RepositoryReceipt{}, tc.failure
			}
			body := `{"repoUrl":"https://github.com/private/repository","expectedUserId":"` + h.Principal.UserID + `","repositoryVersion":"1","ownershipVersion":"1","classification":"different_repository","targetGitHubRepositoryId":"31"}`
			response := h.call(http.MethodPatch, "/api/v1/projects/"+h.Project.ID+"/repository", body)
			assertProjectError(t, response, tc.status, tc.code)
			if response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(h.Logs.String(), `"phase":"`+tc.phase+`"`) {
				t.Fatalf("headers=%v logs=%s", response.Header(), &h.Logs)
			}
			for _, secret := range []string{"private cleanup details", "github.com/private/repository", h.Cookie.Value} {
				if strings.Contains(response.Body.String(), secret) || strings.Contains(h.Logs.String(), secret) {
					t.Fatalf("leaked %q", secret)
				}
			}
			h.assertCalls(map[string]int{"SetRepository": 1})
		})
	}
}

func TestRepositoryHTTPUnknownCommitAfterCancellationHasNoResponse(t *testing.T) {
	h, m := repositoryHarness(t)
	body := `{"repoUrl":"https://github.com/owner/repository","expectedUserId":"` + h.Principal.UserID + `","repositoryVersion":"1","ownershipVersion":"1","classification":"different_repository","targetGitHubRepositoryId":"31"}`
	request := h.request(http.MethodPatch, "/api/v1/projects/"+h.Project.ID+"/repository", body)
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	request = request.WithContext(ctx)
	m.save = func(got context.Context, _ model.Principal, _ string, _ coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error) {
		if got.Err() != nil {
			t.Fatalf("request canceled before operation: %v", got.Err())
		}
		cancel()
		return coreproject.RepositoryReceipt{}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private commit detail")}
	}
	response := httptest.NewRecorder()
	h.Handler.ServeHTTP(response, request)
	if response.Body.Len() != 0 || response.Header().Get("Content-Type") != "" {
		t.Fatalf("sent response after cancellation: %d %s", response.Code, response.Body)
	}
	if !strings.Contains(h.Logs.String(), `"write_outcome":"unknown"`) || !strings.Contains(h.Logs.String(), `"phase":"commit"`) || strings.Contains(h.Logs.String(), "private commit detail") {
		t.Fatalf("unknown completion log: %s", &h.Logs)
	}
	h.assertCalls(map[string]int{"SetRepository": 1})
}
