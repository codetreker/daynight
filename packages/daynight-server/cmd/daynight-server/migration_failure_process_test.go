//go:build startupshutdown

package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestServerProcessMigrationFailuresNeverListenAndRecover(t *testing.T) {
	for _, scenario := range []string{"unknown history", "migration bridge required", "migration SQL failure", "snapshot SQL failure"} {
		t.Run(scenario, func(t *testing.T) {
			values := processAPIEnvironment(t)
			adminURL := values["DAYNIGHT_DATABASE_URL"]
			parsed, err := url.Parse(adminURL)
			if err != nil {
				t.Fatal(err)
			}
			application := "failed_migration_" + strings.ToLower(rand.Text())
			query := parsed.Query()
			query.Set("application_name", application)
			parsed.RawQuery = query.Encode()
			values["DAYNIGHT_DATABASE_URL"] = parsed.String()
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			observer, err := pgx.Connect(ctx, adminURL)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
				defer done()
				if err := observer.Close(cleanup); err != nil {
					t.Error(err)
				}
			}()
			var unknownVersion int64
			var priorLedger string
			wantDiagnostic := "database migrate failed"
			switch scenario {
			case "unknown history":
				initial := startPersistenceProcess(t, values)
				if err := initial.stop(); err != nil {
					t.Fatalf("initial process stop: %v", err)
				}
				// The unknown version follows the applied ledger so that adding
				// migrations never turns it into a known version.
				if err := observer.QueryRow(ctx, `INSERT INTO schema_migrations(version,checksum)
					SELECT max(version)+1,repeat('0',64) FROM schema_migrations RETURNING version`).Scan(&unknownVersion); err != nil {
					t.Fatal(err)
				}
				wantDiagnostic = fmt.Sprintf("database migrate (migration version %d is not an ordered prefix) failed", unknownVersion)
			case "migration bridge required":
				if _, err := observer.Exec(ctx, "CREATE TABLE private_migration_marker (id bigint)"); err != nil {
					t.Fatal(err)
				}
				wantDiagnostic = "database migrate (migration ledger is missing or empty; verify the database's history before using the version-99 migration bridge) failed"
			case "migration SQL failure":
				pool, err := pgxpool.New(ctx, adminURL)
				if err != nil {
					t.Fatal(err)
				}
				defer pool.Close()
				if err := postgres.ReplayHistoricalSchemaForTest(ctx, pool, 99); err != nil {
					t.Fatal(err)
				}
				if err := observer.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m`).Scan(&priorLedger); err != nil {
					t.Fatal(err)
				}
				if _, err := observer.Exec(ctx, "CREATE TABLE assistant_task_item_closures (private_migration_marker boolean)"); err != nil {
					t.Fatal(err)
				}
			case "snapshot SQL failure":
				query.Set("default_transaction_read_only", "on")
				parsed.RawQuery = query.Encode()
				values["DAYNIGHT_DATABASE_URL"] = parsed.String()
			}
			process := startMigrationProcess(t, values)
			ticker := time.NewTicker(20 * time.Millisecond)
			defer ticker.Stop()
			waiting := true
			for waiting {
				select {
				case err := <-process.finished:
					process.stopped = true
					var exit *exec.ExitError
					if !errors.As(err, &exit) || exit.ExitCode() != 1 {
						t.Fatalf("migration failure exited unexpectedly: %v", err)
					}
					waiting = false
				case <-ctx.Done():
					t.Fatal("migration failure did not terminate")
				case <-ticker.C:
					connection, err := net.DialTimeout("tcp", values["DAYNIGHT_LISTEN_ADDR"], 100*time.Millisecond)
					if err == nil {
						connection.Close()
						t.Fatal("server accepted a connection despite migration failure")
					}
				}
			}
			output := process.logs.String()
			for _, private := range []string{values["DAYNIGHT_DATABASE_URL"], values["DAYNIGHT_UNIAUTH_APP_SECRET"], "private_migration_marker"} {
				if private != "" && strings.Contains(output, private) {
					t.Fatal("migration startup diagnostic exposed private configuration or SQL")
				}
			}
			startup, listening := false, false
			scanner := bufio.NewScanner(strings.NewReader(output))
			for scanner.Scan() {
				var entry struct{ Phase, Diagnostic string }
				if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
					t.Fatalf("invalid startup diagnostic JSON: %v", err)
				}
				startup = startup || entry.Phase == "startup" && entry.Diagnostic == wantDiagnostic
				listening = listening || entry.Phase == "listening"
			}
			if err := scanner.Err(); err != nil || !startup || listening {
				t.Fatalf("migration failure diagnostic/startup phase: startup=%t listening=%t error=%v", startup, listening, err)
			}
			// PostgreSQL removes a backend from pg_stat_activity only after the
			// backend observes its client's disconnect, so an exited process may
			// still be listed briefly.
			var connections int
			connectionsCleared := func() error {
				wait, done := context.WithTimeout(ctx, 5*time.Second)
				defer done()
				return grantWait(wait, func() (bool, error) {
					err := observer.QueryRow(wait, "SELECT count(*) FROM pg_stat_activity WHERE application_name=$1", application).Scan(&connections)
					return err == nil && connections == 0, err
				})
			}
			if err := connectionsCleared(); err != nil {
				t.Fatalf("failed process retained database connections: %d %v", connections, err)
			}
			listener, err := net.Listen("tcp", values["DAYNIGHT_LISTEN_ADDR"])
			if err != nil {
				t.Fatalf("failed process retained listener: %v", err)
			}
			if err := listener.Close(); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "unknown history":
				_, err = observer.Exec(ctx, "DELETE FROM schema_migrations WHERE version=$1", unknownVersion)
			case "migration bridge required":
				var objects int
				var original, noLedger bool
				if err := observer.QueryRow(ctx, `SELECT count(*),
					to_regclass('private_migration_marker') IS NOT NULL, to_regclass('schema_migrations') IS NULL
					FROM pg_depend
					WHERE refclassid='pg_namespace'::regclass AND refobjid=current_schema()::regnamespace`).Scan(&objects, &original, &noLedger); err != nil || objects != 1 || !original || !noLedger {
					t.Fatalf("bridge refusal changed the namespace: objects=%d original=%t no ledger=%t err=%v", objects, original, noLedger, err)
				}
				_, err = observer.Exec(ctx, "DROP TABLE private_migration_marker")
			case "migration SQL failure":
				var latest int64
				var prefixIntact, botRecovery, openedAt bool
				if err := observer.QueryRow(ctx, `SELECT max(version),
					(jsonb_agg(to_jsonb(m) ORDER BY version) FILTER (WHERE version <= 99))::text = $1,
					to_regclass('bot_recovery') IS NOT NULL,
					EXISTS (SELECT FROM information_schema.columns WHERE table_schema=current_schema()
						AND table_name='assistant_task_items' AND column_name='opened_at')
					FROM schema_migrations m`, priorLedger).Scan(&latest, &prefixIntact, &botRecovery, &openedAt); err != nil || latest != 100 || !prefixIntact || !botRecovery || openedAt {
					t.Fatalf("failed migration did not preserve the committed prefix: latest=%d prefix=%t bot recovery=%t opened_at=%t err=%v", latest, prefixIntact, botRecovery, openedAt, err)
				}
				_, err = observer.Exec(ctx, "DROP TABLE assistant_task_item_closures")
			case "snapshot SQL failure":
				var objects int
				if err := observer.QueryRow(ctx, `SELECT count(*) FROM pg_depend
					WHERE refclassid='pg_namespace'::regclass AND refobjid=current_schema()::regnamespace`).Scan(&objects); err != nil || objects != 0 {
					t.Fatalf("failed snapshot retained %d objects: %v", objects, err)
				}
				query.Del("default_transaction_read_only")
				parsed.RawQuery = query.Encode()
				values["DAYNIGHT_DATABASE_URL"] = parsed.String()
			}
			if err != nil {
				t.Fatal(err)
			}
			recovered := startPersistenceProcess(t, values)
			if scenario == "migration SQL failure" {
				var applied bool
				if err := observer.QueryRow(ctx, `SELECT EXISTS (SELECT FROM schema_migrations WHERE version=101)
					AND EXISTS (SELECT FROM information_schema.columns WHERE table_schema=current_schema()
						AND table_name='assistant_task_items' AND column_name='opened_at')`).Scan(&applied); err != nil || !applied {
					t.Fatalf("recovered process did not complete migration 101: applied=%t err=%v", applied, err)
				}
			}
			if err := recovered.stop(); err != nil {
				t.Fatalf("recovered service did not stop cleanly: %v", err)
			}
			if err := connectionsCleared(); err != nil {
				t.Fatalf("recovered process retained database connections: %d %v", connections, err)
			}
		})
	}
}
