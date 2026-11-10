package server

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

type projectHTTPOperations struct {
	t                    *testing.T
	CreateWithAccessCall func(ctx context.Context, p model.Principal, input coreproject.CreateProject) (model.Project, model.ProjectAccess, error)
	GetWithAccessCall    func(ctx context.Context, p model.Principal, id string) (model.Project, model.ProjectAccess, error)
	ListScopedCall       func(ctx context.Context, p model.Principal, input coreproject.ProjectListRequest) (coreproject.ProjectPage, error)
	AccessCall           func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error)
	UpdateSettingsCall   func(ctx context.Context, p model.Principal, id string, input coreproject.UpdateProjectSettings) (model.Project, error)
	TransferPreviewCall  func(ctx context.Context, p model.Principal, id, target string) (coreproject.TransferPreview, error)
	TransferCall         func(ctx context.Context, p model.Principal, id string, input coreproject.TransferInput) (coreproject.TransferReceipt, error)
	DeletionPreviewCall  func(ctx context.Context, p model.Principal, id string, page model.PageRequest) (projectservice.DeletionPreview, error)
	DeleteCall           func(ctx context.Context, p model.Principal, id string) (projectservice.DeletionReceipt, error)
}

func (m *projectHTTPOperations) CreateWithAccess(ctx context.Context, p model.Principal, input coreproject.CreateProject) (model.Project, model.ProjectAccess, error) {
	if m.CreateWithAccessCall == nil {
		unexpectedHTTPCall(m.t, "CreateWithAccess")
	}
	return m.CreateWithAccessCall(ctx, p, input)
}

func (m *projectHTTPOperations) GetWithAccess(ctx context.Context, p model.Principal, id string) (model.Project, model.ProjectAccess, error) {
	if m.GetWithAccessCall == nil {
		unexpectedHTTPCall(m.t, "GetWithAccess")
	}
	return m.GetWithAccessCall(ctx, p, id)
}

func (m *projectHTTPOperations) ListScoped(ctx context.Context, p model.Principal, input coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
	if m.ListScopedCall == nil {
		unexpectedHTTPCall(m.t, "ListScoped")
	}
	return m.ListScopedCall(ctx, p, input)
}

func (m *projectHTTPOperations) Access(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	if m.AccessCall == nil {
		unexpectedHTTPCall(m.t, "Access")
	}
	return m.AccessCall(ctx, p, id)
}

func (m *projectHTTPOperations) UpdateSettings(ctx context.Context, p model.Principal, id string, input coreproject.UpdateProjectSettings) (model.Project, error) {
	if m.UpdateSettingsCall == nil {
		unexpectedHTTPCall(m.t, "UpdateSettings")
	}
	return m.UpdateSettingsCall(ctx, p, id, input)
}

func (m *projectHTTPOperations) TransferPreview(ctx context.Context, p model.Principal, id, target string) (coreproject.TransferPreview, error) {
	if m.TransferPreviewCall == nil {
		unexpectedHTTPCall(m.t, "TransferPreview")
	}
	return m.TransferPreviewCall(ctx, p, id, target)
}

func (m *projectHTTPOperations) Transfer(ctx context.Context, p model.Principal, id string, input coreproject.TransferInput) (coreproject.TransferReceipt, error) {
	if m.TransferCall == nil {
		unexpectedHTTPCall(m.t, "Transfer")
	}
	return m.TransferCall(ctx, p, id, input)
}

func (m *projectHTTPOperations) DeletionPreview(ctx context.Context, p model.Principal, id string, page model.PageRequest) (projectservice.DeletionPreview, error) {
	if m.DeletionPreviewCall == nil {
		unexpectedHTTPCall(m.t, "DeletionPreview")
	}
	return m.DeletionPreviewCall(ctx, p, id, page)
}

func (m *projectHTTPOperations) Delete(ctx context.Context, p model.Principal, id string) (projectservice.DeletionReceipt, error) {
	if m.DeleteCall == nil {
		unexpectedHTTPCall(m.t, "Delete")
	}
	return m.DeleteCall(ctx, p, id)
}

type projectHTTPMembershipOperations struct {
	t                     *testing.T
	ListWithAccessCall    func(ctx context.Context, p model.Principal, id string) (coreproject.ProjectParticipants, error)
	SetRoleCall           func(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.SetProjectMemberRole) (model.ProjectGrant, error)
	RemoveCall            func(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.RemoveProjectMember) error
	SetGrantCall          func(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.SetProjectGrant) (coreproject.SetGrantResult, error)
	RemoveGrantCall       func(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.RemoveProjectMember) (coreproject.RemoveGrantResult, error)
	CreateInvitationCall  func(ctx context.Context, p model.Principal, id, expected string) (coreproject.MintedInvitation, error)
	ListInvitationsCall   func(ctx context.Context, p model.Principal, id string) ([]model.ProjectInvitation, error)
	RevokeInvitationCall  func(ctx context.Context, p model.Principal, id, inviteID, expected string) error
	InspectInvitationCall func(ctx context.Context, p model.Principal, secret string) (coreproject.InvitationInspection, error)
	AcceptInvitationCall  func(ctx context.Context, p model.Principal, secret, expected string) (coreproject.InvitationAcceptance, error)
}

func (m *projectHTTPMembershipOperations) ListWithAccess(ctx context.Context, p model.Principal, id string) (coreproject.ProjectParticipants, error) {
	if m.ListWithAccessCall == nil {
		unexpectedHTTPCall(m.t, "ListWithAccess")
	}
	return m.ListWithAccessCall(ctx, p, id)
}

func (m *projectHTTPMembershipOperations) SetRole(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.SetProjectMemberRole) (model.ProjectGrant, error) {
	if m.SetRoleCall == nil {
		unexpectedHTTPCall(m.t, "SetRole")
	}
	return m.SetRoleCall(ctx, p, projectID, userID, input)
}

func (m *projectHTTPMembershipOperations) Remove(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.RemoveProjectMember) error {
	if m.RemoveCall == nil {
		unexpectedHTTPCall(m.t, "Remove")
	}
	return m.RemoveCall(ctx, p, projectID, userID, input)
}

func (m *projectHTTPMembershipOperations) SetGrant(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.SetProjectGrant) (coreproject.SetGrantResult, error) {
	if m.SetGrantCall == nil {
		unexpectedHTTPCall(m.t, "SetGrant")
	}
	return m.SetGrantCall(ctx, p, projectID, userID, input)
}

func (m *projectHTTPMembershipOperations) RemoveGrant(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.RemoveProjectMember) (coreproject.RemoveGrantResult, error) {
	if m.RemoveGrantCall == nil {
		unexpectedHTTPCall(m.t, "RemoveGrant")
	}
	return m.RemoveGrantCall(ctx, p, projectID, userID, input)
}

func (m *projectHTTPMembershipOperations) CreateInvitation(ctx context.Context, p model.Principal, id, expected string) (coreproject.MintedInvitation, error) {
	if m.CreateInvitationCall == nil {
		unexpectedHTTPCall(m.t, "CreateInvitation")
	}
	return m.CreateInvitationCall(ctx, p, id, expected)
}

func (m *projectHTTPMembershipOperations) ListInvitations(ctx context.Context, p model.Principal, id string) ([]model.ProjectInvitation, error) {
	if m.ListInvitationsCall == nil {
		unexpectedHTTPCall(m.t, "ListInvitations")
	}
	return m.ListInvitationsCall(ctx, p, id)
}

func (m *projectHTTPMembershipOperations) RevokeInvitation(ctx context.Context, p model.Principal, id, inviteID, expected string) error {
	if m.RevokeInvitationCall == nil {
		unexpectedHTTPCall(m.t, "RevokeInvitation")
	}
	return m.RevokeInvitationCall(ctx, p, id, inviteID, expected)
}

func (m *projectHTTPMembershipOperations) InspectInvitation(ctx context.Context, p model.Principal, secret string) (coreproject.InvitationInspection, error) {
	if m.InspectInvitationCall == nil {
		unexpectedHTTPCall(m.t, "InspectInvitation")
	}
	return m.InspectInvitationCall(ctx, p, secret)
}

func (m *projectHTTPMembershipOperations) AcceptInvitation(ctx context.Context, p model.Principal, secret, expected string) (coreproject.InvitationAcceptance, error) {
	if m.AcceptInvitationCall == nil {
		unexpectedHTTPCall(m.t, "AcceptInvitation")
	}
	return m.AcceptInvitationCall(ctx, p, secret, expected)
}

func newProjectHTTPOperations(t *testing.T) *projectHTTPOperations {
	t.Helper()
	return &projectHTTPOperations{t: t}
}
