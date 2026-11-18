package project

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestProjectRepositoryHTTPRefusalsAndUnknownCompletion(t *testing.T) {
	for _, operation := range []struct{ name, code, message string }{
		{"create", "project_repository_conflict", "The target Team already owns a Project for this repository."},
		{"transfer", "project_repository_conflict", "The target Team already owns a Project for this repository."},
		{"transfer", "project_repository_identity_unavailable", "The Project repository identity is unavailable."},
	} {
		for _, unknown := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/%s/unknown=%t", operation.name, operation.code, unknown), func(t *testing.T) {
				h := newHTTPHarness(t)
				const target = "55555555-5555-4555-8555-555555555555"
				const address = "git@private.example:Confidential/Repository.git"
				const private = "hidden-project-name credential-secret"
				fault := &model.Fault{Code: operation.code, Message: operation.message, Cause: errors.New(private)}
				failure := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: fault}
				status, code, phase := http.StatusConflict, operation.code, "create"
				if operation.name == "transfer" {
					phase = "operation"
				}
				if unknown {
					failure.Phase, failure.Outcome, failure.CommitAttempted = "commit", store.TransactionUnknown, true
					status, code, phase = http.StatusServiceUnavailable, "write_outcome_unknown", "commit"
				}
				logCode := code
				if unknown && operation.name == "create" {
					logCode = "internal_error"
				}
				path := "/api/v1/projects"
				body := jsonBody(t, api.CreateProjectRequest{Name: "private-input-name", RepoURL: address, TeamID: ptrRepositoryTarget(target), ExpectedUserID: h.Principal.UserID})
				calls := map[string]int{"CreateWithAccess": 1}
				if operation.name == "create" {
					h.Projects.CreateWithAccessFunc = func(ctx context.Context, principal model.Principal, input coreproject.CreateProject) (model.Project, model.ProjectAccess, error) {
						assertProjectInvocation(t, h, ctx, principal)
						if input.Name != "private-input-name" || input.RepoURL != address || input.TeamID == nil || *input.TeamID != target || input.ExpectedUserID != h.Principal.UserID {
							t.Fatalf("existing create request changed: %+v", input)
						}
						return model.Project{}, model.ProjectAccess{}, failure
					}
				} else {
					path += "/" + h.Project.ID + "/transfer"
					body = fmt.Sprintf(`{"ownership":{"teamId":%q,"version":1},"targetTeam":{"id":%q,"version":7},"expectedUserId":%q}`, h.Project.Ownership.TeamID, target, h.Principal.UserID)
					calls = map[string]int{"Transfer": 1}
					h.Projects.TransferFunc = func(ctx context.Context, principal model.Principal, id string, input coreproject.TransferInput) (coreproject.TransferReceipt, error) {
						assertProjectInvocation(t, h, ctx, principal, id)
						if input.Ownership != h.Project.Ownership || input.TargetTeam.ID != target || input.TargetTeam.Version != 7 || input.ExpectedUserID != h.Principal.UserID {
							t.Fatalf("existing transfer request changed: %+v", input)
						}
						return coreproject.TransferReceipt{}, failure
					}
				}
				response := h.call(http.MethodPost, path, body)
				assertProjectError(t, response, status, code)
				var envelope api.ErrorResponse
				if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || envelope.Error.RequestID != "project-test" || envelope.Error.Details != nil || (!unknown && envelope.Error.Message != operation.message) {
					t.Fatalf("unsafe or incompatible error envelope: %s (%v)", response.Body, err)
				}
				if response.Header().Get("Location") != "" {
					t.Fatal("refusal returned a creation location")
				}
				for _, secret := range []string{address, "private.example", "Confidential", "hidden-project-name", "credential-secret", "private-input-name", h.Cookie.Value} {
					if strings.Contains(response.Body.String(), secret) || strings.Contains(h.Logs.String(), secret) {
						t.Fatalf("private request or error details leaked: %q", secret)
					}
				}
				for _, field := range []string{`"request_id":"project-test"`, `"error_code":"` + logCode + `"`, `"phase":"` + phase + `"`} {
					if !strings.Contains(h.Logs.String(), field) {
						t.Fatalf("missing correlated diagnostic %s: %s", field, &h.Logs)
					}
				}
				h.assertCalls(calls)
			})
		}
	}
}

func ptrRepositoryTarget(value string) *string { return &value }
