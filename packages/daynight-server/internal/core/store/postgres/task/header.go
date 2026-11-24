package task

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

func (s *Reader) TaskHeader(ctx context.Context, projectID, taskID string) (model.TaskHeader, error) {
	return pg.ReadTaskHeader(ctx, s.tx, projectID, taskID, "")
}
