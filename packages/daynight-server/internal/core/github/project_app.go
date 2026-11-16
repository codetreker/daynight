package github

import (
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type ProjectAppSelection struct {
	AppResourceID, GrantID       string
	AppVersion, OwnershipVersion int64
}
type ProjectAppConnect struct {
	ProjectAppSelection
	Version, InstallationID int64
}
type ProjectAppDisconnect struct{ Version, OwnershipVersion int64 }
type ProjectAppRef struct {
	ID, Name, GitHubSlug string
	GitHubAppID          int64
}
type ProjectAppStatus struct {
	Status
	CanManageConnection bool
	App                 *ProjectAppRef
	GrantID             *string
}

func ValidateProjectAppSelection(in ProjectAppSelection) error {
	if err := grantID(in.AppResourceID); err != nil {
		return err
	}
	if err := grantID(in.GrantID); err != nil {
		return err
	}
	if in.AppVersion < 1 || in.OwnershipVersion < 1 {
		return invalid("Versions must be positive.")
	}
	return nil
}

func ReadProjectAppFacts(ctx context.Context, dao store.GitHubProjectAppReadDAO, p model.Principal) (store.GitHubProjectAppFacts, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return store.GitHubProjectAppFacts{}, err
	}
	f, err := dao.Facts(ctx, p)
	failed, _ := store.DatabaseErrorFacts(err)
	if !failed && errors.Is(err, model.ErrNotFound) {
		return f, &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: err}
	}
	return f, err
}

func RequireProjectConnectionAdmin(f store.GitHubProjectAppFacts, ownership int64) error {
	if f.Access.TeamRole == nil || *f.Access.TeamRole != model.ProjectAdmin {
		return &model.Fault{Code: "forbidden", Message: "Owner Team administrator permission is required."}
	}
	if f.Project.Ownership.Version != ownership {
		return &model.Fault{Code: "version_conflict", Message: "Project ownership changed."}
	}
	return nil
}

func SelectProjectApp(ctx context.Context, dao store.GitHubProjectAppReadDAO, f store.GitHubProjectAppFacts, in ProjectAppSelection) (store.GitHubProjectApp, error) {
	if err := RequireProjectConnectionAdmin(f, in.OwnershipVersion); err != nil {
		return store.GitHubProjectApp{}, err
	}
	a, err := dao.App(ctx, in.AppResourceID, in.GrantID, f.Project.Ownership.TeamID)
	failed, _ := store.DatabaseErrorFacts(err)
	if !failed && errors.Is(err, model.ErrNotFound) {
		return a, &model.Fault{Code: "github_grant_changed", Message: "Selected App authorization is no longer available.", Cause: err}
	}
	if err != nil {
		return a, err
	}
	if a.Version != in.AppVersion {
		return a, &model.Fault{Code: "version_conflict", Message: "App version changed."}
	}
	return a, nil
}

func ProjectAppStatusFrom(ctx context.Context, dao store.GitHubProjectAppReadDAO, f store.GitHubProjectAppFacts) (ProjectAppStatus, error) {
	out := ProjectAppStatus{Status: Status{Connection: f.Connection, ServiceAvailable: true}, CanManageConnection: f.Access.TeamRole != nil && *f.Access.TeamRole == model.ProjectAdmin}
	if out.CanManageConnection {
		out.GrantID = f.GrantID
	}
	if f.AppResourceID == nil {
		if f.GrantID != nil || f.CredentialVersion != nil || f.Connection.Enabled {
			return out, fmt.Errorf("project App connection identity is incomplete")
		}
		return out, nil
	}
	if f.GrantID == nil || f.CredentialVersion == nil {
		return out, fmt.Errorf("project App connection identity is incomplete")
	}
	a, err := dao.App(ctx, *f.AppResourceID, *f.GrantID, f.Project.Ownership.TeamID)
	if err != nil {
		return out, fmt.Errorf("read connected App: %w", err)
	}
	if f.Connection.AppID == nil || *f.Connection.AppID != a.GitHubAppID || f.Connection.InstallationID == nil || f.Connection.RepositoryID == nil {
		return out, fmt.Errorf("project App connection identity is inconsistent")
	}
	out.App = &ProjectAppRef{ID: a.ID, Name: a.Name, GitHubSlug: a.GitHubSlug, GitHubAppID: a.GitHubAppID}
	return out, nil
}

// ManageProjectApp applies a proof inside the dedicated Project/Team/App scope.
// Original authority and versions precede no-op checks.
func ManageProjectApp(ctx context.Context, dao store.GitHubProjectAppWriteDAO, p model.Principal, action string, in ProjectAppConnect, minutes int32, enabled bool, expectedRepo string, candidate InstallationCandidate) (ProjectAppStatus, error) {
	f, err := ReadProjectAppFacts(ctx, dao, p)
	if err != nil {
		return ProjectAppStatus{}, err
	}
	c := f.Connection
	switch action {
	case "connect", "disconnect":
		if err = RequireProjectConnectionAdmin(f, in.OwnershipVersion); err != nil {
			return ProjectAppStatus{}, err
		}
	case "settings", "sync":
		if f.Access.Role != model.ProjectAdmin {
			return ProjectAppStatus{}, &model.Fault{Code: "forbidden", Message: "Project administrator permission is required."}
		}
	default:
		return ProjectAppStatus{}, invalid("Invalid GitHub management operation.")
	}
	if in.Version < 1 {
		return ProjectAppStatus{}, invalid("Version must be positive.")
	}
	if c.Version != in.Version {
		return ProjectAppStatus{}, &model.Fault{Code: "version_conflict", Message: "GitHub configuration version changed."}
	}
	w := store.GitHubProjectAppWrite{Configuration: configuration(c), AppResourceID: f.AppResourceID, GrantID: f.GrantID, CredentialVersion: f.CredentialVersion}
	changed, changedBinding, err := projectAppTransition(ctx, dao, f, action, in, minutes, enabled, expectedRepo, candidate, &w)
	if err != nil {
		return ProjectAppStatus{}, err
	}
	if !changed {
		return ProjectAppStatusFrom(ctx, dao, f)
	}
	if c.Version == math.MaxInt64 || c.Revision == math.MaxInt64 || (action != "settings" && c.Generation == math.MaxInt64) {
		return ProjectAppStatus{}, &model.Fault{Code: "version_exhausted", Message: "GitHub configuration version exhausted."}
	}
	w.Configuration.Version++
	w.Configuration.Revision++
	if action != "settings" {
		w.Configuration.Generation++
	}
	w.ClearWork = action == "disconnect" || action == "connect" && changedBinding
	ok, err := dao.Save(ctx, w)
	if err != nil {
		return ProjectAppStatus{}, err
	}
	if !ok {
		return ProjectAppStatus{}, &model.Fault{Code: "version_conflict", Message: "GitHub configuration version changed."}
	}
	if changedBinding {
		if f.AppResourceID != nil {
			if err = dao.AdvanceImpact(ctx, *f.AppResourceID); err != nil {
				return ProjectAppStatus{}, err
			}
		}
		if w.AppResourceID != nil && (f.AppResourceID == nil || *f.AppResourceID != *w.AppResourceID) {
			if err = dao.AdvanceImpact(ctx, *w.AppResourceID); err != nil {
				return ProjectAppStatus{}, err
			}
		}
	}
	f, err = dao.Facts(ctx, p)
	if err != nil {
		return ProjectAppStatus{}, err
	}
	return ProjectAppStatusFrom(ctx, dao, f)
}
