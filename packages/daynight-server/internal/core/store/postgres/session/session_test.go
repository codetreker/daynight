package session

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

type failedQueryTx struct {
	pgx.Tx
	err error
}

func (tx failedQueryTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, tx.err
}

func TestSessionTaskPropertiesPreservesQueryFailure(t *testing.T) {
	want := errors.New("query failed")
	dao := &DAO{tx: failedQueryTx{err: want}}
	_, err := dao.sessionTaskProperties(context.Background(), "task", store.SessionTask{})
	if !errors.Is(err, want) {
		t.Fatalf("task property query failure lost: %v", err)
	}
}
