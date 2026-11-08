package project

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ListAdmitted retains the filter scope and snapshot while measuring each bounded
// candidate with the real response projection, including its cursor.
func (s *Projects) ListAdmitted(ctx context.Context, p model.Principal, request core.ProjectListRequest, measure func([]model.Project, *string) error) (core.ProjectPage, error) {
	if err := core.ValidateList(p, request); err != nil {
		return core.ProjectPage{}, err
	}
	result := core.ProjectPage{Items: []model.Project{}}
	one := request
	one.Page.Limit = 1
	err := read(ctx, s.store, func(dao store.ProjectReader) error {
		for len(result.Items) < request.Page.Limit {
			records, err := core.ReadListBounded(ctx, dao, p, one, core.MaxPageResponseJSONBytes)
			if err != nil {
				var fault *model.Fault
				if errors.As(err, &fault) && fault.Code == "payload_too_large" {
					if len(result.Items) > 0 {
						result.NextCursor = one.Page.Cursor
						return nil
					}
					return &model.Fault{Code: "resource_limit_exceeded", Message: "Project exceeds the encoded page limit.", Cause: err}
				}
				return err
			}
			page, err := core.FinishList(p, one, records)
			if err != nil {
				return err
			}
			if len(page.Items) == 0 {
				return nil
			}
			result.Items = append(result.Items, page.Items[0])
			if err := measure(result.Items, page.NextCursor); err != nil {
				var violation *limit.Violation
				if !errors.As(err, &violation) {
					return err
				}
				result.Items = result.Items[:len(result.Items)-1]
				if len(result.Items) == 0 {
					return &model.Fault{Code: "resource_limit_exceeded", Message: "Project exceeds the encoded page limit.", Cause: err}
				}
				result.NextCursor = one.Page.Cursor
				return nil
			}
			if page.NextCursor == nil {
				return nil
			}
			one.Page.Cursor = page.NextCursor
		}
		result.NextCursor = one.Page.Cursor
		return nil
	})
	if err != nil {
		return core.ProjectPage{}, err
	}
	return result, nil
}
