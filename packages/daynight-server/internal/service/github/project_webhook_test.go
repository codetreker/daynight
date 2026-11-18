package github

import (
	"context"
	"errors"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type webhookServiceDAO struct{ saves int }

func (*webhookServiceDAO) Authorization(_ context.Context, p model.Principal) (model.ProjectAccess, error) {
	if p != mgmtPrincipal {
		return model.ProjectAccess{}, errors.New("unexpected principal")
	}
	return model.ProjectAccess{Role: model.ProjectAdmin}, nil
}
func (*webhookServiceDAO) LockWebhook(context.Context) (store.GitHubProjectWebhookLocked, error) {
	version, repo := int64(2), int64(42)
	return store.GitHubProjectWebhookLocked{GitHubProjectWebhook: store.GitHubProjectWebhook{Version: &version, RepositoryID: &repo, Enabled: true}, Secret: []byte("secret"), Exists: true}, nil
}
func (d *webhookServiceDAO) SaveWebhook(_ context.Context, w store.GitHubProjectWebhookWrite) (bool, error) {
	d.saves++
	if w.ExpectedVersion == nil || *w.ExpectedVersion != 2 || w.Version != 3 || w.Enabled {
		return false, errors.New("unexpected write")
	}
	return true, nil
}

type webhookServiceScope struct {
	store.ProjectWriteScope
	dao *webhookServiceDAO
}

func (s webhookServiceScope) GitHubProjectWebhookDAO() store.GitHubProjectWebhookWriteDAO {
	return s.dao
}

type webhookServiceWriter struct {
	t       *testing.T
	outcome store.TransactionOutcome
	cause   error
	dao     *webhookServiceDAO
}

func (s webhookServiceWriter) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	if id != mgmtProject {
		s.t.Fatalf("project %s", id)
	}
	if _, ok := ctx.Deadline(); !ok {
		s.t.Fatal("missing operation deadline")
	}
	if err := work(webhookServiceScope{dao: s.dao}); err != nil {
		s.t.Fatalf("callback: %v", err)
	}
	return store.Completion{Outcome: s.outcome}, s.cause
}
func TestProjectWebhookManagerCompletion(t *testing.T) {
	lost := errors.New("commit response lost")
	cases := []struct {
		name             string
		outcome          store.TransactionOutcome
		cause            error
		success, unknown bool
	}{
		{"committed", store.TransactionCommitted, nil, true, false},
		{"not committed", store.TransactionNotCommitted, errors.New("rollback"), false, false},
		{"unknown", store.TransactionUnknown, lost, false, true},
		{"not committed without error", store.TransactionNotCommitted, nil, false, false},
		{"unexpected outcome", "", nil, false, false},
		{"committed with error", store.TransactionCommitted, errors.New("cleanup failed"), false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dao := &webhookServiceDAO{}
			manager := NewProjectWebhookManager(webhookServiceWriter{t: t, outcome: tc.outcome, cause: tc.cause, dao: dao})
			version := int64(2)
			result, err := manager.Update(t.Context(), mgmtPrincipal, mgmtProject, core.ProjectWebhookInput{ExpectedUserID: mgmtPrincipal.UserID, Version: &version, Enabled: false})
			if dao.saves != 1 {
				t.Fatalf("saves=%d", dao.saves)
			}
			if tc.success {
				if err != nil || result.Version == nil || *result.Version != 3 {
					t.Fatalf("result=%+v err=%v", result, err)
				}
			} else {
				if err == nil || result.Version != nil {
					t.Fatalf("result=%+v err=%v", result, err)
				}
				if tc.cause != nil && !errors.Is(err, tc.cause) {
					t.Fatalf("lost cause: %v", err)
				}
				var management *ManagementError
				if tc.unknown && (!errors.As(err, &management) || management.Code != "github_write_outcome_unknown") {
					t.Fatalf("unknown error=%v", err)
				}
			}
		})
	}
}

// Invalid identities and inputs must be refused before a write scope is opened.
func TestProjectWebhookManagerRejectsInvalidInputBeforeWrite(t *testing.T) {
	manager := NewProjectWebhookManager(nil)
	for _, tc := range []struct {
		id    string
		input core.ProjectWebhookInput
	}{
		{"invalid-id", core.ProjectWebhookInput{ExpectedUserID: mgmtPrincipal.UserID}},
		{mgmtProject, core.ProjectWebhookInput{ExpectedUserID: "different-user"}},
	} {
		result, err := manager.Update(t.Context(), mgmtPrincipal, tc.id, tc.input)
		if err == nil || result.Version != nil {
			t.Fatalf("result=%+v err=%v", result, err)
		}
	}
}
