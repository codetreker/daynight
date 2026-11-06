package store

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type WorkerPage struct {
	Items   []model.WorkerSnapshot
	HasMore bool
}
