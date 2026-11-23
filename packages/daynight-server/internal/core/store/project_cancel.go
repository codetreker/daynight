package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// TaskCascadeCancelDAO plans the visible tree under the Project lock and locks
// the target and unfinished descendants in UUID order before returning them.
type TaskCascadeCancelDAO interface {
	TaskCascadeCancel(context.Context, string) ([]model.Task, error)
}
