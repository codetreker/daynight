package postgres

import (
	"context"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func threadTestWrite(database *Store, ctx context.Context, operation func(ThreadScope) error) error {
	_, err := database.WriteThread(ctx, operation)
	return err
}
