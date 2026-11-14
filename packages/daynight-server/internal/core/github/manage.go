package github

import (
	"context"
	"math"
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

// Manage applies a decision inside the live Project write scope, rechecking the
// principal, original version and repository address after remote verification.
func Manage(ctx context.Context, s store.ProjectWriteScope, p model.Principal, version int64, action string, minutes int32, appID int64, expectedRepo string, candidate InstallationCandidate) (githubpr.Connection, error) {
	return manage(ctx, s, p, version, action, minutes, appID, expectedRepo, candidate, false, false)
}

// ManageSync changes the synchronization intent under the same Project lock as
// connection management. Availability is a deployment fact, not stored intent.
func ManageSync(ctx context.Context, s store.ProjectWriteScope, p model.Principal, version int64, enabled, available bool, appID int64) (githubpr.Connection, error) {
	return manage(ctx, s, p, version, "sync", 0, appID, "", InstallationCandidate{}, enabled, available)
}

func manage(ctx context.Context, s store.ProjectWriteScope, p model.Principal, version int64, action string, minutes int32, appID int64, expectedRepo string, candidate InstallationCandidate, syncEnabled, available bool) (githubpr.Connection, error) {
	access, err := project.RequireProjectWrite(ctx, s.ProjectDAO(), p)
	if err != nil {
		return githubpr.Connection{}, err
	}
	if err = project.RequireProjectAdmin(access); err != nil {
		return githubpr.Connection{}, err
	}
	if action == "connect" {
		currentProject, err := s.ProjectDAO().Project(ctx)
		if err != nil {
			return githubpr.Connection{}, err
		}
		if currentProject.RepoURL != expectedRepo {
			return githubpr.Connection{}, &model.Fault{Code: "github_repository_mismatch", Message: "Project repository changed during verification."}
		}
	}
	dao := s.GitHubDAO()
	c, err := dao.Connection(ctx)
	if err != nil {
		return c, err
	}
	if version < 1 {
		return c, invalid("Version must be positive.")
	}
	if c.Version != version {
		return c, &model.Fault{Code: "version_conflict", Message: "GitHub configuration version does not match."}
	}
	w := configuration(c)
	switch action {
	case "connect":
		if appID <= 0 || candidate.Installation.ID <= 0 || candidate.Installation.AccountLogin == "" || candidate.Repository.ID <= 0 || candidate.Repository.FullName == "" {
			return c, invalid("Invalid GitHub connection proof.")
		}
		if c.RepositoryID != nil && *c.RepositoryID != candidate.Repository.ID {
			return c, &model.Fault{Code: "github_repository_mismatch", Message: "GitHub repository does not match retained data."}
		}
		if c.Enabled && c.AccessState == "available" && c.AppID != nil && *c.AppID == appID && c.InstallationID != nil && *c.InstallationID == candidate.Installation.ID && c.RepositoryID != nil && *c.RepositoryID == candidate.Repository.ID {
			return c, nil
		}
		now, e := dao.ObservedAt(ctx)
		if e != nil {
			return c, e
		}
		w.Enabled = true
		w.AppID = &appID
		w.InstallationID = &candidate.Installation.ID
		w.InstallationAccountLogin = &candidate.Installation.AccountLogin
		w.RepositoryID = &candidate.Repository.ID
		w.RepositoryFullName = &candidate.Repository.FullName
		w.RepositoryPrivate = &candidate.Repository.Private
		w.AccessState = "available"
		w.AccessReason = nil
		w.AccessCheckedAt = &now
		w.NextAccessCheckAt = nil
		w.NextPollAt = nil
		if c.SyncEnabled {
			w.NextPollAt = &now
		}
		if c.Generation == math.MaxInt64 {
			return c, &model.Fault{Code: "version_exhausted", Message: "GitHub generation exhausted."}
		}
		w.Generation++
	case "disconnect":
		if !c.Enabled {
			return c, nil
		}
		if c.Generation == math.MaxInt64 {
			return c, &model.Fault{Code: "version_exhausted", Message: "GitHub generation exhausted."}
		}
		w.Generation++
		w.Enabled = false
		w.SyncEnabled = false
		w.NextPollAt = nil
		w.NextAccessCheckAt = nil
	case "sync":
		if c.SyncEnabled == syncEnabled {
			return c, nil
		}
		if syncEnabled {
			if !available {
				return c, &model.Fault{Code: "github_not_configured", Message: "GitHub integration is not configured."}
			}
			if !c.Enabled {
				return c, &model.Fault{Code: "github_not_connected", Message: "GitHub repository is not connected."}
			}
			if c.AppID == nil || *c.AppID != appID || c.InstallationID == nil || c.RepositoryID == nil || c.AccessState != "available" {
				return c, &model.Fault{Code: "github_connection_unavailable", Message: "GitHub connection must be restored before synchronization."}
			}
		}
		if c.Generation == math.MaxInt64 {
			return c, &model.Fault{Code: "version_exhausted", Message: "GitHub generation exhausted."}
		}
		w.Generation++
		w.SyncEnabled = syncEnabled
		w.NextPollAt = nil
		w.NextAccessCheckAt = nil
		if syncEnabled {
			now, e := dao.ObservedAt(ctx)
			if e != nil {
				return c, e
			}
			w.NextPollAt = &now
		}
	case "settings":
		if minutes < 1 {
			return c, invalid("Polling interval must be a positive integer.")
		}
		if c.PollIntervalMinutes == minutes {
			return c, nil
		}
		now, e := dao.ObservedAt(ctx)
		if e != nil {
			return c, e
		}
		w.PollIntervalMinutes = minutes
		if c.Enabled && c.SyncEnabled && (c.ClaimKind == nil || *c.ClaimKind != WorkPoll) {
			// Initial reconciliation and failed retries retain their existing deadlines.
			// A completed cycle is scheduled from its last success, in either direction.
			if c.NextPollAt != nil && c.PollErrorCode == nil && c.LastFullSuccessAt != nil && c.LastFullGeneration != nil && *c.LastFullGeneration == c.Generation {
				deadline := IntervalAfter(*c.LastFullSuccessAt, minutes)
				latest := IntervalAfter(now, minutes)
				if deadline.After(latest) {
					deadline = latest
				}
				w.NextPollAt = &deadline
			}
			if c.AccessState == "unavailable" && c.NextAccessCheckAt != nil && c.AccessCheckedAt != nil {
				deadline := IntervalAfter(*c.AccessCheckedAt, minutes)
				latest := IntervalAfter(now, minutes)
				if deadline.After(latest) {
					deadline = latest
				}
				w.NextAccessCheckAt = &deadline
			}
		}
	default:
		return c, invalid("Invalid GitHub management operation.")
	}
	if c.Version == math.MaxInt64 || c.Revision == math.MaxInt64 {
		return c, &model.Fault{Code: "version_exhausted", Message: "GitHub configuration version exhausted."}
	}
	w.Version++
	w.Revision++
	ok, err := dao.SaveConfiguration(ctx, w)
	if err != nil {
		return c, err
	}
	if !ok {
		return c, &model.Fault{Code: "version_conflict", Message: "GitHub configuration version does not match."}
	}
	return dao.Connection(ctx)
}
