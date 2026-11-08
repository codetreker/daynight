package postgres

import (
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

func TestDeletedSourceAndCaptureRemainAtomicAtCommit(t *testing.T) {
	s := isolatedStore(t)
	ctx := t.Context()
	project, team, source, dependent := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	mustQueryExec(t, s, `INSERT INTO projects(id,name,repo_url) VALUES($1,'source boundary','https://example.org')`, project)
	mustQueryExec(t, s, `INSERT INTO teams(id,name) VALUES($1,'source team')`, team)
	mustQueryExec(t, s, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, team)
	completion, err := s.WriteProject(ctx, project, func(sc store.ProjectWriteScope) error {
		if _, err := sc.TaskDAO().CreateTask(ctx, source, store.TaskWrite{Title: "source", Status: model.TaskTodo}); err != nil {
			return err
		}
		_, err := sc.TaskDAO().CreateTask(ctx, dependent, store.TaskWrite{Title: "dependent", Status: model.TaskTodo, DependsOn: []string{source}})
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("source setup: %v %v", completion, err)
	}
	mustQueryExec(t, s, `CREATE FUNCTION reject_source_capture_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1913',MESSAGE='deferred capture failure'; END $$; CREATE CONSTRAINT TRIGGER reject_source_capture_commit AFTER INSERT ON webhook_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_source_capture_commit()`)
	owner := wm.Owner{Kind: "personal", ID: uuid.NewString()}
	var event store.WebhookCapturedEvent
	var delivery store.WebhookCapturedDelivery
	var tombstone model.TaskTombstone
	write := func() (store.Completion, error) {
		return s.WriteProject(ctx, project, func(sc store.ProjectWriteScope) error {
			var err error
			tombstone, err = sc.TaskDAO().DeleteTask(ctx, source, true)
			if err != nil {
				return err
			}
			event, delivery = webhookBoundaryCapture(owner, uuid.NewString(), project, source)
			event.EventType, event.OccurredAt, event.TaskDeletedAt, event.TaskVersion = "task.deleted", tombstone.DeletedAt, &tombstone.DeletedAt, &tombstone.Version
			for i := range delivery.AutomaticScheduleAt {
				delivery.AutomaticScheduleAt[i] = tombstone.DeletedAt.Add(time.Duration(i) * time.Minute)
			}
			delivery.AutomaticExpiresAt, delivery.PayloadExpiresAt = tombstone.DeletedAt.Add(72*time.Hour), tombstone.DeletedAt.Add(168*time.Hour)
			delivery.Matches[0].EventType = "task.deleted"
			return sc.CaptureDAO().SaveCapture(ctx, event, []store.WebhookCapturedDelivery{delivery})
		})
	}
	completion, err = write()
	var failure *store.TransactionError
	failed, state := store.DatabaseErrorFacts(err)
	if completion.Outcome != store.TransactionUnknown || !errors.As(err, &failure) || !failure.CommitAttempted || !failed || state != "P1913" {
		t.Fatalf("deferred commit result: %v failure=%+v sqlstate=%q error=%v", completion, failure, state, err)
	}
	var sourceDeleted bool
	var sourceVersion, dependentVersion int64
	var dependencies, events, deliveries int
	if err = s.Pool.QueryRow(ctx, `SELECT (SELECT deleted_at IS NOT NULL FROM tasks WHERE id=$1),(SELECT version FROM tasks WHERE id=$1),(SELECT version FROM tasks WHERE id=$2),(SELECT count(*) FROM task_dependencies WHERE task_id=$2),(SELECT count(*) FROM webhook_events WHERE id=$3),(SELECT count(*) FROM webhook_deliveries WHERE id=$4)`, source, dependent, event.ID, delivery.ID).Scan(&sourceDeleted, &sourceVersion, &dependentVersion, &dependencies, &events, &deliveries); err != nil || sourceDeleted || sourceVersion != 1 || dependentVersion != 1 || dependencies != 1 || events != 0 || deliveries != 0 {
		t.Fatalf("deferred failure changed source/capture: deleted=%v versions=%d/%d dependencies=%d events=%d deliveries=%d error=%v", sourceDeleted, sourceVersion, dependentVersion, dependencies, events, deliveries, err)
	}
	mustQueryExec(t, s, `DROP TRIGGER reject_source_capture_commit ON webhook_events; DROP FUNCTION reject_source_capture_commit()`)
	completion, err = write()
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("source retry: %v %v", completion, err)
	}
	var sameTombstone bool
	if err = s.Pool.QueryRow(ctx, `SELECT t.deleted_at IS NOT NULL AND e.task_deleted_at=t.deleted_at AND e.occurred_at=t.deleted_at AND e.task_version=t.version AND e.event_type='task.deleted' FROM tasks t JOIN webhook_events e ON e.task_id=t.id WHERE t.id=$1 AND e.id=$2`, source, event.ID).Scan(&sameTombstone); err != nil || !sameTombstone {
		t.Fatalf("committed event disagrees with source tombstone: %v %v", sameTombstone, err)
	}
	if err = s.Pool.QueryRow(ctx, `SELECT version,(SELECT count(*) FROM task_dependencies WHERE task_id=$1) FROM tasks WHERE id=$1`, dependent).Scan(&dependentVersion, &dependencies); err != nil || dependentVersion != 2 || dependencies != 0 {
		t.Fatalf("committed dependency removal: version=%d dependencies=%d error=%v", dependentVersion, dependencies, err)
	}
}
