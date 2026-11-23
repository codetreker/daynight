package project

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

func goalConfirmationRequest(h *httpHarness, operation string) (*httptest.ResponseRecorder, func([]string)) {
	path := "/api/v1/projects/" + h.Project.ID
	method, body := "DELETE", ""
	if operation == "transfer" {
		method, path = "POST", path+"/transfer"
		body = jsonBody(h.t, map[string]any{
			"ownership":      map[string]any{"teamId": h.Project.Ownership.TeamID, "version": 1},
			"targetTeam":     map[string]any{"id": "55555555-5555-4555-8555-555555555555", "version": 1},
			"expectedUserId": h.Principal.UserID,
		})
	}
	response := httptest.NewRecorder()
	return response, func(values []string) {
		request := h.request(method, path, body)
		for _, value := range values {
			request.Header.Add(goalDependencyRemovalHeader, value)
		}
		h.Handler.ServeHTTP(response, request)
	}
}

func TestProjectGoalDependencyConfirmationHTTP(t *testing.T) {
	for _, operation := range []string{"transfer", "delete"} {
		for _, tc := range []struct {
			name             string
			values           []string
			valid, confirmed bool
		}{
			{"legacy", nil, true, false},
			{"confirmed", []string{"true"}, true, true},
			{"false", []string{"false"}, false, false},
			{"case", []string{"True"}, false, false},
			{"empty", []string{""}, false, false},
			{"space", []string{" true"}, false, false},
			{"trailing space", []string{"true "}, false, false},
			{"list", []string{"true, true"}, false, false},
			{"duplicate", []string{"true", "true"}, false, false},
			{"conflicting duplicate", []string{"true", "false"}, false, false},
		} {
			t.Run(operation+"/"+tc.name, func(t *testing.T) {
				h := newHTTPHarness(t)
				h.Projects.TransferFunc = func(ctx context.Context, p model.Principal, id string, input coreproject.TransferInput) (coreproject.TransferReceipt, error) {
					assertProjectInvocation(t, h, ctx, p, id)
					if input.ConfirmGoalDependencyRemoval != tc.confirmed || input.Ownership != h.Project.Ownership || input.ExpectedUserID != p.UserID || input.TargetTeam.Version != 1 {
						t.Fatalf("transfer input %+v", input)
					}
					return coreproject.TransferReceipt{ProjectID: id, Changed: true, Ownership: input.Ownership}, nil
				}
				h.Projects.DeleteWithInputFunc = func(ctx context.Context, p model.Principal, id string, input coreproject.DeletionInput) (projectservice.DeletionReceipt, error) {
					assertProjectInvocation(t, h, ctx, p, id)
					if input.ConfirmGoalDependencyRemoval != tc.confirmed {
						t.Fatalf("deletion input %+v", input)
					}
					return projectservice.DeletionReceipt{ProjectID: id, Deleted: true}, nil
				}
				response, run := goalConfirmationRequest(h, operation)
				run(tc.values)
				calls := map[string]int{}
				if tc.valid {
					if operation == "transfer" {
						decodeResponse[api.TransferReceipt](t, response, 200)
						calls["Transfer"] = 1
					} else {
						decodeResponse[api.ProjectDeletionReceipt](t, response, 200)
						calls["DeleteWithInput"] = 1
					}
				} else {
					assertProjectError(t, response, 400, "invalid_input")
				}
				if response.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("missing no-store")
				}
				h.assertCalls(calls)
			})
		}
	}
}

func TestProjectGoalDependencyConfirmationPreservesWriteOutcomes(t *testing.T) {
	for _, operation := range []string{"transfer", "delete"} {
		for _, unknown := range []bool{false, true} {
			name := "unconfirmed refusal"
			if unknown {
				name = "confirmed unknown"
			}
			t.Run(operation+"/"+name, func(t *testing.T) {
				h := newHTTPHarness(t)
				refusal := &model.Fault{Code: "invalid_input", Message: "Update the client or confirm permanent Goal dependency removal."}
				h.Projects.TransferFunc = func(ctx context.Context, p model.Principal, id string, input coreproject.TransferInput) (coreproject.TransferReceipt, error) {
					assertProjectInvocation(t, h, ctx, p, id)
					if input.ConfirmGoalDependencyRemoval != unknown {
						t.Fatalf("confirmation %v", input.ConfirmGoalDependencyRemoval)
					}
					if unknown {
						return coreproject.TransferReceipt{}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private failure")}
					}
					return coreproject.TransferReceipt{}, refusal
				}
				h.Projects.DeleteWithInputFunc = func(ctx context.Context, p model.Principal, id string, input coreproject.DeletionInput) (projectservice.DeletionReceipt, error) {
					assertProjectInvocation(t, h, ctx, p, id)
					if input.ConfirmGoalDependencyRemoval != unknown {
						t.Fatalf("confirmation %v", input.ConfirmGoalDependencyRemoval)
					}
					if unknown {
						return projectservice.DeletionReceipt{}, &projectservice.DeletionFailure{Outcome: store.TransactionUnknown, Cause: errors.New("private failure")}
					}
					return projectservice.DeletionReceipt{}, &projectservice.DeletionFailure{Outcome: store.TransactionNotCommitted, Cause: refusal}
				}
				response, run := goalConfirmationRequest(h, operation)
				var values []string
				if unknown {
					values = []string{"true"}
				}
				run(values)
				if unknown {
					assertProjectError(t, response, 503, "write_outcome_unknown")
				} else {
					assertProjectError(t, response, 400, "invalid_input")
				}
				if operation == "transfer" {
					h.assertCalls(map[string]int{"Transfer": 1})
				} else {
					h.assertCalls(map[string]int{"DeleteWithInput": 1})
				}
			})
		}
	}
}
