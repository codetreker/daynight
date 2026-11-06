package task

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

// NewTaskSearch assembles the search snapshot adapter for the task API.
func NewTaskSearch(database *store.Store) store.TaskSearchReader {
	if database == nil {
		return postgres.NewTaskSearch(nil)
	}
	return postgres.NewTaskSearch(database.Pool)
}
