package github

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

const adminInvitationPrefix = "dn_gai_"
const adminInvitationLifetime = 7 * 24 * time.Hour

type MintedAdminInvitation struct {
	Invitation githubpr.AppInvitation
	Secret     string
}
type AdminInvitationPage struct {
	Items      []githubpr.AppInvitation
	NextCursor *string
}
type AdminInvitationRevocation struct {
	AppID, InvitationID string
	Changed             bool
}
type AdminInvitationInspection struct {
	App        githubpr.AppIdentity
	ExpiresAt  time.Time
	Membership *githubpr.AdminMembership
}
type AdminInvitationAcceptance struct {
	AppID      string
	Membership githubpr.AdminMembership
	Joined     bool
}

func ValidateAdminInvitation(p model.Principal, token string) error {
	if err := model.RequirePrincipal(p); err != nil {
		return err
	}
	if !secretutil.Valid(token, adminInvitationPrefix) {
		return model.InvitationUnavailable(nil)
	}
	return nil
}

func adminInvitationAvailable(i githubpr.AppInvitation, issuer *int64, now time.Time) bool {
	return i.RevokedAt == nil && i.ConsumedAt == nil && i.ExpiresAt.After(now) && issuer != nil && *issuer == i.IssuerMembershipVersion
}

func CreateAdminInvitation(ctx context.Context, dao store.GitHubAppAdminWriter, p model.Principal, appID string) (MintedAdminInvitation, error) {
	member, err := RequireAppAdmin(ctx, dao, p, appID)
	if err != nil {
		return MintedAdminInvitation{}, err
	}
	now, err := dao.ObservedAt(ctx)
	if err != nil {
		return MintedAdminInvitation{}, err
	}
	secret := secretutil.Random(adminInvitationPrefix)
	i := githubpr.AppInvitation{ID: uuid.NewString(), AppID: appID, CreatedBy: p.UserID, IssuerMembershipVersion: member.Version, CreatedAt: now, ExpiresAt: now.Add(adminInvitationLifetime), Available: true}
	if err := dao.CreateInvitation(ctx, i, secretutil.Hash(secret)); err != nil {
		return MintedAdminInvitation{}, err
	}
	return MintedAdminInvitation{Invitation: i, Secret: secret}, nil
}

func ListAdminInvitations(ctx context.Context, dao store.GitHubAppAdminReader, p model.Principal, appID string, in ListAppsInput) (AdminInvitationPage, error) {
	page, scope, err := adminListPage(p, appID, "github_app_admin_invitations", in)
	if err != nil {
		return AdminInvitationPage{}, err
	}
	if _, err = RequireAppAdmin(ctx, dao, p, appID); err != nil {
		return AdminInvitationPage{}, err
	}
	now, err := dao.ObservedAt(ctx)
	if err != nil {
		return AdminInvitationPage{}, err
	}
	result, err := dao.InvitationPage(ctx, appID, page)
	if err != nil {
		return AdminInvitationPage{}, err
	}
	out := AdminInvitationPage{Items: make([]githubpr.AppInvitation, 0, len(result.Items))}
	for _, row := range result.Items {
		i := row.Invitation
		i.Available = adminInvitationAvailable(i, row.CurrentIssuerMembershipVersion, now)
		out.Items = append(out.Items, i)
	}
	if result.HasMore && len(out.Items) > 0 {
		last := out.Items[len(out.Items)-1]
		cursor, err := query.EncodeListCursor(scope, last.CreatedAt, last.ID)
		if err != nil {
			return AdminInvitationPage{}, err
		}
		out.NextCursor = &cursor
	}
	return out, nil
}

func RevokeAdminInvitation(ctx context.Context, dao store.GitHubAppAdminWriter, p model.Principal, appID, invitationID string) (AdminInvitationRevocation, error) {
	if _, err := RequireAppAdmin(ctx, dao, p, appID); err != nil {
		return AdminInvitationRevocation{}, err
	}
	i, err := dao.Invitation(ctx, appID, invitationID)
	if err != nil {
		return AdminInvitationRevocation{}, appAdminReadError(err)
	}
	out := AdminInvitationRevocation{AppID: appID, InvitationID: invitationID}
	if i.RevokedAt != nil || i.ConsumedAt != nil {
		return out, nil
	}
	now, err := dao.ObservedAt(ctx)
	if err != nil {
		return AdminInvitationRevocation{}, err
	}
	if err := dao.RevokeInvitation(ctx, appID, invitationID, now); err != nil {
		return AdminInvitationRevocation{}, err
	}
	out.Changed = true
	return out, nil
}

func availableAdminInvitation(ctx context.Context, dao store.GitHubAppAdminReader, token string) (githubpr.AppInvitation, githubpr.AppIdentity, error) {
	i, err := dao.InvitationByHash(ctx, secretutil.Hash(token))
	if err != nil {
		return githubpr.AppInvitation{}, githubpr.AppIdentity{}, invitationReadError(err)
	}
	app, err := dao.App(ctx, i.AppID)
	if err != nil {
		return githubpr.AppInvitation{}, githubpr.AppIdentity{}, invitationReadError(err)
	}
	issuer, err := dao.Membership(ctx, i.AppID, i.CreatedBy)
	if err != nil {
		return githubpr.AppInvitation{}, githubpr.AppIdentity{}, invitationReadError(err)
	}
	now, err := dao.ObservedAt(ctx)
	if err != nil {
		return githubpr.AppInvitation{}, githubpr.AppIdentity{}, err
	}
	if !adminInvitationAvailable(i, &issuer.Version, now) {
		return githubpr.AppInvitation{}, githubpr.AppIdentity{}, model.InvitationUnavailable(nil)
	}
	return i, app, nil
}

func invitationReadError(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return model.InvitationUnavailable(err)
	}
	return err
}

func InspectAdminInvitation(ctx context.Context, dao store.GitHubAppAdminReader, p model.Principal, token string) (AdminInvitationInspection, error) {
	i, app, err := availableAdminInvitation(ctx, dao, token)
	if err != nil {
		return AdminInvitationInspection{}, err
	}
	out := AdminInvitationInspection{App: app, ExpiresAt: i.ExpiresAt}
	member, err := dao.Membership(ctx, i.AppID, p.UserID)
	if errors.Is(err, model.ErrNotFound) {
		return out, nil
	}
	if err != nil {
		return AdminInvitationInspection{}, err
	}
	out.Membership = &member
	return out, nil
}

func AcceptAdminInvitation(ctx context.Context, dao store.GitHubAppAdminWriter, p model.Principal, token string) (AdminInvitationAcceptance, error) {
	i, _, err := availableAdminInvitation(ctx, dao, token)
	if err != nil {
		return AdminInvitationAcceptance{}, err
	}
	member, err := dao.Membership(ctx, i.AppID, p.UserID)
	if err == nil {
		return AdminInvitationAcceptance{AppID: i.AppID, Membership: member}, nil
	}
	if !errors.Is(err, model.ErrNotFound) {
		return AdminInvitationAcceptance{}, err
	}
	member, err = dao.AddAdmin(ctx, i.AppID, p.UserID)
	if err != nil {
		return AdminInvitationAcceptance{}, err
	}
	now, err := dao.ObservedAt(ctx)
	if err != nil {
		return AdminInvitationAcceptance{}, err
	}
	if err := dao.ConsumeInvitation(ctx, i.AppID, i.ID, p.UserID, now); err != nil {
		return AdminInvitationAcceptance{}, err
	}
	return AdminInvitationAcceptance{AppID: i.AppID, Membership: member, Joined: true}, nil
}
