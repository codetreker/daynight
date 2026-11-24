package github

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ProjectAppAccess obtains only visibility and version facts prior to admission.
func ProjectAppAccess(ctx context.Context, dao store.GitHubProjectAppReadDAO, p model.Principal) (store.GitHubProjectAppAccess, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return store.GitHubProjectAppAccess{}, err
	}
	reader, ok := dao.(store.GitHubProjectAppAdmissionReader)
	if !ok {
		return store.GitHubProjectAppAccess{}, fmt.Errorf("project App admission capability unavailable")
	}
	f, err := reader.ProjectAppAccess(ctx, p)
	failed, _ := store.DatabaseErrorFacts(err)
	if !failed && errors.Is(err, model.ErrNotFound) {
		return f, &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: err}
	}
	return f, err
}

func RequireSelectedProjectApp(ctx context.Context, dao store.GitHubProjectAppReadDAO, f store.GitHubProjectAppAccess, in ProjectAppSelection) error {
	if f.Access.TeamRole == nil || *f.Access.TeamRole != model.ProjectAdmin {
		return &model.Fault{Code: "forbidden", Message: "Owner Team administrator permission is required."}
	}
	if f.OwnershipVersion != in.OwnershipVersion {
		return &model.Fault{Code: "version_conflict", Message: "Project ownership changed."}
	}
	reader, ok := dao.(store.GitHubProjectAppAdmissionReader)
	if !ok {
		return fmt.Errorf("project App admission capability unavailable")
	}
	version, err := reader.ProjectAppVersion(ctx, in.AppResourceID, in.GrantID, f.TeamID)
	failed, _ := store.DatabaseErrorFacts(err)
	if !failed && errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "github_grant_changed", Message: "Selected App authorization is no longer available.", Cause: err}
	}
	if err != nil {
		return err
	}
	if version != in.AppVersion {
		return &model.Fault{Code: "version_conflict", Message: "App version changed."}
	}
	return nil
}
