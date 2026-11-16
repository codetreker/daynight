package github

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

type RemoveAdminInput struct {
	ExpectedUserID    string
	MembershipVersion int64
}
type AdminRemoval struct {
	AppID, UserID         string
	Removed, ActorIsAdmin bool
}
type AdminPage struct {
	Items      []githubpr.AdminProfile
	NextCursor *string
}

func ValidateAdminWrite(p model.Principal, appID, expected string) error {
	if err := team.RequireActor(p, expected); err != nil {
		return err
	}
	return ValidateAppRead(p, appID)
}

func ValidateAdminID(id string) error {
	canonical, err := model.CanonicalID(id)
	if err != nil || canonical != id {
		return invalid("Administrator or invitation ID must be a canonical UUID.")
	}
	return nil
}

func RequireAppAdmin(ctx context.Context, dao store.GitHubAppAdminReader, p model.Principal, appID string) (githubpr.AdminMembership, error) {
	if _, err := dao.App(ctx, appID); err != nil {
		return githubpr.AdminMembership{}, appAdminReadError(err)
	}
	membership, err := dao.Membership(ctx, appID, p.UserID)
	return membership, appAdminReadError(err)
}

func appAdminReadError(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "not_found", Message: "GitHub App was not found.", Cause: err}
	}
	return err
}

func adminListPage(p model.Principal, appID, kind string, in ListAppsInput) (store.Page, query.ListScope, error) {
	if err := ValidateAppRead(p, appID); err != nil {
		return store.Page{}, query.ListScope{}, err
	}
	limit := in.Limit
	if limit == 0 {
		limit = 25
	}
	var cursor *string
	if in.Cursor != "" {
		cursor = &in.Cursor
	}
	scope := query.ListScope{Kind: kind, UserID: p.UserID, ProjectID: appID}
	page, err := query.ListPage(model.PageRequest{Limit: limit, Cursor: cursor}, scope)
	return page, scope, err
}

func ListAdmins(ctx context.Context, dao store.GitHubAppAdminReader, p model.Principal, appID string, in ListAppsInput) (AdminPage, error) {
	page, scope, err := adminListPage(p, appID, "github_app_admins", in)
	if err != nil {
		return AdminPage{}, err
	}
	if _, err = RequireAppAdmin(ctx, dao, p, appID); err != nil {
		return AdminPage{}, err
	}
	result, err := dao.AdminPage(ctx, appID, page)
	if err != nil {
		return AdminPage{}, err
	}
	out := AdminPage{Items: result.Items}
	if out.Items == nil {
		out.Items = []githubpr.AdminProfile{}
	}
	if result.HasMore && len(result.Items) > 0 {
		last := result.Items[len(result.Items)-1]
		cursor, err := query.EncodeListCursor(scope, last.CreatedAt, last.UserID)
		if err != nil {
			return AdminPage{}, err
		}
		out.NextCursor = &cursor
	}
	return out, nil
}

func RemoveAdmin(ctx context.Context, dao store.GitHubAppAdminWriter, p model.Principal, appID, userID string, version int64) (AdminRemoval, error) {
	if _, err := RequireAppAdmin(ctx, dao, p, appID); err != nil {
		return AdminRemoval{}, err
	}
	member, err := dao.Membership(ctx, appID, userID)
	if err != nil {
		return AdminRemoval{}, appAdminReadError(err)
	}
	if member.Version != version {
		return AdminRemoval{}, &model.Fault{Code: "version_conflict", Message: "Administrator membership version does not match."}
	}
	count, err := dao.CountAdmins(ctx, appID)
	if err != nil {
		return AdminRemoval{}, err
	}
	if count <= 1 {
		return AdminRemoval{}, &model.Fault{Code: "last_admin", Message: "At least one App administrator must remain."}
	}
	if err := dao.RemoveAdmin(ctx, appID, userID, version); err != nil {
		return AdminRemoval{}, err
	}
	return AdminRemoval{AppID: appID, UserID: userID, Removed: true, ActorIsAdmin: p.UserID != userID}, nil
}
