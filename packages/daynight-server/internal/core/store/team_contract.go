package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// TeamWriter scopes creation separately from writes to an existing locked Team.
// The DAO is valid only inside its transaction callback.
type TeamWriter interface {
	CreateTeam(context.Context, string, func(TeamCreationDAO) error) (Completion, error)
	WriteTeam(context.Context, string, func(TeamWriteScope) error) (Completion, error)
}

// TeamWriteScope binds Team and cross-module DAOs to the same locked transaction.
type TeamWriteScope interface {
	TeamDAO() TeamWriteDAO
	EligibilityDAO() WebhookEligibilityDAO
	IdentityDAO() IdentityDAO
	CredentialFamilyDAO() CredentialFamilyDAO
}

type TeamCreationDAO interface {
	InsertTeam(context.Context, string, string) (model.Team, error)
}

type TeamWriteDAO interface {
	Team(context.Context, string) (model.Team, error)
	Rename(context.Context, string, string) (model.Team, error)
	HasProjects(context.Context) (bool, error)
	Delete(context.Context) error
	Member(context.Context, string) (model.TeamMember, error)
	// MemberByExternalID finds only an existing membership in this scoped Team.
	MemberByExternalID(context.Context, string) (model.TeamMember, error)
	AdminCount(context.Context) (int64, error)
	SetMemberRole(context.Context, string, model.ProjectRole) (model.TeamMember, error)
	RemoveMember(context.Context, string) error
	LockInvitation(context.Context, []byte) (model.TeamInvitation, error)
	CreateInvitation(context.Context, model.TeamInvitation) error
	RevokeInvitation(context.Context, string, time.Time) (bool, error)
	ConsumeInvitation(context.Context, string, string, time.Time) error
	InvitationTeam(context.Context) (model.TeamRef, error)
	InvitationMember(context.Context, string) (model.TeamMember, error)
	AddMember(context.Context, string, model.ProjectRole) (model.TeamMember, error)
}
