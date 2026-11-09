package testutil

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

func OpenStore[S interface{ Close() }](t *testing.T, open func(context.Context, string) (S, error)) S {
	t.Helper()
	return OpenStoreAt(t, open, ScopedDatabaseURL(t))
}

func OpenStoreAt[S interface{ Close() }](t *testing.T, open func(context.Context, string) (S, error), databaseURL string) S {
	t.Helper()
	database, err := open(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	return database
}

func Pointer[T any](value T) *T { return &value }

func MustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

func CreateTeam(ctx context.Context, writer store.TeamWriter, userID, teamID, name string) (model.Team, error) {
	var team model.Team
	_, err := writer.CreateTeam(ctx, userID, func(dao store.TeamCreationDAO) error {
		var err error
		team, err = dao.InsertTeam(ctx, teamID, name)
		return err
	})
	return team, err
}

func WriteTeam(ctx context.Context, writer store.TeamWriter, id string, operation func(store.TeamWriteDAO) error) error {
	_, err := writer.WriteTeam(ctx, id, func(scope store.TeamWriteScope) error { return operation(scope.TeamDAO()) })
	return err
}

func ThreadWrite(ctx context.Context, writer store.ThreadWriter, operation func(store.ThreadScope) error) error {
	_, err := writer.WriteThread(ctx, operation)
	return err
}

func ThreadPositionAfter(candidate, head model.ThreadPosition) bool {
	return candidate.CreatedAt.After(head.CreatedAt) ||
		(candidate.CreatedAt.Equal(head.CreatedAt) && strings.Compare(candidate.ID, head.ID) > 0)
}

func WaitThreadClock(ctx context.Context) error {
	timer := time.NewTimer(time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
