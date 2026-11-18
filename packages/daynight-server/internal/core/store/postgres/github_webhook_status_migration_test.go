package postgres

import (
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGitHubWebhookStatusMigrationPreservesWork(t *testing.T) {
	parallelRootDatabaseTest(t)
	pool := githubWebhookStatusMigrationPool(t)
	ctx := t.Context()
	fields := []string{"last_webhook_received_at", "last_webhook_attempt_at", "last_webhook_success_at", "webhook_error_code", "webhook_error_message", "webhook_error_at"}
	for _, field := range fields {
		id := seedGitHubWebhookStatusMigration(t, pool)
		value := "'2020-01-01'"
		if field == "webhook_error_code" || field == "webhook_error_message" {
			value = "'installation-access-error'"
		}
		if _, err := pool.Exec(ctx, fmt.Sprintf("UPDATE project_github SET %s=%s WHERE project_id=$1", field, value), id); err != nil {
			t.Fatal(err)
		}
	}
	untouched := seedGitHubWebhookStatusMigration(t, pool)
	if _, err := pool.Exec(ctx, "UPDATE project_github SET revision=9223372036854775807 WHERE project_id=$1", untouched); err != nil {
		t.Fatal(err)
	}
	preservedSQL := `SELECT jsonb_agg(to_jsonb(g)-ARRAY['last_webhook_received_at','last_webhook_attempt_at','last_webhook_success_at','webhook_error_code','webhook_error_message','webhook_error_at','revision','updated_at'] ORDER BY project_id)::text FROM project_github g`
	preserved := migrationJSON(t, pool, preservedSQL)
	untouchedSQL := fmt.Sprintf("SELECT to_jsonb(g)::text FROM project_github g WHERE project_id='%s'", untouched)
	unchanged := migrationJSON(t, pool, untouchedSQL)
	workSQL := `SELECT jsonb_build_object('pending',(SELECT jsonb_agg(to_jsonb(p) ORDER BY project_id,number) FROM project_github_pending_prs p),'prs',(SELECT jsonb_agg(to_jsonb(p) ORDER BY project_id,number) FROM project_pull_requests p))::text`
	work := migrationJSON(t, pool, workSQL)
	if err := migrate(ctx, pool, schemaMigrations[:85]); err != nil {
		t.Fatal(err)
	}
	var normalized bool
	if err := pool.QueryRow(ctx, `SELECT count(*)=6 AND bool_and(revision=10 AND updated_at>'2020-01-01'::timestamptz AND last_webhook_received_at IS NULL AND last_webhook_attempt_at IS NULL AND last_webhook_success_at IS NULL AND webhook_error_code IS NULL AND webhook_error_message IS NULL AND webhook_error_at IS NULL) FROM project_github WHERE project_id<>$1`, untouched).Scan(&normalized); err != nil || !normalized {
		t.Fatalf("selective normalization: normalized=%t err=%v", normalized, err)
	}
	if migrationJSON(t, pool, preservedSQL) != preserved || migrationJSON(t, pool, untouchedSQL) != unchanged || migrationJSON(t, pool, workSQL) != work {
		t.Fatal("normalization changed preserved connection fields, untouched row, pending hints or saved PRs")
	}
	var checksum string
	if err := pool.QueryRow(ctx, "SELECT checksum FROM schema_migrations WHERE version=85").Scan(&checksum); err != nil || checksum != schemaMigrations[84].checksum() {
		t.Fatalf("normalization ledger: checksum=%q err=%v", checksum, err)
	}
	if _, err := pool.Exec(ctx, "UPDATE project_github SET last_webhook_received_at='2021-01-01' WHERE project_id=$1", untouched); err != nil {
		t.Fatal(err)
	}
	replayedSQL := `SELECT jsonb_agg(to_jsonb(g) ORDER BY project_id)::text FROM project_github g`
	after := migrationJSON(t, pool, replayedSQL)
	if err := migrate(ctx, pool, schemaMigrations[:85]); err != nil {
		t.Fatal(err)
	}
	if migrationJSON(t, pool, replayedSQL) != after || migrationJSON(t, pool, workSQL) != work {
		t.Fatal("repeated startup reapplied normalization or changed retained work")
	}
}

func TestGitHubWebhookStatusMigrationRollsBackDataAndLedger(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, failure := range []struct{ name, setup, repair, code string }{
		{"revision overflow", "UPDATE project_github SET revision=9223372036854775807", "UPDATE project_github SET revision=9", "22003"},
		{"ledger failure", `CREATE FUNCTION reject_status_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version=85 THEN RAISE EXCEPTION 'ledger rejected'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_status_ledger BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_status_ledger()`, "DROP TRIGGER reject_status_ledger ON schema_migrations; DROP FUNCTION reject_status_ledger()", "P0001"},
	} {
		t.Run(failure.name, func(t *testing.T) {
			pool := githubWebhookStatusMigrationPool(t)
			ctx := t.Context()
			seedGitHubWebhookStatusMigration(t, pool)
			if _, err := pool.Exec(ctx, "UPDATE project_github SET webhook_error_code='old-installation-error'; "+failure.setup); err != nil {
				t.Fatal(err)
			}
			rowsSQL := `SELECT jsonb_agg(to_jsonb(g) ORDER BY project_id)::text FROM project_github g`
			ledgerSQL := `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m`
			before, ledger := migrationJSON(t, pool, rowsSQL), migrationJSON(t, pool, ledgerSQL)
			err := migrate(ctx, pool, schemaMigrations[:85])
			var pgError *pgconn.PgError
			if !errors.As(err, &pgError) || pgError.Code != failure.code {
				t.Fatalf("expected PostgreSQL %s: %v", failure.code, err)
			}
			if migrationJSON(t, pool, rowsSQL) != before || migrationJSON(t, pool, ledgerSQL) != ledger {
				t.Fatal("failed normalization changed connection data or prior migration ledger")
			}
			if _, err := pool.Exec(ctx, failure.repair); err != nil {
				t.Fatal(err)
			}
			if err := migrate(ctx, pool, schemaMigrations[:85]); err != nil {
				t.Fatal(err)
			}
			var recovered bool
			if err := pool.QueryRow(ctx, `SELECT revision=10 AND webhook_error_code IS NULL AND EXISTS(SELECT 1 FROM schema_migrations WHERE version=85) FROM project_github`).Scan(&recovered); err != nil || !recovered {
				t.Fatalf("normalization recovery: recovered=%t err=%v", recovered, err)
			}
		})
	}
}

func githubWebhookStatusMigrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if len(schemaMigrations) < 85 || schemaMigrations[83].version != 84 || schemaMigrations[84].version != 85 {
		t.Fatal("unexpected webhook status migration boundary")
	}
	pool := emptyPool(t)
	if err := migrate(t.Context(), pool, schemaMigrations[:84]); err != nil {
		t.Fatal(err)
	}
	return pool
}

func seedGitHubWebhookStatusMigration(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := pool.Exec(t.Context(), `INSERT INTO project_github(project_id,version,generation,revision,enabled,sync_enabled,repository_id,access_state,access_reason,access_checked_at,next_access_check_at,access_hint_id,access_delivery_id,next_poll_at,not_before,last_poll_attempt_at,last_full_success_at,last_full_generation,poll_error_code,poll_error_message,poll_error_at,claim_token,claim_until,claim_kind,created_at,updated_at,hook_repository_id,hook_version,hook_enabled,hook_secret,hook_last_received_at) VALUES($1,7,8,9,true,true,10,'unavailable','suspended','2020-01-01','2099-01-02',$2,'installation-delivery','2099-01-03','2099-01-04','2020-01-02','2020-01-03',8,'poll-error','retained polling diagnosis','2020-01-04',$3,'2099-01-05','access','2020-01-01','2020-01-01',10,3,true,'retained-secret','2020-01-05')`, id, uuid.NewString(), uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,5,8,$2,'pr-delivery','2020-01-01','2099-01-06')`, id, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO project_pull_requests(project_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,description,observed_at,revision) VALUES($1,5,50,'url','title','open',false,'main','sha','2020-01-01','2020-01-02','retained body','2020-01-03',9)`, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func migrationJSON(t *testing.T, pool *pgxpool.Pool, query string) string {
	t.Helper()
	var result string
	if err := pool.QueryRow(t.Context(), query).Scan(&result); err != nil {
		t.Fatal(err)
	}
	return result
}
