package task_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/jackc/pgx/v5"
)

type taskStoreSequence struct {
	name   string
	last   int64
	called bool
}

type taskStoreSuite struct {
	database  *postgres.Store
	truncate  string
	sequences []taskStoreSequence
	used      bool
}

func newTaskStoreSuite(t *testing.T) *taskStoreSuite {
	t.Helper()
	suite := &taskStoreSuite{database: readerStore(t)}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	rows, err := suite.database.Pool.Query(ctx, `SELECT schemaname,tablename FROM pg_tables
 WHERE schemaname=current_schema() AND tablename<>ALL($1::text[]) ORDER BY tablename`, []string{
		"schema_migrations", "oauth_authorization_cleanup_cursor", "oauth_credential_cleanup_cursor",
		"private_transfer_ledger", "webhook_policies",
	})
	if err != nil {
		t.Fatal(err)
	}
	var tables []string
	for rows.Next() {
		var schema, name string
		if err := rows.Scan(&schema, &name); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		tables = append(tables, pgx.Identifier{schema, name}.Sanitize())
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(tables) == 0 {
		t.Fatal("shared Task fixture has no mutable tables")
	}
	suite.truncate = "TRUNCATE " + strings.Join(tables, ",") + " RESTART IDENTITY"
	rows, err = suite.database.Pool.Query(ctx, `SELECT namespace.nspname,sequence.relname
 FROM pg_class sequence JOIN pg_namespace namespace ON namespace.oid=sequence.relnamespace
 WHERE namespace.nspname=current_schema() AND sequence.relkind='S' ORDER BY sequence.relname`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var schema, name string
		if err := rows.Scan(&schema, &name); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		suite.sequences = append(suite.sequences, taskStoreSequence{name: pgx.Identifier{schema, name}.Sanitize()})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for index := range suite.sequences {
		sequence := &suite.sequences[index]
		if err := suite.database.Pool.QueryRow(ctx, "SELECT last_value,is_called FROM "+sequence.name).
			Scan(&sequence.last, &sequence.called); err != nil {
			t.Fatal(err)
		}
	}
	return suite
}

func (suite *taskStoreSuite) run(t *testing.T, name string, test func(*testing.T, *postgres.Store)) {
	t.Helper()
	if !t.Run(name, func(t *testing.T) {
		if suite.used {
			suite.reset(t)
		}
		suite.used = true
		t.Cleanup(func() {
			if acquired := suite.database.Pool.Stat().AcquiredConns(); acquired != 0 {
				t.Errorf("shared Task fixture retained %d acquired connections", acquired)
			}
		})
		test(t, suite.database)
	}) {
		// A failed case may not have restored all of its external resources.
		t.FailNow()
	}
}

func (suite *taskStoreSuite) reset(t *testing.T) {
	t.Helper()
	if acquired := suite.database.Pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("cannot reset shared Task fixture with %d acquired connections", acquired)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	tx, err := suite.database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tx.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("rollback shared Task fixture reset: %v", err)
		}
	}()
	if _, err := tx.Exec(ctx, suite.truncate); err != nil {
		t.Fatal(err)
	}
	// Unowned sequences and nextval changes are not restored by table truncation.
	for _, sequence := range suite.sequences {
		if _, err := tx.Exec(ctx, "SELECT setval($1::regclass,$2,$3)", sequence.name, sequence.last, sequence.called); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}
