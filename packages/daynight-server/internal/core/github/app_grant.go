package github

import (
	"context"
	"errors"
	"fmt"
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
func grantFacts(ctx context.Context, dao store.GitHubGrantWriteDAO, p model.Principal, version int64, scoped bool) (store.GitHubGrantFacts, error) {
	var f store.GitHubGrantFacts
	var err error
	if scoped {
		reader, ok := dao.(store.GitHubGrantWriteAdmissionDAO)
		if !ok {
			return f, fmt.Errorf("GitHub grant transaction cannot check admission facts")
		}
		facts, e := reader.GrantWriteAdmission(ctx, p.UserID)
		if e != nil {
			return f, e
		}
		f = store.GitHubGrantFacts{Team: store.GitHubGrantTeam{TeamRef: model.TeamRef{ID: facts.TeamID}, Version: facts.TeamVersion}, AppVersion: facts.AppVersion, ImpactVersion: facts.ImpactVersion, IsAdmin: facts.IsAdmin}
	} else {
		f, err = dao.Facts(ctx, p.UserID)
		if err != nil {
			return f, err
		}
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
	return CreateGrantWithAdmission(ctx, dao, p, in, nil)
}

func CreateGrantWithAdmission(ctx context.Context, dao store.GitHubGrantWriteDAO, p model.Principal, in CreateGrantInput, admit func() error) (store.GitHubTeamGrant, error) {
	if err := team.RequireActor(p, in.ExpectedUserID); err != nil {
		return store.GitHubTeamGrant{}, err
	}
	f, err := grantFacts(ctx, dao, p, in.Version, admit != nil)
	if err != nil {
		return store.GitHubTeamGrant{}, err
	}
	if f.Team.ID != in.TeamID || f.Team.Version != in.TeamVersion {
		return store.GitHubTeamGrant{}, &model.Fault{Code: "version_conflict", Message: "Team version changed."}
	}
	if f.ImpactVersion == math.MaxInt64 {
		return store.GitHubTeamGrant{}, &model.Fault{Code: "version_exhausted", Message: "App impact version is exhausted."}
	}
	if admit != nil {
		if err := admit(); err != nil {
			return store.GitHubTeamGrant{}, err
		}
		// Preserve validation of the full Team projection after authorization.
		if _, err := dao.Facts(ctx, p.UserID); err != nil {
			return store.GitHubTeamGrant{}, err
		}
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
	return RevokeGrantWithAdmission(ctx, dao, p, id, in, nil)
}

func RevokeGrantWithAdmission(ctx context.Context, dao store.GitHubGrantWriteDAO, p model.Principal, id string, in RevokeGrantInput, admit func() error) error {
	if err := team.RequireActor(p, in.ExpectedUserID); err != nil {
		return err
	}
	f, err := grantFacts(ctx, dao, p, in.Version, admit != nil)
	if err != nil {
		return err
	}
	if f.ImpactVersion != in.ImpactVersion {
		return &model.Fault{Code: "impact_changed", Message: "App impact changed."}
	}
	if f.ImpactVersion == math.MaxInt64 {
		return &model.Fault{Code: "version_exhausted", Message: "App impact version is exhausted."}
	}
	if admit != nil {
		reader := dao.(store.GitHubGrantWriteAdmissionDAO) // grantFacts already established this capability.
		err = reader.RequireLiveGrant(ctx, id)
	} else {
		_, err = dao.Grant(ctx, id)
	}
	if err != nil {
		if errors.Is(err, model.ErrNotFound) {
			return &model.Fault{Code: "github_grant_changed", Message: "Grant changed.", Cause: err}
		}
		return err
	}
	if admit != nil {
		if err := admit(); err != nil {
			return err
		}
		// Keep the full existing Team and grant validation after admission.
		if _, err := dao.Facts(ctx, p.UserID); err != nil {
			return err
		}
		if _, err := dao.Grant(ctx, id); err != nil {
			return err
		}
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
func grantReadAdmission(ctx context.Context, dao store.GitHubGrantReadDAO, admit func() error, appID, actor, teamID, grantID string, teamOnly bool) error {
	if admit == nil {
		return nil
	}
	visibility, ok := dao.(store.GitHubGrantVisibilityDAO)
	if !ok {
		return fmt.Errorf("GitHub grant snapshot cannot check visibility")
	}
	if err := visibility.GrantVisibility(ctx, appID, actor, teamID, grantID, teamOnly); err != nil {
		return grantReadError(err)
	}
	return admit()
}

func PreviewGrant(ctx context.Context, dao store.GitHubGrantReadDAO, p model.Principal, appID, teamID string) (store.GitHubGrantPreview, error) {
	return PreviewGrantWithAdmission(ctx, dao, p, appID, teamID, nil)
}

func PreviewGrantWithAdmission(ctx context.Context, dao store.GitHubGrantReadDAO, p model.Principal, appID, teamID string, admit func() error) (store.GitHubGrantPreview, error) {
	if err := ValidateAppRead(p, appID); err != nil {
		return store.GitHubGrantPreview{}, err
	}
	if err := grantID(teamID); err != nil {
		return store.GitHubGrantPreview{}, err
	}
	if err := grantReadAdmission(ctx, dao, admit, appID, p.UserID, teamID, "", false); err != nil {
		return store.GitHubGrantPreview{}, err
	}
	result, err := dao.Preview(ctx, appID, p.UserID, teamID)
	if err != nil {
		return store.GitHubGrantPreview{}, grantReadError(err)
	}
	return result, nil
}
func GetGrant(ctx context.Context, dao store.GitHubGrantReadDAO, p model.Principal, appID, id string) (store.GitHubTeamGrant, error) {
	return GetGrantWithAdmission(ctx, dao, p, appID, id, nil)
}

func GetGrantWithAdmission(ctx context.Context, dao store.GitHubGrantReadDAO, p model.Principal, appID, id string, admit func() error) (store.GitHubTeamGrant, error) {
	if err := ValidateAppRead(p, appID); err != nil {
		return store.GitHubTeamGrant{}, err
	}
	if err := grantID(id); err != nil {
		return store.GitHubTeamGrant{}, err
	}
	if err := grantReadAdmission(ctx, dao, admit, appID, p.UserID, "", id, false); err != nil {
		return store.GitHubTeamGrant{}, err
	}
	result, err := dao.Grant(ctx, appID, p.UserID, id)
	if err != nil {
		return store.GitHubTeamGrant{}, grantReadError(err)
	}
	return result, nil
}
func ListGrants(ctx context.Context, dao store.GitHubGrantReadDAO, p model.Principal, appID string, request model.PageRequest) (GrantPage, error) {
	return ListGrantsWithAdmission(ctx, dao, p, appID, request, nil)
}

func ListGrantsWithAdmission(ctx context.Context, dao store.GitHubGrantReadDAO, p model.Principal, appID string, request model.PageRequest, admit func() error) (GrantPage, error) {
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
	if err := grantReadAdmission(ctx, dao, admit, appID, p.UserID, "", "", false); err != nil {
		return GrantPage{}, err
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
	return ListTeamAppsWithAdmission(ctx, dao, p, teamID, request, nil)
}

func ListTeamAppsWithAdmission(ctx context.Context, dao store.GitHubGrantReadDAO, p model.Principal, teamID string, request model.PageRequest, admit func() error) (TeamAppPage, error) {
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
	if err := grantReadAdmission(ctx, dao, admit, "", p.UserID, teamID, "", true); err != nil {
		return TeamAppPage{}, err
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
