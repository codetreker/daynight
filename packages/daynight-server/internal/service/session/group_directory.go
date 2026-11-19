package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type GroupDirectory struct{ database store.HistoryDirectoryReader }

func NewGroupDirectory(database store.HistoryDirectoryReader) *GroupDirectory {
	return &GroupDirectory{database: database}
}

func (s *GroupDirectory) Read(ctx context.Context, p model.Principal, project string, q core.HistoryDirectoryRequest) (core.HistoryDirectoryPage, error) {
	var out core.HistoryDirectoryPage
	if err := model.RequirePrincipal(p); err != nil {
		return out, err
	}
	if err := core.ValidateHistoryDirectoryRequest(project, q); err != nil {
		return out, err
	}
	err := s.database.ReadHistoryDirectory(ctx, func(scope store.HistoryDirectoryScope) error {
		if err := core.AuthorizeTaskObservation(ctx, scope.CredentialDAO(), p); err != nil {
			return err
		}
		if _, err := projectcore.RequireProjectRead(ctx, scope.ProjectDAO(), p, project); err != nil {
			return err
		}
		var err error
		out, err = core.ReadHistoryDirectory(ctx, scope, project, p.UserID, q)
		return err
	})
	if err != nil {
		return core.HistoryDirectoryPage{}, err
	}
	return out, nil
}
