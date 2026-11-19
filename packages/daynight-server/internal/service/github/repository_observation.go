package github

import (
	"context"

	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ObserveRepository uses only the existing installation and never probes a candidate
// for a user without owner Team administration and the current App grant.
func (m *ProjectAppManager) ObserveRepository(ctx context.Context, f store.GitHubProjectAppFacts, app *store.GitHubProjectApp, address string) coreproject.RepositoryEvidence {
	e := coreproject.RepositoryEvidence{OldID: f.Connection.RepositoryID}
	owner, name, err := coregithub.ProjectRepository(address)
	if err != nil {
		e.UnverifiedReason = "unsupported_host"
		return e
	}
	if e.OldID == nil {
		e.UnverifiedReason = "no_verified_repository"
	} else {
		e.UnverifiedReason = "no_github_access"
	}
	if app == nil || f.AppResourceID == nil || f.GrantID == nil || f.CredentialVersion == nil || f.Connection.InstallationID == nil || app.CredentialVersion != *f.CredentialVersion || m.provider == nil {
		return e
	}
	client, release, err := m.provider.Acquire(ctx, app.ID, app.CredentialVersion)
	if err != nil {
		e.UnverifiedReason = "provider_unavailable"
		return e
	}
	defer release()
	if e.OldID != nil {
		old, err := client.ResolveRepository(ctx, *f.Connection.InstallationID, *e.OldID)
		if err == nil && old.ID == *e.OldID {
			e.OldFullName = old.FullName
		} else {
			e.UnverifiedReason = "provider_unavailable"
		}
	}
	if f.Access.TeamRole != nil && *f.Access.TeamRole == model.ProjectAdmin {
		candidate, err := client.Repository(ctx, *f.Connection.InstallationID, owner, name)
		if err == nil && candidate.ID > 0 {
			e.TargetID = &candidate.ID
			e.TargetFullName = candidate.FullName
			e.TargetPrivate = candidate.Private
		} else {
			e.UnverifiedReason = "provider_unavailable"
		}
	}
	return e
}
