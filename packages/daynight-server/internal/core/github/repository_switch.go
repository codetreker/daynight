package github

import (
	"math"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// RepositorySwitch decides the complete disconnected state under the connection lock.
func RepositorySwitch(current githubpr.Connection, target *store.GitHubRepositoryTarget) (store.GitHubRepositorySwitchWrite, error) {
	if current.Version == math.MaxInt64 || current.Generation == math.MaxInt64 || current.Revision == math.MaxInt64 {
		return store.GitHubRepositorySwitchWrite{}, &model.Fault{Code: "version_exhausted", Message: "GitHub connection version is exhausted."}
	}
	if target != nil && (target.RepositoryID <= 0 || strings.TrimSpace(target.FullName) == "") {
		return store.GitHubRepositorySwitchWrite{}, invalid("Invalid verified repository identity.")
	}
	next := githubpr.Connection{
		ProjectID: current.ProjectID,
		Version:   current.Version + 1, Generation: current.Generation + 1, Revision: current.Revision + 1,
		LegacyRepositoryID: current.LegacyRepositoryID, PollIntervalMinutes: current.PollIntervalMinutes,
		AccessState: "unknown",
	}
	if target != nil {
		next.RepositoryID, next.RepositoryFullName, next.RepositoryPrivate = &target.RepositoryID, &target.FullName, &target.Private
	}
	decision := store.GitHubRepositorySwitchWrite{ExpectedVersion: current.Version, ExpectedGeneration: current.Generation, ExpectedRevision: current.Revision, Connection: next}
	if target != nil {
		decision.Source = &githubpr.Repository{RepositoryID: target.RepositoryID, FullName: target.FullName}
	}
	return decision, nil
}
