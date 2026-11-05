package service

import (
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"context"
	"errors"
	"testing"

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

type tracedTaskService struct {
	*taskservice.Tasks
	store *store.Store
}

func tracedTasks(t *testing.T, databaseURL string, action taskQueryAction) *tracedTaskService {
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
	db := &store.Store{Pool: pool}
	return &tracedTaskService{Tasks: taskservice.NewTasks(db), store: db}
}

func assertOperational(t *testing.T, err error) {
	t.Helper()
	var fault *model.Fault
	if err == nil || errors.As(err, &fault) {
		t.Fatalf("operational error was masked: %#v", err)
	}
}
