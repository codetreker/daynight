package github

import (
	"bytes"
	"context"
	"math"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	project "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

type ProjectWebhook = store.GitHubProjectWebhook

type ProjectWebhookInput struct {
	ExpectedUserID string
	Version        *int64
	Enabled        bool
	RepositoryID   *int64
	Secret         *string
}

func ValidateProjectWebhookInput(p model.Principal, in ProjectWebhookInput) error {
	if err := team.RequireActor(p, in.ExpectedUserID); err != nil {
		return err
	}
	if in.Version != nil && *in.Version < 1 {
		return invalid("Version must be positive.")
	}
	if in.RepositoryID != nil && *in.RepositoryID < 1 {
		return invalid("Repository ID must be positive.")
	}
	if in.Secret != nil && (len(*in.Secret) == 0 || len(*in.Secret) > 4096 || !utf8.ValidString(*in.Secret)) {
		return invalid("Secret must contain 1 to 4096 UTF-8 bytes.")
	}
	return nil
}

// ManageProjectWebhook executes only inside the live Project write scope.
func ManageProjectWebhook(ctx context.Context, dao store.GitHubProjectWebhookWriteDAO, p model.Principal, in ProjectWebhookInput) (ProjectWebhook, error) {
	if err := ValidateProjectWebhookInput(p, in); err != nil {
		return ProjectWebhook{}, err
	}
	access, err := dao.Authorization(ctx, p)
	if err != nil {
		return ProjectWebhook{}, project.LookupError(err)
	}
	if err = project.RequireProjectAdmin(access); err != nil {
		return ProjectWebhook{}, err
	}
	old, err := dao.LockWebhook(ctx)
	if err != nil {
		return ProjectWebhook{}, err
	}
	if !old.Exists {
		return ProjectWebhook{}, &model.Fault{Code: "github_not_connected", Message: "GitHub repository is not connected."}
	}
	if (old.Version == nil) != (in.Version == nil) || old.Version != nil && *old.Version != *in.Version {
		return ProjectWebhook{}, &model.Fault{Code: "version_conflict", Message: "Project webhook version changed."}
	}
	repo := old.RepositoryID
	if in.RepositoryID != nil {
		repo = in.RepositoryID
	}
	secret := old.Secret
	if in.Secret != nil {
		secret = []byte(*in.Secret)
	}
	first := old.Version == nil
	changedRepo := !first && *old.RepositoryID != *repo
	if first && (in.RepositoryID == nil || in.Secret == nil) || changedRepo && in.Secret == nil {
		return ProjectWebhook{}, invalid("Repository ID and secret are required for a new binding.")
	}
	changedSecret := in.Secret != nil && !bytes.Equal(secret, old.Secret)
	if first || changedRepo || changedSecret || (!old.Enabled && in.Enabled) {
		if !old.BindingValid || old.CurrentRepositoryID == nil {
			return ProjectWebhook{}, &model.Fault{Code: "github_not_connected", Message: "An authorized GitHub repository connection is required."}
		}
		if repo == nil || *repo != *old.CurrentRepositoryID {
			return ProjectWebhook{}, &model.Fault{Code: "github_repository_mismatch", Message: "Repository does not match the current connection."}
		}
	}
	changed := first || changedRepo || changedSecret || old.Enabled != in.Enabled
	if !changed {
		return old.GitHubProjectWebhook, nil
	}
	version := int64(1)
	if !first {
		if *old.Version == math.MaxInt64 {
			return ProjectWebhook{}, &model.Fault{Code: "version_exhausted", Message: "Project webhook version exhausted."}
		}
		version = *old.Version + 1
	}
	saved, err := dao.SaveWebhook(ctx, store.GitHubProjectWebhookWrite{ExpectedVersion: in.Version, Version: version, RepositoryID: *repo, Enabled: in.Enabled, Secret: secret})
	if err != nil {
		return ProjectWebhook{}, err
	}
	if !saved {
		return ProjectWebhook{}, &model.Fault{Code: "version_conflict", Message: "Project webhook version changed."}
	}
	return ProjectWebhook{Version: &version, RepositoryID: repo, Enabled: in.Enabled, CurrentRepositoryID: old.CurrentRepositoryID}, nil
}
