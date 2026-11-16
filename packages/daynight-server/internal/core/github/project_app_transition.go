package github

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func projectAppTransition(ctx context.Context, dao store.GitHubProjectAppWriteDAO, f store.GitHubProjectAppFacts, action string, in ProjectAppConnect, minutes int32, enabled bool, expectedRepo string, candidate InstallationCandidate, w *store.GitHubProjectAppWrite) (bool, bool, error) {
	c := f.Connection
	switch action {
	case "connect":
		selected, err := SelectProjectApp(ctx, dao, f, in.ProjectAppSelection)
		if err != nil {
			return false, false, err
		}
		if f.Project.RepoURL != expectedRepo {
			return false, false, &model.Fault{Code: "github_repository_mismatch", Message: "Project repository changed during verification."}
		}
		if candidate.Installation.ID != in.InstallationID || candidate.Installation.ID < 1 || candidate.Installation.AccountLogin == "" || candidate.Repository.ID < 1 || candidate.Repository.FullName == "" {
			return false, false, invalid("Invalid GitHub connection proof.")
		}
		if c.RepositoryID != nil && *c.RepositoryID != candidate.Repository.ID {
			return false, false, &model.Fault{Code: "github_repository_mismatch", Message: "GitHub repository does not match retained data."}
		}
		binding := f.AppResourceID == nil || *f.AppResourceID != selected.ID || f.GrantID == nil || *f.GrantID != in.GrantID || c.InstallationID == nil || *c.InstallationID != in.InstallationID
		if !binding && c.Enabled && c.AccessState == "available" && f.CredentialVersion != nil && *f.CredentialVersion == selected.CredentialVersion {
			return false, false, nil
		}
		now, e := dao.ObservedAt(ctx)
		if e != nil {
			return false, false, e
		}
		w.AppResourceID = &selected.ID
		w.GrantID = &in.GrantID
		w.CredentialVersion = &selected.CredentialVersion
		w.Configuration.Enabled = true
		w.Configuration.AppID = &selected.GitHubAppID
		w.Configuration.InstallationID = &candidate.Installation.ID
		w.Configuration.InstallationAccountLogin = &candidate.Installation.AccountLogin
		w.Configuration.RepositoryID = &candidate.Repository.ID
		w.Configuration.RepositoryFullName = &candidate.Repository.FullName
		w.Configuration.RepositoryPrivate = &candidate.Repository.Private
		w.Configuration.AccessState = "available"
		w.Configuration.AccessReason = nil
		w.Configuration.AccessCheckedAt = &now
		w.Configuration.NextAccessCheckAt = nil
		w.Configuration.NextPollAt = nil
		if c.SyncEnabled {
			w.Configuration.NextPollAt = &now
		}
		return true, binding, nil
	case "disconnect":
		if !c.Enabled && !c.SyncEnabled && f.AppResourceID == nil {
			return false, false, nil
		}
		w.AppResourceID = nil
		w.GrantID = nil
		w.CredentialVersion = nil
		w.Configuration.Enabled = false
		w.Configuration.SyncEnabled = false
		w.Configuration.AppID = nil
		w.Configuration.InstallationID = nil
		w.Configuration.InstallationAccountLogin = nil
		w.Configuration.AccessState = "unknown"
		w.Configuration.AccessReason = nil
		w.Configuration.AccessCheckedAt = nil
		w.Configuration.NextPollAt = nil
		w.Configuration.NextAccessCheckAt = nil
		return true, f.AppResourceID != nil, nil
	case "sync":
		if enabled {
			if !c.Enabled {
				return false, false, &model.Fault{Code: "github_not_connected", Message: "GitHub repository is not connected."}
			}
			if _, err := ProjectAppStatusFrom(ctx, dao, f); err != nil {
				return false, false, err
			}
			if c.AccessState != "available" {
				return false, false, &model.Fault{Code: "github_connection_unavailable", Message: "GitHub connection must be restored before synchronization."}
			}
		}
		if c.SyncEnabled == enabled {
			return false, false, nil
		}
		w.Configuration.SyncEnabled = enabled
		w.Configuration.NextPollAt = nil
		w.Configuration.NextAccessCheckAt = nil
		if enabled {
			now, e := dao.ObservedAt(ctx)
			if e != nil {
				return false, false, e
			}
			w.Configuration.NextPollAt = &now
		}
		return true, false, nil
	case "settings":
		if minutes < 1 {
			return false, false, invalid("Polling interval must be a positive integer.")
		}
		if c.PollIntervalMinutes == minutes {
			return false, false, nil
		}
		w.Configuration.PollIntervalMinutes = minutes
		if c.Enabled && c.SyncEnabled && (c.ClaimKind == nil || *c.ClaimKind != WorkPoll) {
			now, e := dao.ObservedAt(ctx)
			if e != nil {
				return false, false, e
			}
			if c.NextPollAt != nil && c.PollErrorCode == nil && c.LastFullSuccessAt != nil && c.LastFullGeneration != nil && *c.LastFullGeneration == c.Generation {
				deadline := IntervalAfter(*c.LastFullSuccessAt, minutes)
				latest := IntervalAfter(now, minutes)
				if deadline.After(latest) {
					deadline = latest
				}
				w.Configuration.NextPollAt = &deadline
			}
			if c.AccessState == "unavailable" && c.NextAccessCheckAt != nil && c.AccessCheckedAt != nil {
				deadline := IntervalAfter(*c.AccessCheckedAt, minutes)
				latest := IntervalAfter(now, minutes)
				if deadline.After(latest) {
					deadline = latest
				}
				w.Configuration.NextAccessCheckAt = &deadline
			}
		}
		return true, false, nil
	}
	panic("unvalidated project App action")
}
