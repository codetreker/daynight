package project

import (
	"context"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

type ProjectOperations interface {
	CreateWithAccess(ctx context.Context, principal model.Principal, input coreproject.CreateProject) (model.Project, model.ProjectAccess, error)
	GetWithAccess(ctx context.Context, principal model.Principal, id string) (model.Project, model.ProjectAccess, error)
	ListScoped(ctx context.Context, principal model.Principal, input coreproject.ProjectListRequest) (coreproject.ProjectPage, error)
	Access(ctx context.Context, principal model.Principal, id string) (model.ProjectAccess, error)
	UpdateSettings(ctx context.Context, principal model.Principal, id string, input coreproject.UpdateProjectSettings) (model.Project, error)
	TransferPreview(ctx context.Context, principal model.Principal, id, target string) (coreproject.TransferPreview, error)
	Transfer(ctx context.Context, principal model.Principal, id string, input coreproject.TransferInput) (coreproject.TransferReceipt, error)
	DeletionPreview(ctx context.Context, principal model.Principal, id string, page model.PageRequest) (projectservice.DeletionPreview, error)
	Delete(ctx context.Context, principal model.Principal, id string) (projectservice.DeletionReceipt, error)
}

type MembershipOperations interface {
	ListWithAccess(ctx context.Context, principal model.Principal, id string) (coreproject.ProjectParticipants, error)
	SetRole(ctx context.Context, principal model.Principal, projectID, userID string, input coreproject.SetProjectMemberRole) (model.ProjectGrant, error)
	Remove(ctx context.Context, principal model.Principal, projectID, userID string, input coreproject.RemoveProjectMember) error
	SetGrant(ctx context.Context, principal model.Principal, projectID, userID string, input coreproject.SetProjectGrant) (coreproject.SetGrantResult, error)
	RemoveGrant(ctx context.Context, principal model.Principal, projectID, userID string, input coreproject.RemoveProjectMember) (coreproject.RemoveGrantResult, error)
	CreateInvitation(ctx context.Context, principal model.Principal, id, expected string) (coreproject.MintedInvitation, error)
	ListInvitations(ctx context.Context, principal model.Principal, id string) ([]model.ProjectInvitation, error)
	RevokeInvitation(ctx context.Context, principal model.Principal, id, inviteID, expected string) error
	InspectInvitation(ctx context.Context, principal model.Principal, secret string) (coreproject.InvitationInspection, error)
	AcceptInvitation(ctx context.Context, principal model.Principal, secret, expected string) (coreproject.InvitationAcceptance, error)
}

type RouteAuthentication interface {
	Require(httpx.AuthenticatedHandler) http.HandlerFunc
}

type MembershipAuthentication interface {
	RouteAuthentication
	Origin() string
}

var _ ProjectOperations = (*projectservice.Projects)(nil)
var _ MembershipOperations = (*projectservice.Memberships)(nil)
