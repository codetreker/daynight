package webhook

import (
	"context"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestCaptureRejectsUntrackedOrNonReadCommittedSource(t *testing.T) {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	for _, tc := range []struct {
		name     string
		level    pgx.TxIsoLevel
		allocate bool
	}{
		{"no xid", pgx.ReadCommitted, false},
		{"repeatable read", pgx.RepeatableRead, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx, err := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: tc.level})
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if tc.allocate {
				if _, err = tx.Exec(ctx, `SELECT pg_current_xact_id()`); err != nil {
					t.Fatal(err)
				}
			}
			_, err = New(tx).FreezeAudience(ctx, uuid.NewString(), []string{"task.created"})
			if err == nil || !strings.Contains(err.Error(), "requires a written read-committed source transaction") {
				t.Fatalf("capture guard: %v", err)
			}
		})
	}
}
