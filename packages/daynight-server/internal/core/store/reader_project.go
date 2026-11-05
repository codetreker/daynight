package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type ProjectReader interface {
	Project(context.Context, string) (model.Project, error)
	Projects(context.Context, Page) (ProjectPage, error)
	DirectProjectMember(context.Context, string, string) (model.ProjectMember, error)
	ProjectParticipants(context.Context, string) ([]model.ProjectParticipant, error)
	Invitation(context.Context, []byte) (model.ProjectInvitation, error)
	Invitations(context.Context, string, time.Time) ([]model.ProjectInvitation, error)
	ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error)
	AccessibleProjects(context.Context, model.Principal, Page) (ProjectPage, error)
	ScopedProjects(context.Context, model.Principal, ProjectScope, Page) (ProjectPage, error)
	TransferTeam(context.Context, string) (TransferTeam, error)
	TransferRole(context.Context, string, string, string) (*model.ProjectRole, error)
}
