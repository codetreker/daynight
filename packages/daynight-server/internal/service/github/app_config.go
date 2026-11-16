package github

import (
	"context"
	"errors"
	"fmt"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
)

// ConfigManager coordinates credential proofs and App configuration transactions.
type ConfigManager struct {
	db     store.GitHubAppConfigStore
	verify appVerifier
}

func NewConfigManager(db store.GitHubAppConfigStore) *ConfigManager {
	return &ConfigManager{db: db, verify: remote.VerifyApp}
}

func appConfigCompletion(c store.Completion, err error, proven bool) error {
	if c.Outcome == store.TransactionUnknown {
		return &ManagementError{Code: "github_write_outcome_unknown", Message: "GitHub App write outcome is unknown; inspect the current resource before deciding what to do.", Cause: err}
	}
	if err != nil {
		var tx *store.TransactionError
		var fault *model.Fault
		failed, _ := store.DatabaseErrorFacts(err)
		if !failed && !errors.As(err, &fault) && errors.Is(err, model.ErrNotFound) && c.Outcome == store.TransactionNotCommitted && errors.As(err, &tx) && tx.Phase == "operation" && !tx.CleanupFailed && tx.Outcome == store.TransactionNotCommitted {
			if proven {
				return &model.Fault{Code: "github_admin_changed", Message: "App administrator changed.", Cause: err}
			}
			return &model.Fault{Code: "not_found", Message: "GitHub App was not found.", Cause: err}
		}
		return err
	}
	if c.Outcome != store.TransactionCommitted {
		return fmt.Errorf("GitHub App transaction not committed")
	}
	return nil
}

func appProofError(ctx context.Context, err error) error {
	if errors.Is(err, remote.ErrAppCredentialsInvalid) {
		return &ManagementError{Code: "github_app_credentials_invalid", Message: "GitHub App credentials are invalid.", Cause: err}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var upstream *remote.Error
	if errors.As(err, &upstream) && upstream.Code == "rate_limited" {
		return &ManagementError{Code: "github_rate_limited", Message: "GitHub rate limit reached.", Cause: err}
	}
	return &ManagementError{Code: "github_unavailable", Message: "GitHub is temporarily unavailable.", Cause: err}
}

func (m *ConfigManager) UpdateApp(ctx context.Context, p model.Principal, id string, in core.UpdateAppInput) (core.AppMetadata, error) {
	budget := core.OperationTimeout
	if in.PrivateKeyPEM != nil || in.WebhookSecret != nil {
		budget = 45 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	if err := core.ValidateUpdateApp(p, id, in); err != nil {
		return core.AppMetadata{}, err
	}
	var proof *core.AppUpdateProof
	if in.PrivateKeyPEM != nil || in.WebhookSecret != nil {
		var facts store.GitHubAppConfigFacts
		var refusal *model.Fault
		err := m.db.ReadGitHubAppConfig(ctx, id, func(dao store.GitHubAppConfigReader) error {
			return completion.Capture(func() error { var e error; facts, e = core.ReadAppConfigForUpdate(ctx, dao, p, in); return e }, &refusal)
		})
		if err != nil {
			return core.AppMetadata{}, err
		}
		if refusal != nil {
			return core.AppMetadata{}, refusal
		}
		credentials, changed := core.ProposedAppCredentials(facts, in)
		if changed {
			key, err := config.ParsePrivateKey(credentials.PrivateKeyPEM)
			if err != nil {
				return core.AppMetadata{}, &ManagementError{Code: "github_app_credentials_invalid", Message: "GitHub App credentials are invalid.", Cause: err}
			}
			identity, err := m.verify(ctx, facts.App.GitHubAppID, key)
			if err != nil {
				return core.AppMetadata{}, appProofError(ctx, err)
			}
			if identity.ID != facts.App.GitHubAppID {
				return core.AppMetadata{}, &ManagementError{Code: "github_app_credentials_invalid", Message: "GitHub App credentials are invalid."}
			}
			proof = &core.AppUpdateProof{MembershipVersion: facts.MembershipVersion, Version: facts.App.Version, GitHubAppID: facts.App.GitHubAppID, GitHubName: identity.Name, GitHubSlug: identity.Slug}
		}
	}
	var result core.AppMetadata
	c, err := m.db.WriteGitHubAppConfig(ctx, id, func(dao store.GitHubAppConfigWriter) error {
		var e error
		result, e = core.UpdateApp(ctx, dao, p, in, proof)
		return e
	})
	if err = appConfigCompletion(c, err, proof != nil); err != nil {
		return core.AppMetadata{}, err
	}
	return result, nil
}

func (m *ConfigManager) RemoveApp(ctx context.Context, p model.Principal, id string, in core.RemoveAppInput) error {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	if err := core.ValidateRemoveApp(p, id, in); err != nil {
		return err
	}
	c, err := m.db.WriteGitHubAppConfig(ctx, id, func(dao store.GitHubAppConfigWriter) error { return core.RemoveApp(ctx, dao, p, in) })
	return appConfigCompletion(c, err, false)
}
