//go:build startupshutdown

package main

import (
	"context"
	"errors"
	"net"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestWorkerActiveClaimMigrationProcessRecovery(t *testing.T) {
	for _, scenario := range []string{"listener fails after commit", "startup deadline while waiting for SHARE", "invalid worker is diagnosed"} {
		t.Run(scenario, func(t *testing.T) {
			values := processAPIEnvironment(t)
			ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
			defer cancel()
			initial := startPersistenceProcess(t, values)
			if err := initial.stop(); err != nil {
				t.Fatal(err)
			}
			observer, err := pgx.Connect(ctx, values["DAYNIGHT_DATABASE_URL"])
			if err != nil {
				t.Fatal(err)
			}
			defer observer.Close(context.Background())
			var expectedChecksum string
			if err := observer.QueryRow(ctx, "SELECT checksum FROM schema_migrations WHERE version=115").Scan(&expectedChecksum); err != nil {
				t.Fatal(err)
			}
			// Remove later additive migrations and their ledger entries to restore schema 114.
			if _, err := observer.Exec(ctx, `CREATE OR REPLACE VIEW task_resource_rows AS
SELECT t.id,t.project_id,t.title,t.description,t.status,t.version,t.created_at,t.updated_at,t.started_at,t.completed_at,
 t.allow_agents,t.required_platform,t.deleted_at,t.assigned_to,t.cancelled_at,t.type,t.parent_id,
 p.type AS parent_type,p.deleted_at AS parent_deleted_at,
 COALESCE(t.deleted_at,CASE WHEN t.type='task' AND p.type='goal' THEN p.deleted_at END) AS effective_deleted_at
FROM tasks t LEFT JOIN tasks p ON p.project_id=t.project_id AND p.id=t.parent_id;
ALTER TABLE tasks DROP COLUMN ancestor_deleted_at;
DROP INDEX task_properties_worker_active_claim_idx;
ALTER TABLE task_sessions DROP COLUMN online_mode;
ALTER TABLE session_archive_files DROP COLUMN upload_version, DROP COLUMN prefix_proof, DROP COLUMN successor_file_id, DROP COLUMN terminal_error;
DROP INDEX sessions_user_created_id;
ALTER TABLE sessions DROP COLUMN last_used_at, DROP COLUMN browser, DROP COLUMN os;
DELETE FROM schema_migrations WHERE version IN (115, 116, 117, 118, 119, 120, 121)`); err != nil {
				t.Fatal(err)
			}
			projectID, taskID := uuid.NewString(), uuid.NewString()
			worker := &model.WorkerClaim{ClaimID: uuid.NewString(), State: model.WorkerActive, UserID: uuid.NewString(), WorkerID: uuid.NewString(),
				Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "Migration process"}, Platform: model.PlatformLinux,
				Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString(),
				Phase: model.WorkerExecuting, ClaimedAt: time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)}
			raw, err := taskproperty.EncodeWorker(worker)
			if err != nil {
				t.Fatal(err)
			}
			validRaw := string(raw)
			if scenario == "invalid worker is diagnosed" {
				raw = []byte(`{}`)
			}
			if _, err := observer.Exec(ctx, "INSERT INTO projects(id,name,repo_url) VALUES($1,'Migration','https://example.test/migration')", projectID); err != nil {
				t.Fatal(err)
			}
			if _, err := observer.Exec(ctx, "INSERT INTO tasks(id,project_id,title,status,version) VALUES($1,$2,'Historical','in_progress',37)", taskID, projectID); err != nil {
				t.Fatal(err)
			}
			if _, err := observer.Exec(ctx, "INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)", taskID, string(raw)); err != nil {
				t.Fatal(err)
			}
			var originalUpdatedAt time.Time
			if err := observer.QueryRow(ctx, "SELECT updated_at FROM tasks WHERE id=$1", taskID).Scan(&originalUpdatedAt); err != nil {
				t.Fatal(err)
			}
			var occupied net.Listener
			var writer pgx.Tx
			if scenario == "listener fails after commit" {
				occupied, err = net.Listen("tcp", values["DAYNIGHT_LISTEN_ADDR"])
				if err != nil {
					t.Fatal(err)
				}
				defer occupied.Close()
			} else if scenario == "startup deadline while waiting for SHARE" {
				writer, err = observer.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer writer.Rollback(context.Background())
				if _, err := writer.Exec(ctx, "LOCK TABLE task_properties IN ROW EXCLUSIVE MODE"); err != nil {
					t.Fatal(err)
				}
				values["DAYNIGHT_STARTUP_TIMEOUT"] = "2s"
			}
			failed := startMigrationProcess(t, values)
			fresh, err := pgx.Connect(ctx, values["DAYNIGHT_DATABASE_URL"])
			if err != nil {
				t.Fatal(err)
			}
			defer fresh.Close(context.Background())
			if writer != nil {
				if err := grantWait(ctx, func() (bool, error) {
					var waiting bool
					err := fresh.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_locks WHERE relation='task_properties'::regclass AND mode='ShareLock' AND NOT granted)`).Scan(&waiting)
					return waiting, err
				}); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err := <-failed.finished:
				failed.stopped = true
				var exit *exec.ExitError
				if !errors.As(err, &exit) || exit.ExitCode() != 1 {
					t.Fatalf("failed startup exit: %v; %s", err, failed.logs.String())
				}
			case <-ctx.Done():
				t.Fatal("migration failure did not terminate")
			}
			var committed, indexed, preserved bool
			if err := fresh.QueryRow(ctx, `SELECT EXISTS(SELECT FROM schema_migrations WHERE version=115 AND checksum=$1),
EXISTS(SELECT FROM pg_index WHERE indexrelid=to_regclass('task_properties_worker_active_claim_idx') AND indisvalid AND indisready),
EXISTS(SELECT FROM tasks t JOIN task_properties p ON p.task_id=t.id WHERE t.id=$2 AND t.version=37 AND t.updated_at=$3 AND p.name='worker' AND p.value=$4)`, expectedChecksum, taskID, originalUpdatedAt, string(raw)).Scan(&committed, &indexed, &preserved); err != nil {
				t.Fatal(err)
			}
			wantCommitted := occupied != nil
			if committed != wantCommitted || indexed != wantCommitted || !preserved {
				t.Fatalf("startup result: ledger=%t index=%t preserved=%t want commit=%t", committed, indexed, preserved, wantCommitted)
			}
			var activityApplied bool
			if err := fresh.QueryRow(ctx, `SELECT EXISTS(SELECT FROM schema_migrations WHERE version=118) AND EXISTS(SELECT FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sessions' AND column_name='last_used_at')`).Scan(&activityApplied); err != nil || activityApplied != wantCommitted {
				t.Fatalf("activity migration after worker validation: applied=%t want=%t error=%v", activityApplied, wantCommitted, err)
			}
			var stepRetirementApplied bool
			if err := fresh.QueryRow(ctx, `SELECT EXISTS(SELECT FROM schema_migrations WHERE version=119)`).Scan(&stepRetirementApplied); err != nil || stepRetirementApplied != wantCommitted {
				t.Fatalf("step retirement migration after worker validation: applied=%t want=%t error=%v", stepRetirementApplied, wantCommitted, err)
			}
			const managementFacts = `SELECT (EXISTS(SELECT FROM schema_migrations WHERE version=120))::int + (EXISTS(SELECT FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sessions' AND column_name='browser'))::int + (EXISTS(SELECT FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sessions' AND column_name='os'))::int + (EXISTS(SELECT FROM pg_index WHERE indexrelid=to_regclass('sessions_user_created_id') AND indisvalid AND indisready))::int`
			var managementFactsCount int
			wantFacts := 0
			if wantCommitted {
				wantFacts = 4
			}
			if err := fresh.QueryRow(ctx, managementFacts).Scan(&managementFactsCount); err != nil || managementFactsCount != wantFacts {
				t.Fatalf("session management migration after worker validation: facts=%d want=%d error=%v", managementFactsCount, wantFacts, err)
			}
			if strings.Contains(failed.logs.String(), validRaw) || strings.Contains(failed.logs.String(), values["DAYNIGHT_DATABASE_URL"]) {
				t.Fatal("startup failure exposed a claim payload or database configuration")
			}
			if scenario == "invalid worker is diagnosed" && (!strings.Contains(failed.logs.String(), taskID) || !strings.Contains(failed.logs.String(), "worker shape")) {
				t.Fatalf("invalid worker diagnostic omits task or reason: %s", failed.logs.String())
			}
			if occupied != nil {
				if err := occupied.Close(); err != nil {
					t.Fatal(err)
				}
			} else if writer != nil {
				if err := writer.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
			} else if _, err := fresh.Exec(ctx, "UPDATE task_properties SET value=$2 WHERE task_id=$1 AND name='worker'", taskID, validRaw); err != nil {
				t.Fatal(err)
			}
			delete(values, "DAYNIGHT_STARTUP_TIMEOUT")
			recovered := startPersistenceProcess(t, values)
			if err := recovered.stop(); err != nil {
				t.Fatal(err)
			}
			if err := fresh.QueryRow(ctx, `SELECT EXISTS(SELECT FROM schema_migrations WHERE version=115 AND checksum=$1) AND EXISTS(SELECT FROM pg_index WHERE indexrelid=to_regclass('task_properties_worker_active_claim_idx') AND indisvalid AND indisready)`, expectedChecksum).Scan(&committed); err != nil || !committed {
				t.Fatalf("same-ledger recovery: committed=%t error=%v", committed, err)
			}
			if err := fresh.QueryRow(ctx, `SELECT EXISTS(SELECT FROM schema_migrations WHERE version=118) AND EXISTS(SELECT FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sessions' AND column_name='last_used_at')`).Scan(&activityApplied); err != nil || !activityApplied {
				t.Fatalf("activity migration recovery: applied=%t error=%v", activityApplied, err)
			}
			if err := fresh.QueryRow(ctx, `SELECT EXISTS(SELECT FROM schema_migrations WHERE version=119)`).Scan(&stepRetirementApplied); err != nil || !stepRetirementApplied {
				t.Fatalf("step retirement migration recovery: applied=%t error=%v", stepRetirementApplied, err)
			}
			if err := fresh.QueryRow(ctx, managementFacts).Scan(&managementFactsCount); err != nil || managementFactsCount != 4 {
				t.Fatalf("session management migration recovery: facts=%d error=%v", managementFactsCount, err)
			}
		})
	}
}
