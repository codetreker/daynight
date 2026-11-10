package project

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// FindRepository scans all visible Projects in the caller's snapshot until
// uniqueness is established or a second match proves ambiguity.
func FindRepository(ctx context.Context, dao store.ProjectReader, principal model.Principal, match *RepositoryMatch) (model.Project, bool, error) {
	request := ProjectListRequest{Page: model.PageRequest{Limit: 100}}
	for {
		if err := ctx.Err(); err != nil {
			return model.Project{}, false, err
		}
		page, err := ReadList(ctx, dao, principal, request)
		if err != nil {
			return model.Project{}, false, err
		}
		if err := ctx.Err(); err != nil {
			return model.Project{}, false, err
		}
		for _, candidate := range page.Items {
			if err := ctx.Err(); err != nil {
				return model.Project{}, false, err
			}
			if err := match.Add(candidate); err != nil {
				return model.Project{}, false, err
			}
		}
		if !page.HasMore {
			if err := ctx.Err(); err != nil {
				return model.Project{}, false, err
			}
			project, found := match.Result()
			return project, found, nil
		}
		finished, err := FinishList(principal, request, page)
		if err != nil {
			return model.Project{}, false, err
		}
		request.Page.Cursor = finished.NextCursor
	}
}
