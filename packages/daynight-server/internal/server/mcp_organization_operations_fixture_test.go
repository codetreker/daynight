package server

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	"testing"
)

type mcpOrgProjects struct {
	*operationRejectedProjects
	t                      *testing.T
	ListScopedCall         func(context.Context, model.Principal, projectcore.ProjectListRequest) (projectcore.ProjectPage, error)
	TransferPreviewCall    func(context.Context, model.Principal, string, string) (projectcore.TransferPreview, error)
	TransferCall           func(context.Context, model.Principal, string, projectcore.TransferInput) (projectcore.TransferReceipt, error)
	RegisterRepositoryCall func(context.Context, model.Principal, projectcore.CreateProject, bool) (model.Project, bool, error)
	GetCall                func(context.Context, model.Principal, string) (model.Project, error)
}

var _ application.ProjectOperations = (*mcpOrgProjects)(nil)

func (o *mcpOrgProjects) ListScoped(a0 context.Context, a1 model.Principal, a2 projectcore.ProjectListRequest) (projectcore.ProjectPage, error) {
	if o.ListScopedCall == nil {
		unexpectedHTTPCall(o.t, "MCP ProjectOperations.ListScoped")
	}
	return o.ListScopedCall(a0, a1, a2)
}

func (o *mcpOrgProjects) TransferPreview(a0 context.Context, a1 model.Principal, a2 string, a3 string) (projectcore.TransferPreview, error) {
	if o.TransferPreviewCall == nil {
		unexpectedHTTPCall(o.t, "MCP ProjectOperations.TransferPreview")
	}
	return o.TransferPreviewCall(a0, a1, a2, a3)
}

func (o *mcpOrgProjects) Transfer(a0 context.Context, a1 model.Principal, a2 string, a3 projectcore.TransferInput) (projectcore.TransferReceipt, error) {
	if o.TransferCall == nil {
		unexpectedHTTPCall(o.t, "MCP ProjectOperations.Transfer")
	}
	return o.TransferCall(a0, a1, a2, a3)
}

func (o *mcpOrgProjects) RegisterRepository(a0 context.Context, a1 model.Principal, a2 projectcore.CreateProject, a3 bool) (model.Project, bool, error) {
	if o.RegisterRepositoryCall == nil {
		unexpectedHTTPCall(o.t, "MCP ProjectOperations.RegisterRepository")
	}
	return o.RegisterRepositoryCall(a0, a1, a2, a3)
}

func (o *mcpOrgProjects) Get(a0 context.Context, a1 model.Principal, a2 string) (model.Project, error) {
	if o.GetCall == nil {
		unexpectedHTTPCall(o.t, "MCP ProjectOperations.Get")
	}
	return o.GetCall(a0, a1, a2)
}

type mcpOrgMemberships struct {
	*operationRejectedMemberships
	t                     *testing.T
	InspectInvitationCall func(context.Context, model.Principal, string) (projectcore.InvitationInspection, error)
	AcceptInvitationCall  func(context.Context, model.Principal, string, string) (projectcore.InvitationAcceptance, error)
}

var _ application.MembershipOperations = (*mcpOrgMemberships)(nil)

func (o *mcpOrgMemberships) InspectInvitation(a0 context.Context, a1 model.Principal, a2 string) (projectcore.InvitationInspection, error) {
	if o.InspectInvitationCall == nil {
		unexpectedHTTPCall(o.t, "MCP MembershipOperations.InspectInvitation")
	}
	return o.InspectInvitationCall(a0, a1, a2)
}

func (o *mcpOrgMemberships) AcceptInvitation(a0 context.Context, a1 model.Principal, a2 string, a3 string) (projectcore.InvitationAcceptance, error) {
	if o.AcceptInvitationCall == nil {
		unexpectedHTTPCall(o.t, "MCP MembershipOperations.AcceptInvitation")
	}
	return o.AcceptInvitationCall(a0, a1, a2, a3)
}

type mcpOrgTeams struct {
	*operationRejectedTeams
	t                      *testing.T
	CreateCall             func(context.Context, model.Principal, teamcore.CreateTeam) (model.Team, error)
	GetCall                func(context.Context, model.Principal, string) (model.Team, error)
	RenameCall             func(context.Context, model.Principal, string, teamcore.ChangeTeam) (model.Team, error)
	DeleteCall             func(context.Context, model.Principal, string, teamcore.ChangeTeam) error
	MembersPageCall        func(context.Context, model.Principal, string, model.PageRequest) (teamcore.MemberPage, error)
	MemberCall             func(context.Context, model.Principal, string, string) (model.TeamMember, error)
	SetMemberRoleCall      func(context.Context, model.Principal, string, string, teamcore.ChangeTeamMember) (teamcore.TeamMemberResult, error)
	RemoveMemberCall       func(context.Context, model.Principal, string, string, teamcore.ChangeTeamMember) (teamcore.TeamMemberResult, error)
	CreateInvitationCall   func(context.Context, model.Principal, string, string) (teamcore.MintedTeamInvitation, error)
	ListInvitationPageCall func(context.Context, model.Principal, string, model.PageRequest) (teamcore.InvitationPage, error)
	RevokeInvitationCall   func(context.Context, model.Principal, string, string, string) (bool, error)
	InspectInvitationCall  func(context.Context, model.Principal, string) (teamcore.TeamInvitationInspection, error)
	AcceptInvitationCall   func(context.Context, model.Principal, string, string) (teamcore.TeamInvitationAcceptance, error)
}

var _ application.TeamOperations = (*mcpOrgTeams)(nil)

func (o *mcpOrgTeams) Create(a0 context.Context, a1 model.Principal, a2 teamcore.CreateTeam) (model.Team, error) {
	if o.CreateCall == nil {
		unexpectedHTTPCall(o.t, "MCP TeamOperations.Create")
	}
	return o.CreateCall(a0, a1, a2)
}

func (o *mcpOrgTeams) Get(a0 context.Context, a1 model.Principal, a2 string) (model.Team, error) {
	if o.GetCall == nil {
		unexpectedHTTPCall(o.t, "MCP TeamOperations.Get")
	}
	return o.GetCall(a0, a1, a2)
}

func (o *mcpOrgTeams) Rename(a0 context.Context, a1 model.Principal, a2 string, a3 teamcore.ChangeTeam) (model.Team, error) {
	if o.RenameCall == nil {
		unexpectedHTTPCall(o.t, "MCP TeamOperations.Rename")
	}
	return o.RenameCall(a0, a1, a2, a3)
}

func (o *mcpOrgTeams) Delete(a0 context.Context, a1 model.Principal, a2 string, a3 teamcore.ChangeTeam) error {
	if o.DeleteCall == nil {
		unexpectedHTTPCall(o.t, "MCP TeamOperations.Delete")
	}
	return o.DeleteCall(a0, a1, a2, a3)
}

func (o *mcpOrgTeams) MembersPage(a0 context.Context, a1 model.Principal, a2 string, a3 model.PageRequest) (teamcore.MemberPage, error) {
	if o.MembersPageCall == nil {
		unexpectedHTTPCall(o.t, "MCP TeamOperations.MembersPage")
	}
	return o.MembersPageCall(a0, a1, a2, a3)
}

func (o *mcpOrgTeams) Member(a0 context.Context, a1 model.Principal, a2 string, a3 string) (model.TeamMember, error) {
	if o.MemberCall == nil {
		unexpectedHTTPCall(o.t, "MCP TeamOperations.Member")
	}
	return o.MemberCall(a0, a1, a2, a3)
}

func (o *mcpOrgTeams) SetMemberRole(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 teamcore.ChangeTeamMember) (teamcore.TeamMemberResult, error) {
	if o.SetMemberRoleCall == nil {
		unexpectedHTTPCall(o.t, "MCP TeamOperations.SetMemberRole")
	}
	return o.SetMemberRoleCall(a0, a1, a2, a3, a4)
}

func (o *mcpOrgTeams) RemoveMember(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 teamcore.ChangeTeamMember) (teamcore.TeamMemberResult, error) {
	if o.RemoveMemberCall == nil {
		unexpectedHTTPCall(o.t, "MCP TeamOperations.RemoveMember")
	}
	return o.RemoveMemberCall(a0, a1, a2, a3, a4)
}

func (o *mcpOrgTeams) CreateInvitation(a0 context.Context, a1 model.Principal, a2 string, a3 string) (teamcore.MintedTeamInvitation, error) {
	if o.CreateInvitationCall == nil {
		unexpectedHTTPCall(o.t, "MCP TeamOperations.CreateInvitation")
	}
	return o.CreateInvitationCall(a0, a1, a2, a3)
}

func (o *mcpOrgTeams) ListInvitationPage(a0 context.Context, a1 model.Principal, a2 string, a3 model.PageRequest) (teamcore.InvitationPage, error) {
	if o.ListInvitationPageCall == nil {
		unexpectedHTTPCall(o.t, "MCP TeamOperations.ListInvitationPage")
	}
	return o.ListInvitationPageCall(a0, a1, a2, a3)
}

func (o *mcpOrgTeams) RevokeInvitation(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (bool, error) {
	if o.RevokeInvitationCall == nil {
		unexpectedHTTPCall(o.t, "MCP TeamOperations.RevokeInvitation")
	}
	return o.RevokeInvitationCall(a0, a1, a2, a3, a4)
}

func (o *mcpOrgTeams) InspectInvitation(a0 context.Context, a1 model.Principal, a2 string) (teamcore.TeamInvitationInspection, error) {
	if o.InspectInvitationCall == nil {
		unexpectedHTTPCall(o.t, "MCP TeamOperations.InspectInvitation")
	}
	return o.InspectInvitationCall(a0, a1, a2)
}

func (o *mcpOrgTeams) AcceptInvitation(a0 context.Context, a1 model.Principal, a2 string, a3 string) (teamcore.TeamInvitationAcceptance, error) {
	if o.AcceptInvitationCall == nil {
		unexpectedHTTPCall(o.t, "MCP TeamOperations.AcceptInvitation")
	}
	return o.AcceptInvitationCall(a0, a1, a2, a3)
}
