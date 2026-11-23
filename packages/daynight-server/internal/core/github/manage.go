package github

import (
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	project "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// InstallationCandidate is the verified installation and repository for a Project.
type InstallationCandidate struct {
	Installation githubpr.InstallationObservation
	Repository   githubpr.RepositoryObservation
}

// ProjectRepository applies the same canonical repository identity as Projects.
func ProjectRepository(address string) (string, string, error) {
	identity, err := project.RepositoryIdentity(address)
	if err != nil {
		return "", "", err
	}
	if !strings.HasPrefix(identity, "github.com/") {
		return "", "", &model.Fault{Code: "github_repository_mismatch", Message: "Project repository must be a GitHub.com repository."}
	}
	owner, repo, err := RepositoryParts(strings.TrimPrefix(identity, "github.com/"))
	if err != nil {
		return "", "", &model.Fault{Code: "github_repository_mismatch", Message: "Project repository must identify a GitHub.com repository."}
	}
	return owner, repo, nil
}

func configuration(c githubpr.Connection) store.GitHubConfigurationWrite {
	return store.GitHubConfigurationWrite{ExpectedVersion: c.Version, Version: c.Version, Generation: c.Generation, Revision: c.Revision, Enabled: c.Enabled, SyncEnabled: c.SyncEnabled,
		AppID: c.AppID, InstallationID: c.InstallationID, RepositoryID: c.RepositoryID, InstallationAccountLogin: c.InstallationAccountLogin,
		RepositoryFullName: c.RepositoryFullName, RepositoryPrivate: c.RepositoryPrivate, PollIntervalMinutes: c.PollIntervalMinutes,
		AccessState: c.AccessState, AccessReason: c.AccessReason, AccessCheckedAt: c.AccessCheckedAt, NextAccessCheckAt: c.NextAccessCheckAt, NextPollAt: c.NextPollAt}
}
