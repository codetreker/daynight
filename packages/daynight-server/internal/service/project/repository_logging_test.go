package project

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

type repositoryLogStore struct {
	t       *testing.T
	facts   store.ProjectRepositoryFacts
	outcome store.TransactionOutcome
	writes  int
}

type repositoryLogReadScope struct{ *repositoryLogStore }
type repositoryLogWriteScope struct{ *repositoryLogStore }

func (s *repositoryLogStore) ReadProjectRepository(ctx context.Context, id string, work func(store.ProjectRepositoryReadScope) error) error {
	if id != s.facts.Project.ID {
		s.t.Fatal("unexpected Project read")
	}
	return work(repositoryLogReadScope{s})
}
func (s *repositoryLogStore) WriteProjectRepository(ctx context.Context, id, actor string, work func(store.ProjectRepositoryWriteScope) error) (store.Completion, error) {
	if id != s.facts.Project.ID || actor != "11111111-1111-4111-8111-111111111111" {
		s.t.Fatal("unexpected Project write")
	}
	if err := work(repositoryLogWriteScope{s}); err != nil {
		s.t.Fatalf("unexpected operation failure: %v", err)
	}
	if s.outcome != store.TransactionCommitted {
		return store.Completion{Outcome: s.outcome}, &store.TransactionError{Phase: "commit", Outcome: s.outcome, Cause: errors.New("secret database diagnostic")}
	}
	return store.Completion{Outcome: s.outcome}, nil
}
func (s repositoryLogReadScope) ProjectRepositoryDAO() store.ProjectRepositoryReadDAO {
	return s.repositoryLogStore
}
func (s repositoryLogWriteScope) ProjectRepositoryDAO() store.ProjectRepositoryWriteDAO {
	return s.repositoryLogStore
}
func (s repositoryLogReadScope) GitHubAppDAO() store.GitHubProjectAppReadDAO {
	return s.repositoryLogStore
}
func (s repositoryLogWriteScope) GitHubAppDAO() store.GitHubProjectAppReadDAO {
	return s.repositoryLogStore
}
func (s repositoryLogWriteScope) GitHubSwitchDAO() store.GitHubRepositorySwitchDAO {
	return s.repositoryLogStore
}
func (s repositoryLogWriteScope) WorkerSelectionsDAO() store.WorkerProjectSelectionDAO {
	return s.repositoryLogStore
}
func (s *repositoryLogStore) RepositoryFacts(context.Context, model.Principal) (store.ProjectRepositoryFacts, error) {
	return s.facts, nil
}
func (s *repositoryLogStore) RepositoryOccupiedByOther(context.Context, string, string) (bool, error) {
	return false, nil
}
func (s *repositoryLogStore) SaveRepository(context.Context, string, string, int64) (int64, bool, error) {
	return 2, true, nil
}
func (s *repositoryLogStore) Facts(context.Context, model.Principal) (store.GitHubProjectAppFacts, error) {
	return store.GitHubProjectAppFacts{}, nil
}
func (s *repositoryLogStore) App(context.Context, string, string, string) (store.GitHubProjectApp, error) {
	s.t.Fatal("unexpected App read")
	return store.GitHubProjectApp{}, nil
}
func (s *repositoryLogStore) LockBinding(context.Context) (*string, error) { return nil, nil }
func (s *repositoryLogStore) SaveSwitch(context.Context, store.GitHubRepositorySwitchWrite) (bool, error) {
	return true, nil
}
func (s *repositoryLogStore) AdvanceImpact(context.Context) error { return nil }
func (s *repositoryLogStore) ProjectSelectionCandidates(context.Context, string) ([]store.WorkerSelectionID, error) {
	return []store.WorkerSelectionID{{UserID: "private-user", WorkerID: "private-worker"}}, nil
}
func (s *repositoryLogStore) LockProjectSelection(context.Context, store.WorkerSelectionID) (*store.WorkerSelectionTarget, error) {
	return &store.WorkerSelectionTarget{Revision: 1, Raw: json.RawMessage(`{"projects":[{"projectId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}]}`)}, nil
}
func (s *repositoryLogStore) SaveProjectSelection(context.Context, store.WorkerSelectionID, int64, json.RawMessage) error {
	s.writes++
	return nil
}

func TestRepositorySaveLogsTransactionCompletion(t *testing.T) {
	const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	actor := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "44444444-4444-4444-8444-444444444444", Kind: model.SessionCredential}
	for _, outcome := range []store.TransactionOutcome{store.TransactionCommitted, store.TransactionNotCommitted, store.TransactionUnknown} {
		t.Run(string(outcome), func(t *testing.T) {
			facts := store.ProjectRepositoryFacts{Project: model.Project{ID: id, RepoURL: "https://example.com/old-private", Ownership: model.ProjectOwnership{TeamID: "team", Version: 1}}, Access: model.ProjectAccess{Role: model.ProjectAdmin}, Version: 1}
			plan := &repositoryLogStore{t: t, facts: facts, outcome: outcome}
			var logs bytes.Buffer
			s := &AppProjects{repositoryStore: plan, repositoryLogger: slog.New(slog.NewJSONHandler(&logs, nil))}
			ctx := requestid.With(t.Context(), "request-1")
			input := core.RepositoryChange{RepoURL: "https://example.com/new-private", ExpectedUserID: actor.UserID, RepositoryVersion: 1, OwnershipVersion: 1, Classification: "unverified", TreatUnverifiedAsSwitch: true}
			_, err := s.SetRepository(ctx, actor, id, input)
			if (err == nil) != (outcome == store.TransactionCommitted) || plan.writes != 1 {
				t.Fatalf("outcome=%s err=%v writes=%d", outcome, err, plan.writes)
			}
			lines := bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n"))
			var record map[string]any
			if err := json.Unmarshal(lines[len(lines)-1], &record); err != nil {
				t.Fatal(err)
			}
			if record["phase"] != "save" || record["project_id"] != id || record["request_id"] != "request-1" || record["classification"] != "unverified" || record["commit_outcome"] != string(outcome) {
				t.Fatalf("record: %+v", record)
			}
			if outcome == store.TransactionUnknown {
				if record["provisional_worker_configuration_rows"] != float64(1) || record["affected_worker_configuration_rows"] != nil {
					t.Fatalf("unknown record: %+v", record)
				}
			} else if expected := map[store.TransactionOutcome]float64{store.TransactionCommitted: 1, store.TransactionNotCommitted: 0}[outcome]; record["affected_worker_configuration_rows"] != expected {
				t.Fatalf("incorrect durable count: %+v", record)
			}
			for _, secret := range []string{"old-private", "new-private", "secret database diagnostic", "private-user", "private-worker"} {
				if strings.Contains(logs.String(), secret) {
					t.Fatalf("logs disclose %q: %s", secret, logs.String())
				}
			}
		})
	}
}

func TestRepositoryLoggerDefaultsWhenUnset(t *testing.T) {
	var configuredLogs, defaultLogs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&defaultLogs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	s := &AppProjects{}
	s.SetRepositoryLogger(slog.New(slog.NewJSONHandler(&configuredLogs, nil)))
	s.logRepository(t.Context(), model.Principal{}, "project", "preview", "unchanged", "", 0, false)
	s.SetRepositoryLogger(nil)
	s.logRepository(t.Context(), model.Principal{}, "project", "save", "unchanged", store.TransactionCommitted, 0, true)
	if !strings.Contains(configuredLogs.String(), `"phase":"preview"`) || strings.Contains(configuredLogs.String(), `"phase":"save"`) || !strings.Contains(defaultLogs.String(), `"phase":"save"`) {
		t.Fatalf("logger routing: configured=%s default=%s", configuredLogs.String(), defaultLogs.String())
	}
}
