package project

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

func TestRepositoryObservationAuthorizationMustRemainCurrent(t *testing.T) {
	admin, member := model.ProjectAdmin, model.ProjectMemberRole
	before := repositorySnapshot{}
	before.github.Access.TeamRole = &admin
	for _, current := range []*model.ProjectRole{nil, &member} {
		after := before
		after.github.Access.TeamRole = current
		if relevantGitHubFacts(before, after) {
			t.Fatal("accepted evidence after Team administration changed")
		}
	}
	if !relevantGitHubFacts(before, before) {
		t.Fatal("rejected unchanged observation facts")
	}
}

func TestRepositoryLogCompletionDoesNotClaimUnknownRows(t *testing.T) {
	for _, tc := range []struct {
		outcome store.TransactionOutcome
		field   string
		value   float64
	}{
		{store.TransactionCommitted, "affected_worker_configuration_rows", 2},
		{store.TransactionNotCommitted, "affected_worker_configuration_rows", 0},
		{store.TransactionUnknown, "provisional_worker_configuration_rows", 2},
	} {
		t.Run(string(tc.outcome), func(t *testing.T) {
			var logs bytes.Buffer
			s := &AppProjects{repositoryLogger: slog.New(slog.NewJSONHandler(&logs, nil))}
			ctx := requestid.With(t.Context(), "request-1")
			s.logRepository(ctx, model.Principal{UserID: "user"}, "project", "save", "unverified", tc.outcome, 2, true)
			var record map[string]any
			if err := json.Unmarshal(logs.Bytes(), &record); err != nil {
				t.Fatal(err)
			}
			if record["project_id"] != "project" || record["request_id"] != "request-1" || record["user_id"] != "user" || record["classification"] != "unverified" || record["phase"] != "save" || record["commit_outcome"] != string(tc.outcome) || record[tc.field] != tc.value {
				t.Fatalf("record: %+v", record)
			}
			if tc.outcome == store.TransactionUnknown {
				if _, present := record["affected_worker_configuration_rows"]; present {
					t.Fatalf("unknown commit reported durable rows: %+v", record)
				}
			} else if _, present := record["provisional_worker_configuration_rows"]; present {
				t.Fatalf("definite outcome reported provisional rows: %+v", record)
			}
		})
	}
}
