package github

import (
	"context"
	"crypto/rsa"
	"errors"
	"fmt"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
)

type appVerifier func(context.Context, int64, *rsa.PrivateKey) (remote.AppIdentity, error)

// AppManager coordinates remote proof with the short App transaction.
type AppManager struct {
	db      store.GitHubAppStore
	verify  appVerifier
	current AuthorizationReader
}

func NewAppManager(db store.GitHubAppStore) *AppManager {
	return &AppManager{db: db, verify: remote.VerifyApp}
}

// NewScopedAppManager supplies current authority for work resumed after proof.
func NewScopedAppManager(db store.GitHubAppStore, current AuthorizationReader) *AppManager {
	return &AppManager{db: db, verify: remote.VerifyApp, current: current}
}

func (m *AppManager) CreateApp(ctx context.Context, p model.Principal, in core.CreateAppInput) (core.AppMetadata, error) {
	return m.createApp(ctx, p, in, nil)
}

func (m *AppManager) createApp(ctx context.Context, p model.Principal, in core.CreateAppInput, afterProof func(context.Context) error) (core.AppMetadata, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	if err := core.ValidateCreateApp(p, in); err != nil {
		return core.AppMetadata{}, err
	}
	key, err := config.ParsePrivateKey([]byte(in.PrivateKeyPEM))
	if err != nil {
		return core.AppMetadata{}, &ManagementError{Code: "github_app_credentials_invalid", Message: "GitHub App credentials are invalid.", Cause: err}
	}
	identity, err := m.verify(ctx, in.GitHubAppID, key)
	if err != nil {
		if errors.Is(err, remote.ErrAppCredentialsInvalid) {
			return core.AppMetadata{}, &ManagementError{Code: "github_app_credentials_invalid", Message: "GitHub App credentials are invalid.", Cause: err}
		}
		if ctx.Err() != nil {
			return core.AppMetadata{}, ctx.Err()
		}
		var upstream *remote.Error
		if errors.As(err, &upstream) && upstream.Code == "rate_limited" {
			return core.AppMetadata{}, &ManagementError{Code: "github_rate_limited", Message: "GitHub rate limit reached.", Cause: err}
		}
		return core.AppMetadata{}, &ManagementError{Code: "github_unavailable", Message: "GitHub is temporarily unavailable.", Cause: err}
	}
	if afterProof != nil {
		if err := afterProof(ctx); err != nil {
			return core.AppMetadata{}, err
		}
	}
	var out githubpr.AppMetadata
	completion, err := m.db.WriteGitHubApp(ctx, func(dao store.GitHubAppWriteDAO) error {
		var e error
		out, e = dao.Create(ctx, store.GitHubAppCreate{ID: in.ID, GitHubAppID: in.GitHubAppID, Name: in.Name, GitHubName: identity.Name, GitHubSlug: identity.Slug, CreatorUserID: p.UserID, Credentials: githubpr.AppCredentials{PrivateKeyPEM: []byte(in.PrivateKeyPEM), WebhookSecret: []byte(in.WebhookSecret)}})
		return e
	})
	if completion.Outcome == store.TransactionUnknown {
		return core.AppMetadata{}, &ManagementError{Code: "github_write_outcome_unknown", Message: "GitHub App write outcome is unknown; read the resource before deciding what to do.", Cause: err}
	}
	if err != nil {
		if errors.Is(err, store.ErrGitHubAppIDConflict) {
			return core.AppMetadata{}, &ManagementError{Code: "github_app_already_registered", Message: "GitHub App is already registered.", Cause: err}
		}
		if errors.Is(err, store.ErrGitHubAppResourceIDConflict) {
			return core.AppMetadata{}, &ManagementError{Code: "github_app_id_conflict", Message: "App resource ID is already used.", Cause: err}
		}
		return core.AppMetadata{}, err
	}
	if completion.Outcome != store.TransactionCommitted {
		return core.AppMetadata{}, fmt.Errorf("GitHub App transaction not committed")
	}
	return out, nil
}

func (m *AppManager) GetApp(ctx context.Context, p model.Principal, id string) (core.AppMetadata, error) {
	return m.getApp(ctx, p, id, nil)
}

func (m *AppManager) getApp(ctx context.Context, p model.Principal, id string, admit func() error) (core.AppMetadata, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	if err := core.ValidateAppRead(p, id); err != nil {
		return core.AppMetadata{}, err
	}
	var out core.AppMetadata
	var refusal *model.Fault
	err := m.db.ReadGitHubApps(ctx, func(dao store.GitHubAppReadDAO) error {
		return completion.Capture(func() error {
			if admit != nil {
				visible, ok := dao.(store.GitHubAppVisibilityReader)
				if !ok {
					return errors.New("GitHub App visibility capability unavailable")
				}
				e := visible.RequireAppVisible(ctx, id, p.UserID)
				if errors.Is(e, model.ErrNotFound) {
					return &model.Fault{Code: "not_found", Message: "GitHub App was not found.", Cause: e}
				}
				if e != nil {
					return e
				}
				if e = admit(); e != nil {
					return e
				}
			}
			var e error
			out, e = dao.Get(ctx, id, p.UserID)
			if errors.Is(e, model.ErrNotFound) {
				return &model.Fault{Code: "not_found", Message: "GitHub App was not found.", Cause: e}
			}
			return e
		}, &refusal)
	})
	if err != nil {
		return core.AppMetadata{}, err
	}
	if refusal != nil {
		return core.AppMetadata{}, refusal
	}
	return out, nil
}

func (m *AppManager) ListApps(ctx context.Context, p model.Principal, in core.ListAppsInput) (core.AppPage, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	var out core.AppPage
	err := m.db.ReadGitHubApps(ctx, func(dao store.GitHubAppReadDAO) error { var e error; out, e = core.ListApps(ctx, dao, p, in); return e })
	return out, err
}
