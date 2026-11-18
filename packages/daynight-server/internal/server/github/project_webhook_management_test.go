package github

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

// These controlled DAOs supply independent transaction facts. PostgreSQL tests
// own persistence and locking; the adapter test exercises real service and core.
type projectWebhookReadFixture struct {
	*projectionStore
	hook  store.GitHubProjectWebhook
	reads int
}

func (f *projectWebhookReadFixture) ReadGitHubProjectApp(_ context.Context, id string, work func(store.GitHubProjectAppReadDAO) error) error {
	if id != projectID {
		f.t.Fatalf("unexpected project %s", id)
	}
	f.reads++
	return work(f)
}
func (f *projectWebhookReadFixture) ProjectWebhook(context.Context) (store.GitHubProjectWebhook, error) {
	return f.hook, nil
}

type projectWebhookWriteFixture struct {
	store.ProjectWriteScope
	t      *testing.T
	role   model.ProjectRole
	locked store.GitHubProjectWebhookLocked
	locks  int
	writes []store.GitHubProjectWebhookWrite
}

func (f *projectWebhookWriteFixture) WriteProject(_ context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	if id != projectID {
		f.t.Fatalf("unexpected project %s", id)
	}
	err := work(f)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (f *projectWebhookWriteFixture) GitHubProjectWebhookDAO() store.GitHubProjectWebhookWriteDAO {
	return f
}
func (f *projectWebhookWriteFixture) Authorization(_ context.Context, p model.Principal) (model.ProjectAccess, error) {
	if p.UserID != userID || p.CredentialID != projectAppGrant {
		f.t.Fatalf("principal=%+v", p)
	}
	return model.ProjectAccess{Role: f.role}, nil
}
func (f *projectWebhookWriteFixture) LockWebhook(context.Context) (store.GitHubProjectWebhookLocked, error) {
	f.locks++
	return f.locked, nil
}
func (f *projectWebhookWriteFixture) SaveWebhook(_ context.Context, write store.GitHubProjectWebhookWrite) (bool, error) {
	f.writes = append(f.writes, write)
	return true, nil
}

func TestProjectWebhookRealManagementThroughHTTP(t *testing.T) {
	repo, version := int64(42), int64(1)
	read := &projectWebhookReadFixture{projectionStore: &projectionStore{t: t, facts: store.GitHubProjectAppFacts{
		Project: model.Project{ID: projectID}, Access: model.ProjectAccess{Role: model.ProjectMemberRole}, Connection: githubpr.DefaultConnection(projectID),
	}}, hook: store.GitHubProjectWebhook{Version: &version, Enabled: true, RepositoryID: &repo, CurrentRepositoryID: &repo}}
	write := &projectWebhookWriteFixture{t: t, role: model.ProjectMemberRole, locked: store.GitHubProjectWebhookLocked{Exists: true, BindingValid: true, GitHubProjectWebhook: store.GitHubProjectWebhook{CurrentRepositoryID: &repo}}}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	manager := service.NewProjectAppManager(read, nil, logger)
	mux := http.NewServeMux()
	RegisterProjectAppRoutesWithWebhook(mux, manager, manager, service.NewProjectWebhookManager(write), projectionAuth{}, "https://daynight.example", logger)
	base := "/api/v1/projects/" + projectID + "/github"
	w := managementCall(mux, "GET", base, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"projectWebhook":`) || !strings.Contains(w.Body.String(), `"repositoryId":"42"`) || read.reads != 1 {
		t.Fatalf("member read status=%d body=%s reads=%d", w.Code, w.Body, read.reads)
	}
	create := `{"expectedUserId":"` + userID + `","version":null,"enabled":true,"repositoryId":"42","secret":"managed-secret"}`
	w = managementCall(mux, "PATCH", base+"/webhook", create)
	if w.Code != 403 || !strings.Contains(w.Body.String(), `"forbidden"`) || write.locks != 0 || len(write.writes) != 0 {
		t.Fatalf("member write status=%d body=%s locks=%d writes=%d", w.Code, w.Body, write.locks, len(write.writes))
	}
	write.role = model.ProjectAdmin
	w = managementCall(mux, "PATCH", base+"/webhook", create)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"version":"1"`) || !strings.Contains(w.Body.String(), `"state":"waiting"`) || strings.Contains(w.Body.String(), "managed-secret") || len(write.writes) != 1 {
		t.Fatalf("create status=%d body=%s writes=%d", w.Code, w.Body, len(write.writes))
	}
	first := write.writes[0]
	if first.ExpectedVersion != nil || first.Version != 1 || first.RepositoryID != repo || !first.Enabled || string(first.Secret) != "managed-secret" {
		t.Fatalf("create parameters=%+v", first)
	}
	// Supply the current row independently; the mock's prior write is not evidence of persistence.
	write.locked = store.GitHubProjectWebhookLocked{Exists: true, GitHubProjectWebhook: store.GitHubProjectWebhook{Version: &version, Enabled: true, RepositoryID: &repo}, Secret: []byte("managed-secret")}
	w = managementCall(mux, "PATCH", base+"/webhook", `{"expectedUserId":"`+userID+`","version":"1","enabled":false}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"version":"2"`) || !strings.Contains(w.Body.String(), `"state":"disabled"`) || len(write.writes) != 2 {
		t.Fatalf("disable status=%d body=%s writes=%d", w.Code, w.Body, len(write.writes))
	}
	last := write.writes[1]
	if last.ExpectedVersion == nil || *last.ExpectedVersion != 1 || last.Version != 2 || last.Enabled || last.RepositoryID != repo || string(last.Secret) != "managed-secret" {
		t.Fatalf("disable parameters=%+v", last)
	}
}
