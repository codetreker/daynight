package worker

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const refusalWorkerID = "a3333333-3333-4333-8333-333333333333"

func workerRefusalPrincipal() model.Principal {
	return model.Principal{Kind: model.SessionCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
}

type forbiddenWorkerStore struct{ t *testing.T }

func (s forbiddenWorkerStore) ReadSnapshot(context.Context, func(store.SnapshotScope) error) error {
	s.t.Helper()
	s.t.Fatal("unexpected Worker snapshot after refusal")
	return nil
}

func (s forbiddenWorkerStore) WriteWorker(context.Context, func(store.WorkerScope) error) (store.Completion, error) {
	s.t.Helper()
	s.t.Fatal("unexpected Worker write after refusal")
	return store.Completion{}, nil
}

func closedWorkerTestStore(t *testing.T) (*postgres.Store, error) {
	t.Helper()
	config, err := pgxpool.ParseConfig("postgres://unused@127.0.0.1:1/unused?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	config.MinConns, config.MinIdleConns = 0, 0
	config.BeforeConnect = func(context.Context, *pgx.ConnConfig) error {
		t.Error("closed Worker fixture attempted to open a connection")
		return errors.New("closed Worker fixture does not connect")
	}
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	database := &postgres.Store{Pool: pool}
	database.Close()
	connection, cause := pool.Acquire(t.Context())
	if cause == nil {
		connection.Release()
		t.Fatal("acquired a connection from a closed pool")
	}
	return database, cause
}
