package prompt

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

func NewPostgresReader(database *store.Store) store.PromptSnapshotReader {
	if database == nil {
		return postgres.NewPrompt(nil)
	}
	return postgres.NewPrompt(database.Pool)
}
func NewPostgres(database *store.Store) *Prompts {
	if database == nil {
		return New(postgres.NewPrompt(nil))
	}
	return New(postgres.NewPrompt(database.Pool))
}
