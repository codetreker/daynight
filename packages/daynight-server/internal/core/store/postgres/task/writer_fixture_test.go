package task_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
)

func writerStore(t *testing.T) *postgres.Store {
	t.Helper()
	return testutil.OpenStore(t, postgres.Open)
}

func writerProject(t *testing.T, database *postgres.Store, number int) model.Project {
	t.Helper()
	return testutil.QueryProject(t, database.Pool, database, number)
}

func writerTask(t *testing.T, database *postgres.Store, projectID string, number int, status model.TaskStatus, dependencies ...string) model.Task {
	t.Helper()
	return testutil.QueryTask(t, database, projectID, number, status, dependencies...)
}

func writerTransaction(t *testing.T, database *postgres.Store, options pgx.TxOptions, operation func(pgx.Tx) error) error {
	t.Helper()
	return writerTransactionContext(t, database, t.Context(), options, operation)
}

func writerTransactionContext(t *testing.T, database *postgres.Store, ctx context.Context, options pgx.TxOptions, operation func(pgx.Tx) error) error {
	t.Helper()
	tx, err := database.Pool.BeginTx(ctx, options)
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tx.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("rollback DAO fixture: %v", err)
		}
	}()
	if err := operation(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func writerRead(t *testing.T, database *postgres.Store, operation func(store.TaskReader) error) error {
	t.Helper()
	return writerTransaction(t, database, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		return operation(task.NewReader(tx))
	})
}

func writerWrite(t *testing.T, database *postgres.Store, projectID string, operation func(store.TaskWriteDAO) error) error {
	t.Helper()
	return writerTransaction(t, database, pgx.TxOptions{IsoLevel: pgx.ReadCommitted}, func(tx pgx.Tx) error {
		return operation(task.NewWriter(tx, projectID))
	})
}

func writerAttachment(t *testing.T, database *postgres.Store, projectID, taskID, path string) (model.Attachment, error) {
	t.Helper()
	var value model.Attachment
	err := writerTransaction(t, database, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		var err error
		value, err = attachment.NewReader(tx).Attachment(t.Context(), projectID, taskID, path)
		return err
	})
	return value, err
}

func writerSearch(t *testing.T, database *postgres.Store, operation func(store.TaskSearchSnapshot) error) error {
	t.Helper()
	return writerTransaction(t, database, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		return operation(task.NewSearchSnapshot(tx))
	})
}
