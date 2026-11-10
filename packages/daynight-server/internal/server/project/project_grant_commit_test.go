package project

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestGrantHTTPCommitLossReportsUnknown(t *testing.T) {
	h := newHTTPHarness(t)
	userID := "10000000-0000-4000-8000-000000000003"
	h.Memberships.SetGrantFunc = func(_ context.Context, _ model.Principal, id, user string, input coreproject.SetProjectGrant) (coreproject.SetGrantResult, error) {
		if id != h.Project.ID || user != userID || input.Version != nil || input.Role != model.ProjectAdmin || input.ExpectedUserID != h.Principal.UserID {
			t.Fatalf("id=%s user=%s input=%+v", id, user, input)
		}
		return coreproject.SetGrantResult{}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private lost COMMIT confirmation")}
	}
	body := `{"version":null,"role":"admin","expectedUserId":"` + h.Principal.UserID + `"}`
	response := h.call("PUT", "/api/v1/projects/"+h.Project.ID+"/grants/"+userID, body)
	assertProjectError(t, response, 503, "write_outcome_unknown")
	if !strings.Contains(h.Logs.String(), `"phase":"commit"`) || !strings.Contains(h.Logs.String(), `"outcome":"unknown"`) || strings.Contains(h.Logs.String(), "private lost") {
		t.Fatalf("logs=%s", &h.Logs)
	}
	h.assertCalls(map[string]int{"SetGrant": 1})
}
