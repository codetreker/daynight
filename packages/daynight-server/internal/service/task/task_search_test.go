package task

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestNewTaskSearchUsesConfiguredStore(t *testing.T) {
	if NewTaskSearch(nil) == nil {
		t.Fatal("nil store must still construct the service")
	}
	pool, err := pgxpool.New(context.Background(), "postgres://127.0.0.1:1/daynight?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	reader := NewTaskSearch(&store.Store{Pool: pool})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	invoked := false
	err = reader.ReadTaskSearch(ctx, func(store.TaskSearchSnapshot) error { invoked = true; return nil })
	if !errors.Is(err, context.Canceled) || invoked {
		t.Fatalf("canceled read invoked callback=%v, error=%v", invoked, err)
	}
}
