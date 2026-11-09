package postgres

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func databaseURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if url == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required for PostgreSQL tests")
	}
	return url
}

func TestOpenAndReuse(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := scopedDatabaseURL(t)
	for range 2 {
		database, err := Open(ctx, url)
		if err != nil {
			t.Fatal(err)
		}
		var value int
		if err := database.Pool.QueryRow(ctx, "select 42").Scan(&value); err != nil || value != 42 {
			t.Fatalf("query returned %d, %v", value, err)
		}
		database.Close()
	}
}

func TestOpenFailuresPreserveCauseAndRedact(t *testing.T) {
	for _, url := range []string{"postgres://user:top-secret@bad%host/db", "postgres://user:top-secret@127.0.0.1:1/db?connect_timeout=1"} {
		_, err := Open(context.Background(), url)
		var failure *Error
		if !errors.As(err, &failure) || errors.Unwrap(err) == nil {
			t.Fatalf("missing driver cause: %v", err)
		}
		if strings.Contains(err.Error(), "top-secret") || strings.Contains(err.Error(), "user") {
			t.Fatalf("sensitive diagnostic: %s", err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := Open(ctx, databaseURL(t))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected canceled connection: %v", err)
	}
}

func TestQueryCancellationReleasesConnection(t *testing.T) {
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := database.Pool.Exec(ctx, "select pg_sleep(10)")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline: %v", err)
	}
	if err := database.Pool.Ping(context.Background()); err != nil {
		t.Fatalf("pool unusable after cancellation: %v", err)
	}
	observer, err := pgx.Connect(t.Context(), databaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		closeContext, closeCancel := context.WithTimeout(context.Background(), time.Second)
		defer closeCancel()
		if err := observer.Close(closeContext); err != nil {
			t.Error(err)
		}
	}()
	query := "select pg_sleep(10) /* cancellation-" + uuid.NewString() + " */"
	operation, cancelOperation := context.WithCancel(t.Context())
	done := make(chan struct{})
	var queryError error
	go func() {
		_, queryError = database.Pool.Exec(operation, query)
		close(done)
	}()
	t.Cleanup(func() {
		cancelOperation()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("canceled database query did not drain")
		}
	})
	observation, cancelObservation := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancelObservation()
	poll := time.NewTicker(5 * time.Millisecond)
	defer poll.Stop()
	for {
		var sleeping bool
		if err := observer.QueryRow(observation, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
			WHERE datname=current_database() AND pid<>pg_backend_pid() AND query=$1
			AND state='active' AND wait_event_type='Timeout' AND wait_event='PgSleep')`, query).Scan(&sleeping); err != nil {
			t.Fatal(err)
		}
		if sleeping {
			break
		}
		select {
		case <-done:
			t.Fatalf("query finished before the cancellation barrier: %v", queryError)
		case <-observation.Done():
			t.Fatal("query did not enter PostgreSQL sleep")
		case <-poll.C:
		}
	}
	cancelOperation()
	select {
	case <-done:
	case <-observation.Done():
		t.Fatal("observed PostgreSQL query did not accept cancellation")
	}
	if !errors.Is(queryError, context.Canceled) {
		t.Fatalf("explicit cancellation lost its cause: %v", queryError)
	}
	if err := database.Pool.Ping(observation); err != nil {
		t.Fatalf("pool unusable after observed cancellation: %v", err)
	}
	closed := make(chan struct{})
	go func() {
		database.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-observation.Done():
		t.Fatal("database close did not join canceled query connections")
	}
	if _, err := observer.Exec(observation, `SELECT pg_stat_clear_snapshot()`); err != nil {
		t.Fatal(err)
	}
	var active int
	if err := observer.QueryRow(observation, `SELECT count(*) FROM pg_stat_activity
		WHERE datname=current_database() AND pid<>pg_backend_pid() AND query=$1 AND state='active'`, query).Scan(&active); err != nil || active != 0 {
		t.Fatalf("canceled SQL remains active after database close: %d %v", active, err)
	}
}

func TestOpenMigrationFailurePreservesCauseAndRedacts(t *testing.T) {
	databaseURL := scopedDatabaseURL(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(context.Background(), "CREATE TABLE schema_migrations (version bigint)"); err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	applicationName := "migration-failure-" + uuid.NewString()
	query := parsed.Query()
	query.Set("application_name", applicationName)
	parsed.RawQuery = query.Encode()
	_, err = Open(context.Background(), parsed.String())
	var failure *Error
	var postgres *pgconn.PgError
	if !errors.As(err, &failure) || failure.Phase != "migrate" || !errors.As(err, &postgres) {
		t.Fatalf("migration failure chain: %v", err)
	}
	if strings.Contains(err.Error(), "schema_migrations") || strings.Contains(err.Error(), "daynight-test") {
		t.Fatalf("migration diagnostic contains database details: %v", err)
	}
	var connections int
	if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM pg_stat_activity WHERE application_name=$1", applicationName).Scan(&connections); err != nil || connections != 0 {
		t.Fatalf("failed migration retained %d connections: %v", connections, err)
	}
}

func TestReadinessReportsClosedPersistence(t *testing.T) {
	database := isolatedStore(t)
	if err := database.Ready(context.Background()); err != nil {
		t.Fatalf("open persistence is not ready: %v", err)
	}
	database.Close()
	err := database.Ready(context.Background())
	failed, _ := DatabaseErrorFacts(err)
	if err == nil || !failed {
		t.Fatalf("closed persistence readiness: %v", err)
	}
}
