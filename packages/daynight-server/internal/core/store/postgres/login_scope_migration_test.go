package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestLoginScopeMigrationProtectsLiveTransactions(t *testing.T) {
	for _, resolution := range []string{"consume", "expire"} {
		t.Run(resolution, func(t *testing.T) {
			ctx := context.Background()
			pool := emptyPool(t)
			if err := migrate(ctx, pool, schemaMigrations[:46]); err != nil {
				t.Fatal(err)
			}
			_, err := pool.Exec(ctx, `INSERT INTO login_transactions(id,state_hash,browser_binding_hash,provider,return_path,expires_at)
 VALUES ('00000000-0000-4000-8000-000000000001',decode(repeat('01',32),'hex'),decode(repeat('02',32),'hex'),'github','/',clock_timestamp()+interval '10 minutes'),
 ('00000000-0000-4000-8000-000000000002',decode(repeat('03',32),'hex'),decode(repeat('04',32),'hex'),'github','/',clock_timestamp()-interval '1 minute')`)
			if err != nil {
				t.Fatal(err)
			}
			err = migrate(ctx, pool, schemaMigrations)
			var cause *pgconn.PgError
			if !errors.As(err, &cause) || cause.Code != "P1047" {
				t.Fatalf("expected active login migration failure: %v", err)
			}
			_, err = Open(ctx, pool.Config().ConnString())
			if err == nil || !strings.Contains(err.Error(), "active login transactions to be consumed or expired") {
				t.Fatalf("startup did not explain migration failure: %v", err)
			}
			var rows, columns, versions int
			if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM login_transactions),
 (SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='login_transactions' AND column_name='scope_hash'),
 (SELECT count(*) FROM schema_migrations WHERE version=47)`).Scan(&rows, &columns, &versions); err != nil || rows != 2 || columns != 0 || versions != 0 {
				t.Fatalf("failed migration changed data or schema: rows=%d columns=%d ledger=%d err=%v", rows, columns, versions, err)
			}
			if resolution == "consume" {
				_, err = pool.Exec(ctx, `DELETE FROM login_transactions WHERE id='00000000-0000-4000-8000-000000000001' AND state_hash=decode(repeat('01',32),'hex') AND browser_binding_hash=decode(repeat('02',32),'hex')`)
			} else {
				_, err = pool.Exec(ctx, `UPDATE login_transactions SET expires_at=clock_timestamp()-interval '1 second' WHERE id='00000000-0000-4000-8000-000000000001'`)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := migrate(ctx, pool, schemaMigrations); err != nil {
				t.Fatal(err)
			}
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM login_transactions`).Scan(&rows); err != nil || rows != 0 {
				t.Fatalf("expired transactions remain: %d %v", rows, err)
			}
			_, err = pool.Exec(ctx, `INSERT INTO login_transactions(id,state_hash,browser_binding_hash,provider,return_path,expires_at) VALUES ('00000000-0000-4000-8000-000000000003',decode(repeat('05',32),'hex'),decode(repeat('06',32),'hex'),'github','/',clock_timestamp()+interval '1 minute')`)
			if err == nil {
				t.Fatal("scope hash accepted as NULL")
			}
		})
	}
}
