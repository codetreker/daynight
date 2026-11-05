package project

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type taskQueryAction struct {
	match func(string) bool
	start func()
	end   func()
}

type taskQueryKey struct{}

func (action taskQueryAction) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	matched := action.match(data.SQL)
	if matched && action.start != nil {
		action.start()
	}
	return context.WithValue(ctx, taskQueryKey{}, matched)
}

func (action taskQueryAction) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if ctx.Value(taskQueryKey{}) == true && action.end != nil {
		action.end()
	}
}

func tracedStore(t *testing.T, databaseURL string, action taskQueryAction) *store.Store {
	t.Helper()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Tracer = action
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return &store.Store{Pool: pool}
}

func assertOperational(t *testing.T, err error) {
	t.Helper()
	var fault *model.Fault
	if err == nil || errors.As(err, &fault) {
		t.Fatalf("operational error was masked: %#v", err)
	}
}

type taskResult struct {
	task model.Task
	err  error
}

func waitForTaskWriters(t *testing.T, ctx context.Context, database *store.Store, count int) {
	t.Helper()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting int
		err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE application_name = current_setting('application_name') AND wait_event_type = 'Lock'
			AND query LIKE 'SELECT id::text FROM projects WHERE id = % FOR UPDATE'`).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting >= count {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("%d task writers never reached their own project lock: %v", count, ctx.Err())
		case <-ticker.C:
		}
	}
}

func receiveTaskResult(t *testing.T, ctx context.Context, result <-chan taskResult) taskResult {
	t.Helper()
	select {
	case result := <-result:
		return result
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return taskResult{}
	}
}

func writeProjectForTest(s *store.Store, ctx context.Context, id string, operation func(store.ProjectWriteScope) error) error {
	_, err := s.WriteProject(ctx, id, operation)
	return err
}

func competeTaskWrites(t *testing.T, database *store.Store, projectID string, operations ...func(context.Context) (model.Task, error)) []taskResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result := make(chan taskResult, len(operations))
	if err := writeProjectForTest(database, ctx, projectID, func(store.ProjectWriteScope) error {
		for _, operation := range operations {
			go func() {
				task, err := operation(ctx)
				result <- taskResult{task: task, err: err}
			}()
		}
		waitForTaskWriters(t, ctx, database, len(operations))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	results := make([]taskResult, 0, len(operations))
	for range operations {
		results = append(results, receiveTaskResult(t, ctx, result))
	}
	return results
}

func assertOneTaskWinner(t *testing.T, results []taskResult, code string) {
	t.Helper()
	success, refused := 0, 0
	for _, result := range results {
		if result.err == nil {
			success++
		} else {
			requireFault(t, result.err, code)
			refused++
		}
	}
	if success != 1 || refused != 1 {
		t.Fatalf("expected one winning write and one %s refusal, got %#v", code, results)
	}
}

func workerMember(t *testing.T, database *store.Store, projectID string) model.Principal {
	t.Helper()
	principal := servicePrincipal(t, database)
	if err := writeProjectForTest(database, context.Background(), projectID, func(tx store.ProjectWriteScope) error {
		_, err := tx.ProjectDAO().AddInvitedMember(context.Background(), principal.UserID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return principal
}
