package webhook

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
)

type webhookDAOSequence struct {
	name   string
	last   int64
	called bool
}

type webhookDAOSeed struct {
	name string
	rows string
}

type webhookDAOSuite struct {
	conn        *pgx.Conn
	application string
	truncate    string
	sequences   []webhookDAOSequence
	seeds       []webhookDAOSeed
	used        bool
}

func newWebhookDAOSuite(t *testing.T) *webhookDAOSuite {
	t.Helper()
	url := testutil.ScopedDatabaseURL(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := conn.Close(ctx); err != nil {
			t.Errorf("close shared Webhook connection: %v", err)
		}
	})
	snapshot, err := os.ReadFile("../schema/current.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, string(snapshot)); err != nil {
		t.Fatal(err)
	}
	suite := &webhookDAOSuite{conn: conn}
	var schema string
	if err := conn.QueryRow(ctx, "SELECT current_schema(),current_setting('application_name')").Scan(&schema, &suite.application); err != nil {
		t.Fatal(err)
	}
	if suite.application == "" {
		t.Fatal("shared Webhook fixture has no application identity")
	}
	seedNames := []string{
		"schema_migrations", "oauth_authorization_cleanup_cursor", "oauth_credential_cleanup_cursor",
		"private_transfer_ledger", "webhook_policies",
	}
	for _, name := range seedNames {
		qualified := pgx.Identifier{schema, name}.Sanitize()
		suite.seeds = append(suite.seeds, webhookDAOSeed{name: qualified, rows: suite.seedRows(t, ctx, qualified)})
	}
	suite.captureTables(t, ctx, seedNames)
	suite.captureSequences(t, ctx)
	return suite
}

func (suite *webhookDAOSuite) captureTables(t *testing.T, ctx context.Context, seeds []string) {
	t.Helper()
	rows, err := suite.conn.Query(ctx, `SELECT schemaname,tablename FROM pg_tables
 WHERE schemaname=current_schema() AND tablename<>ALL($1::text[]) ORDER BY tablename`, seeds)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var schema, name string
		if err := rows.Scan(&schema, &name); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, pgx.Identifier{schema, name}.Sanitize())
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(tables) == 0 {
		t.Fatal("shared Webhook fixture has no mutable tables")
	}
	suite.truncate = "TRUNCATE " + strings.Join(tables, ",") + " RESTART IDENTITY"
}

func (suite *webhookDAOSuite) captureSequences(t *testing.T, ctx context.Context) {
	t.Helper()
	rows, err := suite.conn.Query(ctx, `SELECT namespace.nspname,sequence.relname
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
		suite.sequences = append(suite.sequences, webhookDAOSequence{name: pgx.Identifier{schema, name}.Sanitize()})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for index := range suite.sequences {
		sequence := &suite.sequences[index]
		if err := suite.conn.QueryRow(ctx, "SELECT last_value,is_called FROM "+sequence.name).
			Scan(&sequence.last, &sequence.called); err != nil {
			t.Fatal(err)
		}
	}
}

func (suite *webhookDAOSuite) run(t *testing.T, name string, test func(*testing.T, *pgx.Conn)) {
	t.Helper()
	if !t.Run(name, func(t *testing.T) {
		t.Cleanup(func() {
			suite.assertReusable(t)
			suite.assertSeeds(t)
		})
		if suite.used {
			suite.reset(t)
		}
		suite.used = true
		test(t, suite.conn)
	}) {
		// A failed case may have retained resources or changed the catalog.
		t.FailNow()
	}
}

func (suite *webhookDAOSuite) assertReusable(t *testing.T) {
	t.Helper()
	if suite.conn.IsClosed() {
		t.Fatal("shared Webhook connection is closed")
	}
	if suite.conn.PgConn().IsBusy() {
		t.Fatal("shared Webhook connection has an unfinished query")
	}
	if status := suite.conn.PgConn().TxStatus(); status != 'I' {
		t.Fatalf("shared Webhook connection retained transaction status %q", status)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		var count int
		var backends string
		if err := suite.conn.QueryRow(ctx, `SELECT count(*),coalesce(jsonb_agg(jsonb_build_object(
 'pid',pid,'state',state,'xactStart',xact_start,'waitType',wait_event_type,'wait',wait_event)),'[]'::jsonb)::text
 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND pid<>pg_backend_pid()`, suite.application).
			Scan(&count, &backends); err != nil {
			t.Fatal(err)
		}
		if count == 0 {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("shared Webhook fixture retained auxiliary backends: %s: %v", backends, ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func (suite *webhookDAOSuite) seedRows(t *testing.T, ctx context.Context, name string) string {
	t.Helper()
	var rows string
	if err := suite.conn.QueryRow(ctx, "SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text),'[]'::jsonb)::text FROM "+name+" AS row").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

func (suite *webhookDAOSuite) assertSeeds(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, seed := range suite.seeds {
		if rows := suite.seedRows(t, ctx, seed.name); rows != seed.rows {
			t.Fatalf("shared Webhook seed %s changed: got %s, want %s", seed.name, rows, seed.rows)
		}
	}
}

func (suite *webhookDAOSuite) reset(t *testing.T) {
	t.Helper()
	suite.assertReusable(t)
	suite.assertSeeds(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	tx, err := suite.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("rollback shared Webhook reset: %v", err)
		}
	}()
	if _, err := tx.Exec(ctx, suite.truncate); err != nil {
		t.Fatal(err)
	}
	// Standalone sequences and nextval changes are not restored by TRUNCATE.
	for _, sequence := range suite.sequences {
		if _, err := tx.Exec(ctx, "SELECT setval($1::regclass,$2,$3)", sequence.name, sequence.last, sequence.called); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for _, sequence := range suite.sequences {
		var last int64
		var called bool
		if err := suite.conn.QueryRow(ctx, "SELECT last_value,is_called FROM "+sequence.name).Scan(&last, &called); err != nil {
			t.Fatal(err)
		}
		if last != sequence.last || called != sequence.called {
			t.Fatalf("shared Webhook sequence %s was not restored: got %d/%v, want %d/%v", sequence.name, last, called, sequence.last, sequence.called)
		}
	}
}
