package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type repositoryRefusalProjects struct {
	fakeProjectOperations
	t       *testing.T
	creates int
	address string
}

func (p *repositoryRefusalProjects) RegisterRepository(ctx context.Context, principal model.Principal, input coreproject.CreateProject, confirm bool) (model.Project, bool, error) {
	p.t.Helper()
	p.creates++
	if ctx == nil || principal.UserID != "alice" || input.ExpectedUserID != "alice" || input.Name != "private-input-name" || input.RepoURL != p.address || input.TeamID == nil || *input.TeamID != testTeamID || !confirm {
		p.t.Fatalf("existing create arguments changed: %+v %+v confirm=%t", principal, input, confirm)
	}
	return model.Project{}, false, p.err
}

func TestProjectRepositoryMCPRefusalsAndUnknownCompletion(t *testing.T) {
	for _, protocol := range []string{"2026-07-28", "2025-11-25"} {
		for _, operation := range []struct{ name, code, message string }{
			{"project_create", "project_repository_conflict", "The target Team already owns a Project for this repository."},
			{"project_transfer", "project_repository_conflict", "The target Team already owns a Project for this repository."},
			{"project_transfer", "project_repository_identity_unavailable", "The Project repository identity is unavailable."},
		} {
			for _, unknown := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/%s/unknown=%t", protocol, operation.name, operation.code, unknown), func(t *testing.T) {
					f := newEntryFixture(t)
					var logs bytes.Buffer
					f.entry.logger = slog.New(slog.NewJSONHandler(&logs, nil))
					const address = "git@private.example:Confidential/Repository.git"
					const private = "hidden-project-id hidden-project-name credential-secret"
					fault := &model.Fault{Code: operation.code, Message: operation.message, Cause: errors.New(private)}
					failure := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: fault}
					code, outcome, phase := operation.code, "not_committed", "operation"
					if unknown {
						failure.Phase, failure.Outcome, failure.CommitAttempted = "commit", store.TransactionUnknown, true
						code, outcome, phase = "internal_error", "unknown", "commit"
					}
					ops := &repositoryRefusalProjects{t: t, address: address}
					ops.preview = coreproject.TransferPreview{SourceTeam: model.TeamRef{ID: testTeamID}, Ownership: model.ProjectOwnership{TeamID: testTeamID, Version: 11}, TargetTeamVersion: 7}
					args := map[string]any{"name": "private-input-name", "repoUrl": address, "team": testTeamID, "confirm": true}
					if operation.name == "project_create" {
						ops.err = failure
					} else {
						ops.transferErr = failure
						args = map[string]any{"projectId": testProjectID, "toTeam": testTargetID, "ifVersion": "11", "confirm": true}
					}
					if err := RegisterProjectTools(f.entry, ops, nil, "https://daynight.test"); err != nil {
						t.Fatal(err)
					}
					client := f.client(t, protocol, "alice")
					ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
					defer cancel()
					result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: operation.name, Arguments: args})
					if err != nil {
						t.Fatal(err)
					}
					doc := structured(t, result)
					failureBody := object(t, doc["error"])
					if !result.IsError || failureBody["code"] != code || failureBody["writeOutcome"] != outcome || failureBody["phase"] != phase || failureBody["requestId"] != "test-request" || doc["data"] != nil || (!unknown && failureBody["message"] != operation.message) {
						t.Fatalf("unsafe or incompatible error envelope: %+v", doc)
					}
					if operation.name == "project_create" {
						if ops.creates != 1 || ops.calls != 0 || ops.previews != 0 || failureBody["refs"] != nil {
							t.Fatalf("create replayed or exposed refs: calls=%d transfer=%d previews=%d body=%+v", ops.creates, ops.calls, ops.previews, failureBody)
						}
					} else {
						refs := object(t, failureBody["refs"])
						if ops.calls != 1 || ops.previews != 1 || ops.creates != 0 || refs["projectId"] != testProjectID || refs["sourceTeamId"] != testTeamID || refs["targetTeamId"] != testTargetID || len(refs) != 3 {
							t.Fatalf("transfer replayed or refs disclosed unrelated Projects: calls=%d previews=%d refs=%+v", ops.calls, ops.previews, refs)
						}
					}
					encoded, err := json.Marshal(result)
					if err != nil {
						t.Fatal(err)
					}
					for _, secret := range []string{address, "private.example", "Confidential", "hidden-project-id", "hidden-project-name", "credential-secret", "private-input-name", "Bearer alice"} {
						if strings.Contains(string(encoded), secret) || strings.Contains(logs.String(), secret) {
							t.Fatalf("request or private failure details leaked: %q", secret)
						}
					}
					for _, field := range []string{`"request_id":"test-request"`, `"error_code":"` + code + `"`, `"operation":"` + operation.name + `"`, `"phase":"tool_call"`, `"write_outcome":"` + outcome + `"`} {
						if !strings.Contains(logs.String(), field) {
							t.Fatalf("missing correlated diagnostic %s: %s", field, &logs)
						}
					}
				})
			}
		}
	}
}
