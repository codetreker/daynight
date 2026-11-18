package store

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

type failedQueryTx struct {
	pgx.Tx
	err error
}

func (tx failedQueryTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, tx.err
}

func TestRegistration(t *testing.T) {
	for _, test := range []struct{ path, got string }{
		{"migration_property_rows.go", TransformSource()},
		{"migrations/026_task_property_rows.sql", SQL()},
	} {
		data, err := os.ReadFile(test.path)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != test.got {
			t.Fatalf("registration does not expose %s bytes", test.path)
		}
	}
	want := errors.New("query failed")
	if err := Apply(context.Background(), failedQueryTx{err: want}); !errors.Is(err, want) {
		t.Fatalf("registered transform did not preserve query failure: %v", err)
	}
}
