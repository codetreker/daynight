package store

import "context"

func threadTestWrite(database *Store, ctx context.Context, operation func(ThreadScope) error) error {
	_, err := database.WriteThread(ctx, operation)
	return err
}
