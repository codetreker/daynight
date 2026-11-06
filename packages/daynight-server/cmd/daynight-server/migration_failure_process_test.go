package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestServerProcessMigrationFailuresNeverListenAndRecover(t *testing.T) {
	for _, scenario := range []string{"unknown history", "migration SQL failure", "snapshot SQL failure"} {
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
			if scenario == "unknown history" {
				initial := startPersistenceProcess(t, values)
				if err := initial.stop(); err != nil {
					t.Fatalf("initial process stop: %v", err)
				}
				if _, err := observer.Exec(ctx, "INSERT INTO schema_migrations(version,checksum) VALUES (99,repeat('0',64))"); err != nil {
					t.Fatal(err)
				}
			} else if scenario == "migration SQL failure" {
				if _, err := observer.Exec(ctx, "CREATE TABLE tasks (private_migration_marker boolean)"); err != nil {
					t.Fatal(err)
				}
			} else {
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
				startup = startup || entry.Phase == "startup" && entry.Diagnostic == "database migrate failed"
				listening = listening || entry.Phase == "listening"
			}
			if err := scanner.Err(); err != nil || !startup || listening {
				t.Fatalf("migration failure diagnostic/startup phase: startup=%t listening=%t error=%v", startup, listening, err)
			}
			var connections int
			if err := observer.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE application_name=$1", application).Scan(&connections); err != nil || connections != 0 {
				t.Fatalf("failed process retained database connections: %d %v", connections, err)
			}
			listener, err := net.Listen("tcp", values["DAYNIGHT_LISTEN_ADDR"])
			if err != nil {
				t.Fatalf("failed process retained listener: %v", err)
			}
			if err := listener.Close(); err != nil {
				t.Fatal(err)
			}
			if scenario == "unknown history" {
				_, err = observer.Exec(ctx, "DELETE FROM schema_migrations WHERE version=99")
			} else if scenario == "migration SQL failure" {
				var versions []int64
				if err := observer.QueryRow(ctx, "SELECT array_agg(version ORDER BY version) FROM schema_migrations").Scan(&versions); err != nil || !slices.Equal(versions, []int64{1}) {
					t.Fatalf("failed migration changed the committed prefix: %v %v", versions, err)
				}
				_, err = observer.Exec(ctx, "DROP TABLE tasks")
			} else {
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
			if err := recovered.stop(); err != nil {
				t.Fatalf("recovered service did not stop cleanly: %v", err)
			}
			if err := observer.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE application_name=$1", application).Scan(&connections); err != nil || connections != 0 {
				t.Fatalf("recovered process retained database connections: %d %v", connections, err)
			}
		})
	}
}
