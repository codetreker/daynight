package github

import (
	"context"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// CreateAppAuthorized checks the response projection before remote proof or writes.
func (m *AppManager) CreateAppAuthorized(ctx context.Context, auth model.CredentialAuthorization, in core.CreateAppInput) (core.AppMetadata, error) {
	if err := auth.Validate(); err != nil {
		return core.AppMetadata{}, err
	}
	if err := core.ValidateCreateApp(auth.Principal, in); err != nil {
		return core.AppMetadata{}, err
	}
	if err := scopeadmission.Require(auth, scopepolicy.GithubManage, scopepolicy.GithubRead); err != nil {
		return core.AppMetadata{}, err
	}
	return m.createApp(ctx, auth.Principal, in, func(ctx context.Context) error {
		return currentAdmission(ctx, m.current, auth, scopepolicy.GithubManage, scopepolicy.GithubRead)
	})
}

// GetAppAuthorized preserves the existing hidden-resource result before refusing scope.
func (m *AppManager) GetAppAuthorized(ctx context.Context, auth model.CredentialAuthorization, id string) (core.AppMetadata, error) {
	if err := auth.Validate(); err != nil {
		return core.AppMetadata{}, err
	}
	return m.getApp(ctx, auth.Principal, id, func() error {
		return scopeadmission.Require(auth, scopepolicy.GithubRead)
	})
}

func (m *AppManager) ListAppsAuthorized(ctx context.Context, auth model.CredentialAuthorization, in core.ListAppsInput) (core.AppPage, error) {
	if err := auth.Validate(); err != nil {
		return core.AppPage{}, err
	}
	if err := scopeadmission.Require(auth, scopepolicy.GithubRead); err != nil {
		return core.AppPage{}, err
	}
	return m.ListApps(ctx, auth.Principal, in)
}
