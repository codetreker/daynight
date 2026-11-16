package github

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

type projectionWriteStore struct {
	*projectionStore
	completion store.Completion
	writes     int
}

func (s *projectionWriteStore) WriteGitHubProjectApp(ctx context.Context, id, actor, app string, work func(store.GitHubProjectAppWriteDAO) error) (store.Completion, error) {
	s.writes++
	if s.writes != 1 || id != projectID || actor != userID || app != "" || httpx.RequestID(ctx) != "project-app-request" {
		s.t.Fatalf("unexpected write: count=%d project=%s actor=%s app=%s request=%s", s.writes, id, actor, app, httpx.RequestID(ctx))
	}
	return s.completion, work(s)
}

func (s *projectionWriteStore) Save(context.Context, store.GitHubProjectAppWrite) (bool, error) {
	s.t.Fatal("unexpected save for unchanged settings")
	return false, nil
}

func (s *projectionWriteStore) AdvanceImpact(context.Context, string) error {
	s.t.Fatal("unexpected impact change for unchanged settings")
	return nil
}

func (s *projectionWriteStore) ObservedAt(context.Context) (time.Time, error) {
	s.t.Fatal("unexpected clock read for unchanged settings")
	return time.Time{}, nil
}

func TestProjectAppHTTPSeparatesTransactionCompletionFromDelivery(t *testing.T) {
	connection := githubpr.DefaultConnection(projectID)
	connection.Enabled = true
	connection.Version, connection.Generation, connection.PollIntervalMinutes = 3, 9, 5
	connection.AppID, connection.InstallationID, connection.RepositoryID = pointer(int64(9)), pointer(int64(8)), pointer(int64(7))
	connection.InstallationAccountLogin, connection.RepositoryFullName = pointer("owner"), pointer("owner/repo")
	db := &projectionWriteStore{
		projectionStore: &projectionStore{t: t, facts: store.GitHubProjectAppFacts{
			Project: model.Project{ID: projectID, Ownership: model.ProjectOwnership{TeamID: userID, Version: 8}},
			Access:  model.ProjectAccess{Role: model.ProjectAdmin}, Connection: connection,
			AppResourceID: pointer(appID), GrantID: pointer(projectAppGrant), CredentialVersion: pointer(int64(3)),
		}},
		completion: store.Completion{Outcome: store.TransactionCommitted},
	}
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	mux := http.NewServeMux()
	RegisterProjectAppRoutes(mux, service.NewProjectAppManager(db, nil, logger), projectionAuth{}, logger)
	w := &appShortWriter{header: make(http.Header)}
	httpx.RequestLogging(logger, mux).ServeHTTP(w, projectAppLoggingRequest("PATCH", "/settings", `{"version":"3","pollIntervalMinutes":5}`))
	records := projectAppLogRecords(t, logs.Bytes())
	if db.writes != 1 || db.reads != 0 || db.appReads != 1 || w.writes != 1 || w.status != http.StatusOK || len(records) != 2 {
		t.Fatalf("scopes=%d reads=%d appReads=%d responseWrites=%d status=%d logs=%s", db.writes, db.reads, db.appReads, w.writes, w.status, &logs)
	}
	for _, record := range records {
		for key, value := range map[string]any{"component": "github", "request_id": "project-app-request", "user_id": userID,
			"project_id": projectID, "app_resource_id": appID, "app_id": json.Number("9"), "version": json.Number("3"), "generation": json.Number("9")} {
			if record[key] != value {
				t.Errorf("%s=%v want %v in %s", key, record[key], value, &logs)
			}
		}
	}
	if records[0]["type"] != "github_project_app_transaction" || records[0]["phase"] != "settings" || records[0]["write_outcome"] != "committed" {
		t.Fatalf("database completion changed by delivery: %s", &logs)
	}
	if records[1]["phase"] != "response" || records[1]["operation_phase"] != "settings" || records[1]["write_outcome"] != "unknown" {
		t.Fatalf("response delivery outcome: %s", &logs)
	}
}
