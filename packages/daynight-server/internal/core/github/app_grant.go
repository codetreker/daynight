package github

import (
	"context"
	"errors"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

type CreateGrantInput struct {
	ID, TeamID, ExpectedUserID string
	Version, TeamVersion       int64
}
type RevokeGrantInput struct {
	ExpectedUserID         string
	Version, ImpactVersion int64
}
type GrantPage struct {
	Items      []store.GitHubTeamGrant
	NextCursor *string
}
type TeamAppPage struct {
	Items      []store.GitHubTeamApp
	NextCursor *string
}

func grantID(id string) error {
	canonical, err := model.CanonicalID(id)
	if err != nil || canonical != id {
		return invalid("ID must be a canonical UUID.")
	}
	return nil
}
func ValidateCreateGrant(p model.Principal, appID string, in CreateGrantInput) error {
	if err := team.RequireActor(p, in.ExpectedUserID); err != nil {
		return err
	}
	if err := grantID(appID); err != nil {
		return err
	}
	if err := grantID(in.TeamID); err != nil {
		return err
	}
	if err := grantID(in.ID); err != nil {
		return err
	}
	if in.Version < 1 || in.TeamVersion < 1 {
		return invalid("Versions must be positive.")
	}
	return nil
}
func ValidateRevokeGrant(p model.Principal, appID, id string, in RevokeGrantInput) error {
	if err := team.RequireActor(p, in.ExpectedUserID); err != nil {
		return err
	}
	if err := grantID(appID); err != nil {
		return err
	}
	if err := grantID(id); err != nil {
		return err
	}
	if in.Version < 1 || in.ImpactVersion < 1 {
		return invalid("Versions must be positive.")
	}
	return nil
}
func grantFacts(ctx context.Context, dao store.GitHubGrantWriteDAO, p model.Principal, version int64) (store.GitHubGrantFacts, error) {
	f, err := dao.Facts(ctx, p.UserID)
	if err != nil {
		return f, err
	}
	if !f.IsAdmin {
		return f, &model.Fault{Code: "not_found", Message: "App was not found."}
	}
	if f.AppVersion != version {
		return f, &model.Fault{Code: "version_conflict", Message: "App version changed."}
	}
	return f, nil
}
func CreateGrant(ctx context.Context, dao store.GitHubGrantWriteDAO, p model.Principal, in CreateGrantInput) (store.GitHubTeamGrant, error) {
	if err := team.RequireActor(p, in.ExpectedUserID); err != nil {
		return store.GitHubTeamGrant{}, err
	}
	f, err := grantFacts(ctx, dao, p, in.Version)
	if err != nil {
		return store.GitHubTeamGrant{}, err
	}
	if f.Team.ID != in.TeamID || f.Team.Version != in.TeamVersion {
		return store.GitHubTeamGrant{}, &model.Fault{Code: "version_conflict", Message: "Team version changed."}
	}
	if f.ImpactVersion == math.MaxInt64 {
		return store.GitHubTeamGrant{}, &model.Fault{Code: "version_exhausted", Message: "App impact version is exhausted."}
	}
	existing, err := dao.LiveGrant(ctx)
	if err != nil {
		return store.GitHubTeamGrant{}, err
	}
	if existing != nil {
		return store.GitHubTeamGrant{}, &model.Fault{Code: "github_grant_changed", Message: "Team already has a grant."}
	}
	g, err := dao.Insert(ctx, in.ID)
	if errors.Is(err, store.ErrGitHubGrantIDConflict) || errors.Is(err, store.ErrGitHubGrantExists) {
		return store.GitHubTeamGrant{}, &model.Fault{Code: "github_grant_changed", Message: "Grant identity or relationship is already in use.", Cause: err}
	}
	if err != nil {
		return g, err
	}
	if err = dao.AdvanceImpact(ctx); err != nil {
		return store.GitHubTeamGrant{}, err
	}
	return g, nil
}
func RevokeGrant(ctx context.Context, dao store.GitHubGrantWriteDAO, p model.Principal, id string, in RevokeGrantInput) error {
	if err := team.RequireActor(p, in.ExpectedUserID); err != nil {
		return err
	}
	f, err := grantFacts(ctx, dao, p, in.Version)
	if err != nil {
		return err
	}
	if f.ImpactVersion != in.ImpactVersion {
		return &model.Fault{Code: "impact_changed", Message: "App impact changed."}
	}
	if f.ImpactVersion == math.MaxInt64 {
		return &model.Fault{Code: "version_exhausted", Message: "App impact version is exhausted."}
	}
	if _, err = dao.Grant(ctx, id); err != nil {
		if errors.Is(err, model.ErrNotFound) {
			return &model.Fault{Code: "github_grant_changed", Message: "Grant changed.", Cause: err}
		}
		return err
	}
	if err = dao.StopGrantConnections(ctx, id, DisconnectionDecision()); err != nil {
		return err
	}
	if err = dao.Revoke(ctx, id); err != nil {
		return err
	}
	return dao.AdvanceImpact(ctx)
}

// DisconnectionDecision is shared by operations that permanently stop a binding.
func DisconnectionDecision() store.GitHubStopDecision {
	return store.GitHubStopDecision{Enabled: false, SyncEnabled: false, AccessState: "unknown"}
}

func grantReadError(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "not_found", Message: "Resource was not found.", Cause: err}
	}
	return err
}
func PreviewGrant(ctx context.Context, dao store.GitHubGrantReadDAO, p model.Principal, appID, teamID string) (store.GitHubGrantPreview, error) {
	if err := ValidateAppRead(p, appID); err != nil {
		return store.GitHubGrantPreview{}, err
	}
	if err := grantID(teamID); err != nil {
		return store.GitHubGrantPreview{}, err
	}
	result, err := dao.Preview(ctx, appID, p.UserID, teamID)
	return result, grantReadError(err)
}
func GetGrant(ctx context.Context, dao store.GitHubGrantReadDAO, p model.Principal, appID, id string) (store.GitHubTeamGrant, error) {
	if err := ValidateAppRead(p, appID); err != nil {
		return store.GitHubTeamGrant{}, err
	}
	if err := grantID(id); err != nil {
		return store.GitHubTeamGrant{}, err
	}
	result, err := dao.Grant(ctx, appID, p.UserID, id)
	return result, grantReadError(err)
}
func ListGrants(ctx context.Context, dao store.GitHubGrantReadDAO, p model.Principal, appID string, request model.PageRequest) (GrantPage, error) {
	if err := ValidateAppRead(p, appID); err != nil {
		return GrantPage{}, grantReadError(err)
	}
	if request.Limit == 0 {
		request.Limit = 25
	}
	scope := query.ListScope{Kind: "github_grants", UserID: p.UserID, ProjectID: appID}
	page, err := query.ListPage(request, scope)
	if err != nil {
		return GrantPage{}, err
	}
	var after *string
	if page.After != nil {
		after = &page.After.ID
	}
	result, err := dao.Grants(ctx, appID, p.UserID, after, page.Limit)
	if err != nil {
		return GrantPage{}, grantReadError(err)
	}
	out := GrantPage{Items: result.Items}
	if out.Items == nil {
		out.Items = []store.GitHubTeamGrant{}
	}
	if result.HasMore && len(out.Items) > 0 {
		last := out.Items[len(out.Items)-1]
		cursor, err := query.EncodeListCursor(scope, last.CreatedAt, last.ID)
		if err != nil {
			return GrantPage{}, err
		}
		out.NextCursor = &cursor
	}
	return out, nil
}
func ListTeamApps(ctx context.Context, dao store.GitHubGrantReadDAO, p model.Principal, teamID string, request model.PageRequest) (TeamAppPage, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return TeamAppPage{}, grantReadError(err)
	}
	if err := grantID(teamID); err != nil {
		return TeamAppPage{}, err
	}
	if request.Limit == 0 {
		request.Limit = 25
	}
	scope := query.ListScope{Kind: "github_team_apps", UserID: p.UserID, TeamID: teamID}
	page, err := query.ListPage(request, scope)
	if err != nil {
		return TeamAppPage{}, err
	}
	var after *string
	if page.After != nil {
		after = &page.After.ID
	}
	result, err := dao.TeamApps(ctx, teamID, p.UserID, after, page.Limit)
	if err != nil {
		return TeamAppPage{}, grantReadError(err)
	}
	out := TeamAppPage{Items: result.Items}
	if out.Items == nil {
		out.Items = []store.GitHubTeamApp{}
	}
	if result.HasMore && len(out.Items) > 0 {
		last := out.Items[len(out.Items)-1]
		cursor, err := query.EncodeListCursor(scope, last.CreatedAt, last.GrantID)
		if err != nil {
			return TeamAppPage{}, err
		}
		out.NextCursor = &cursor
	}
	return out, nil
}
