package webhook_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func captureDatabaseFacts(t *testing.T, f *captureFixture) string {
	t.Helper()
	var facts string
	err := f.db.Pool.QueryRow(f.ctx, `SELECT jsonb_build_object(
 'tasks',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM tasks t WHERE project_id=$1),
 'edges',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY task_id,depends_on_task_id),'[]'::jsonb) FROM task_dependencies d WHERE project_id=$1),
 'sessions',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM task_sessions s WHERE project_id=$1),
 'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.operation_id),'[]'::jsonb) FROM session_operations o JOIN task_sessions s ON s.id=o.session_id WHERE s.project_id=$1),
 'epoch',(SELECT task_cache_epoch FROM projects WHERE id=$1),
 'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]'::jsonb) FROM webhook_events e),
 'deliveries',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]'::jsonb) FROM webhook_deliveries d),
 'matches',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY delivery_id,subscription_id,binding_id),'[]'::jsonb) FROM webhook_delivery_matches m))::text`, f.project).Scan(&facts)
	if err != nil {
		t.Fatal(err)
	}
	return facts
}

type oversizedBodyCapture struct{ *webhook.Capturer }

func (c oversizedBodyCapture) CaptureBatch(ctx context.Context, dao store.WebhookCaptureDAO, facts []protocol.Fact) error {
	return c.Capturer.CaptureBatch(ctx, oversizedBodyDAO{WebhookCaptureDAO: dao}, facts)
}

type oversizedBodyDAO struct{ store.WebhookCaptureDAO }

func (d oversizedBodyDAO) SaveCapture(ctx context.Context, event store.WebhookCapturedEvent, deliveries []store.WebhookCapturedDelivery) error {
	// Legal v1 facts are bounded far below 64 KiB; inject at persistence to
	// exercise the database boundary without inventing a reachable wire fact.
	deliveries[0].Body = bytes.Repeat([]byte("x"), 65537)
	hash := sha256.Sum256(deliveries[0].Body)
	deliveries[0].BodySHA256 = hash[:]
	return d.WebhookCaptureDAO.SaveCapture(ctx, event, deliveries)
}

func TestCaptureOversizedBodyPersistenceRollsBackSource(t *testing.T) {
	f := newCaptureFixture(t, 1)
	before := captureDatabaseFacts(t, f)
	_, err := taskservice.NewTasks(f.db, oversizedBodyCapture{f.capture}).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "oversize storage injection"})
	var cause *pgconn.PgError
	if !errors.As(err, &cause) || cause.Code != "23514" {
		t.Fatalf("oversize body constraint: %v", err)
	}
	if after := captureDatabaseFacts(t, f); after != before {
		t.Fatal("oversize body changed source or outbox")
	}
}

func TestCaptureInvalidBatchRollsBackSource(t *testing.T) {
	for _, kind := range []string{"three_facts", "invalid_schema"} {
		t.Run(kind, func(t *testing.T) {
			f := newCaptureFixture(t, 1)
			task, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "original"})
			if err != nil {
				t.Fatal(err)
			}
			before := captureDatabaseFacts(t, f)
			_, err = f.db.WriteProject(f.ctx, f.project, func(tx store.ProjectWriteScope) error {
				current, err := tx.TaskDAO().Task(f.ctx, task.ID)
				if err != nil {
					return err
				}
				values := taskcore.CurrentWrite(current)
				values.Title = "must roll back"
				updated, err := tx.TaskDAO().UpdateTask(f.ctx, task.ID, values)
				if err != nil {
					return err
				}
				if updated.Title != "must roll back" {
					return fmt.Errorf("source write was not applied inside transaction")
				}
				fact := protocol.Fact{Type: protocol.StatusChanged, ProjectID: f.project, TaskID: task.ID, TaskVersion: updated.Version, OccurredAt: updated.UpdatedAt, PreviousStatus: "todo", Status: "in_progress"}
				if kind == "three_facts" {
					return f.capture.CaptureBatch(f.ctx, tx.CaptureDAO(), []protocol.Fact{fact, fact, fact})
				}
				fact.Status = "todo"
				return f.capture.CaptureBatch(f.ctx, tx.CaptureDAO(), []protocol.Fact{fact})
			})
			if err == nil {
				t.Fatal("invalid capture accepted")
			}
			if after := captureDatabaseFacts(t, f); after != before {
				t.Fatal("invalid capture changed source or outbox")
			}
		})
	}
}

func TestCaptureFreezeDatabaseFailureRollsBackSource(t *testing.T) {
	f := newCaptureFixture(t, 1)
	before := captureDatabaseFacts(t, f)
	if _, err := f.db.Pool.Exec(f.ctx, `ALTER TABLE webhook_bindings RENAME TO hidden_webhook_bindings`); err != nil {
		t.Fatal(err)
	}
	_, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "freeze failure"})
	var cause *pgconn.PgError
	if !errors.As(err, &cause) || cause.Code != "42P01" {
		t.Fatalf("missing freeze SQL failure: %v", err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `ALTER TABLE hidden_webhook_bindings RENAME TO webhook_bindings`); err != nil {
		t.Fatal(err)
	}
	if after := captureDatabaseFacts(t, f); after != before {
		t.Fatal("failed freeze changed source or outbox")
	}
}

func TestCaptureDeleteRollbackAndAuthoritativeTombstone(t *testing.T) {
	for _, mode := range []string{"capture", "commit"} {
		t.Run(mode, func(t *testing.T) {
			f := newCaptureFixture(t, 1)
			tasks := taskservice.NewTasks(f.db, f.capture)
			target, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "target"})
			if err != nil {
				t.Fatal(err)
			}
			_, err = tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "dependent", DependsOn: []string{target.ID}})
			if err != nil {
				t.Fatal(err)
			}
			sessionID, operationID := uuid.NewString(), uuid.NewString()
			snapshot, _ := json.Marshal(map[string]any{"lifecycle": "active", "lastTimelineSeq": "4", "controls": []string{"control"}})
			receipt, _ := json.Marshal(map[string]any{"state": "accepted", "error": nil})
			_, err = f.db.Pool.Exec(f.ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`, sessionID, f.project, target.ID, uuid.NewString(), f.principal.UserID, uuid.NewString(), snapshot)
			if err != nil {
				t.Fatal(err)
			}
			_, err = f.db.Pool.Exec(f.ctx, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,1,'\x01','{}',$3,$4,'session',$5)`, sessionID, operationID, f.principal.UserID, f.principal.CredentialID, receipt)
			if err != nil {
				t.Fatal(err)
			}
			baseline := captureDatabaseFacts(t, f)
			if mode == "capture" {
				_, err = f.db.Pool.Exec(f.ctx, `CREATE FUNCTION rollback_delete_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected delete capture failure'; END $$;
 CREATE TRIGGER rollback_delete_capture BEFORE INSERT ON webhook_deliveries FOR EACH ROW WHEN (NEW.event_type='task.deleted') EXECUTE FUNCTION rollback_delete_capture()`)
			} else {
				_, err = f.db.Pool.Exec(f.ctx, `CREATE TABLE rollback_commit_guard(id int UNIQUE DEFERRABLE INITIALLY DEFERRED);
 CREATE FUNCTION rollback_delete_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO rollback_commit_guard VALUES(1),(1); RETURN NEW; END $$;
 CREATE TRIGGER rollback_delete_commit AFTER INSERT ON webhook_events FOR EACH ROW WHEN (NEW.event_type='task.deleted') EXECUTE FUNCTION rollback_delete_commit()`)
			}
			if err != nil {
				t.Fatal(err)
			}
			err = tasks.Delete(f.ctx, f.principal, f.project, target.ID, taskcore.DeleteTask{Version: target.Version, RemoveDepends: true})
			var cause *pgconn.PgError
			if !errors.As(err, &cause) {
				t.Fatalf("lost database cause: %v", err)
			}
			if (mode == "capture" && (cause.Code != "P0001" || cause.Message != "injected delete capture failure")) || (mode == "commit" && cause.Code != "23505") {
				t.Fatalf("wrong failure: %v", err)
			}
			if after := captureDatabaseFacts(t, f); after != baseline {
				t.Fatalf("failed delete changed source or capture:\nbefore=%s\nafter=%s", baseline, after)
			}
			if _, err = f.db.Pool.Exec(f.ctx, fmt.Sprintf(`DROP TRIGGER rollback_delete_%s ON webhook_%s`, mode, map[string]string{"capture": "deliveries", "commit": "events"}[mode])); err != nil {
				t.Fatal(err)
			}
			if err = tasks.Delete(f.ctx, f.principal, f.project, target.ID, taskcore.DeleteTask{Version: target.Version, RemoveDepends: true}); err != nil {
				t.Fatal(err)
			}
			var equal, deleted bool
			var version int64
			var lifecycle, state string
			var dependencies int
			err = f.db.Pool.QueryRow(f.ctx, `SELECT t.deleted_at IS NOT NULL,t.version,e.task_version=t.version AND e.task_deleted_at=t.deleted_at AND e.occurred_at=t.deleted_at,
 (SELECT snapshot->>'lifecycle' FROM task_sessions WHERE id=$2),
 (SELECT receipt->>'state' FROM session_operations WHERE operation_id=$3),
 (SELECT count(*) FROM task_dependencies WHERE project_id=$4 AND depends_on_task_id=$1)
 FROM tasks t JOIN webhook_events e ON e.task_id=t.id AND e.event_type='task.deleted' WHERE t.id=$1`, target.ID, sessionID, operationID, f.project).Scan(&deleted, &version, &equal, &lifecycle, &state, &dependencies)
			if err != nil || !deleted || version != target.Version+1 || !equal || lifecycle != "draining" || state != "rejected" || dependencies != 0 {
				t.Fatalf("success tombstone=%v version=%d equal=%v lifecycle=%s state=%s edges=%d err=%v", deleted, version, equal, lifecycle, state, dependencies, err)
			}
			if captureDatabaseFacts(t, f) == baseline {
				t.Fatal("successful deletion did not advance facts")
			}
		})
	}
}

func TestCaptureInsertAndUUIDConflictRollback(t *testing.T) {
	for _, table := range []string{"events", "deliveries"} {
		t.Run(table, func(t *testing.T) {
			f := newCaptureFixture(t, 1)
			before := captureDatabaseFacts(t, f)
			_, err := f.db.Pool.Exec(f.ctx, fmt.Sprintf(`CREATE FUNCTION injected_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected %s failure'; END $$; CREATE TRIGGER injected_insert_failure BEFORE INSERT ON webhook_%s FOR EACH ROW EXECUTE FUNCTION injected_insert_failure()`, table, table))
			if err != nil {
				t.Fatal(err)
			}
			_, err = taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "failed creation"})
			var cause *pgconn.PgError
			if !errors.As(err, &cause) || cause.Code != "P0001" || cause.Message != "injected "+table+" failure" {
				t.Fatalf("missing insert failure: %v", err)
			}
			if after := captureDatabaseFacts(t, f); after != before {
				t.Fatalf("failed %s insert changed source or capture", table)
			}
		})
	}
	t.Run("event_uuid_conflict", func(t *testing.T) {
		f := newCaptureFixture(t, 1)
		tasks := taskservice.NewTasks(f.db, f.capture)
		f.capture.Random = io.MultiReader(bytes.NewReader(bytes.Repeat([]byte{42}, 16)), rand.Reader)
		if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "first"}); err != nil {
			t.Fatal(err)
		}
		before := captureDatabaseFacts(t, f)
		f.capture.Random = io.MultiReader(bytes.NewReader(bytes.Repeat([]byte{42}, 16)), rand.Reader)
		_, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "duplicate event ID"})
		var cause *pgconn.PgError
		if !errors.As(err, &cause) || cause.Code != "23505" || cause.ConstraintName != "webhook_events_pkey" {
			t.Fatalf("event collision not reported: %v", err)
		}
		if after := captureDatabaseFacts(t, f); after != before {
			t.Fatal("UUID conflict changed source or capture")
		}
	})
}
