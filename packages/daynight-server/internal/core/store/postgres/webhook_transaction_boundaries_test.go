package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	dbwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

func webhookBoundaryCapture(owner wm.Owner, endpoint, project, task string) (store.WebhookCapturedEvent, store.WebhookCapturedDelivery) {
	now := time.Now().UTC().Truncate(time.Microsecond)
	body := []byte(`{"captured":true}`)
	sum := sha256.Sum256(body)
	version := int64(1)
	event := store.WebhookCapturedEvent{ID: uuid.NewString(), EventType: "task.created", WireVersion: 1, SchemaVersion: 1, Source: "urn:daynight:project:" + project, Subject: "tasks/" + task, ProjectID: project, TaskID: task, TaskVersion: &version, OccurredAt: now, RecordedAt: now, FactCodecVersion: 1, FactBytes: body, FactSHA256: sum[:]}
	schedule := make([]time.Time, 10)
	for i := range schedule {
		schedule[i] = now.Add(time.Duration(i) * time.Minute)
	}
	delivery := store.WebhookCapturedDelivery{ID: uuid.NewString(), EndpointID: endpoint, Owner: owner, OriginalMatchSHA256: make([]byte, 32), PolicyVersion: 1, DestinationRevision: 1, AdapterVersion: 1, DestinationKind: "http", DestinationOrigin: "https://example.org", RenderVersion: 1, ConfigurationSchemaVersion: 1, DestinationConfiguration: []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://example.org/hook"}}`), RequestMethod: "POST", RequestMediaType: "application/cloudevents+json", DeterministicHeadersJSON: []byte(`[]`), Body: body, BodySHA256: sum[:], AutomaticScheduleAt: schedule, AutomaticExpiresAt: now.Add(72 * time.Hour), PayloadExpiresAt: now.Add(168 * time.Hour), LastActivityAt: now, MetadataExpiresAt: now.Add(30 * 24 * time.Hour), Matches: []store.WebhookCapturedMatch{{SubscriptionID: uuid.NewString(), BindingID: uuid.NewString(), ProjectID: project, EventType: "task.created", AuthorizationEpoch: 1}}}
	return event, delivery
}

func webhookBoundaryStore(t *testing.T) (*Store, wm.Owner, wm.Endpoint, wm.Operation, store.WebhookDelivery, store.WebhookAttempt) {
	t.Helper()
	s := isolatedStore(t)
	ctx := t.Context()
	owner, endpoint, key, receipt := webhookStoredFixture(t)
	completion, err := s.WriteWebhook(ctx, owner, receipt.ID, func(sc store.WebhookWriteScope) error {
		if err := sc.WebhookWriter().PutEndpoint(ctx, endpoint); err != nil {
			return err
		}
		if err := sc.WebhookWriter().PutSigningKey(ctx, key); err != nil {
			return err
		}
		return sc.WebhookWriter().PutOperation(ctx, receipt)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("endpoint fixture: %v %v", completion, err)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	event, prepared := webhookBoundaryCapture(owner, endpoint.ID, uuid.NewString(), uuid.NewString())
	dao := dbwebhook.New(tx)
	if err = dao.SaveCapture(ctx, event, []store.WebhookCapturedDelivery{prepared}); err != nil {
		t.Fatal(err)
	}
	delivery, err := dao.LockDelivery(ctx, prepared.ID)
	if err != nil {
		t.Fatal(err)
	}
	slot := int16(1)
	attempt := store.WebhookAttempt{ID: uuid.NewString(), DeliveryID: delivery.ID, EndpointID: endpoint.ID, Trigger: "automatic", LeaseToken: uuid.NewString(), Generation: 1, DestinationRevision: 1, Sequence: 1, SigningKeyIDs: []string{key.ID}, AutomaticPlanSlot: &slot, ClaimedAt: prepared.LastActivityAt, AdmittedAt: prepared.LastActivityAt}
	if err = dao.InsertAttempt(ctx, attempt); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return s, owner, endpoint, receipt, delivery, attempt
}

func TestWebhookRedeliveryWritesRollBackWithReceipt(t *testing.T) {
	s, owner, endpoint, initial, original, attempt := webhookBoundaryStore(t)
	ctx := t.Context()
	mustQueryExec(t, s, `CREATE FUNCTION reject_boundary_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1911',MESSAGE='receipt rejected'; END $$; CREATE TRIGGER reject_boundary_receipt BEFORE INSERT ON webhook_operations FOR EACH ROW EXECUTE FUNCTION reject_boundary_receipt()`)
	receipt := initial
	receipt.ID, receipt.Kind, receipt.DeliveryID = uuid.NewString(), "delivery.redeliver", original.ID
	generation := int64(2)
	receipt.GenerationAfter = &generation
	now := time.Now().UTC().Truncate(time.Microsecond)
	completion, err := s.WriteWebhook(ctx, owner, receipt.ID, func(sc store.WebhookWriteScope) error {
		dao := sc.RedeliveryWriter()
		locked, err := dao.LockDelivery(ctx, original.ID)
		if err != nil {
			return err
		}
		attempts, err := dao.LockAttempts(ctx, original.ID)
		if err != nil {
			return err
		}
		if len(attempts) != 1 || attempts[0].ID != attempt.ID {
			return fmt.Errorf("unexpected attempt fixture")
		}
		changed := attempts[0]
		outcome := "unknown"
		changed.FinishedAt, changed.RecoveredUnknownAt, changed.Outcome = &now, &now, &outcome
		if err = dao.UpdateAttempt(ctx, changed); err != nil {
			return err
		}
		locked.ManualOperationCount, locked.Generation = 1, generation
		locked.AutomaticOpen, locked.Trigger, locked.ManualOperationID = false, "manual", &receipt.ID
		locked.ExpiresAt, locked.NextAttemptAt = locked.PayloadExpiresAt, &now
		if err = dao.UpdateDelivery(ctx, locked); err != nil {
			return err
		}
		return sc.WebhookWriter().PutOperation(ctx, receipt)
	})
	failed, state := store.DatabaseErrorFacts(err)
	if completion.Outcome != store.TransactionNotCommitted || !failed || state != "P1911" {
		t.Fatalf("receipt failure: completion=%v sqlstate=%q error=%v", completion, state, err)
	}
	completion, err = s.WriteWebhookDelivery(ctx, func(sc store.WebhookDeliveryScope) error {
		got, err := sc.LockDelivery(ctx, original.ID)
		if err != nil {
			return err
		}
		attempts, err := sc.LockAttempts(ctx, original.ID)
		if err != nil {
			return err
		}
		if got.Generation != original.Generation || got.ManualOperationCount != original.ManualOperationCount || got.Trigger != original.Trigger || !bytes.Equal(got.Body, original.Body) || len(attempts) != 1 || attempts[0].FinishedAt != nil || attempts[0].Outcome != nil {
			return fmt.Errorf("receipt failure changed delivery or attempt: %+v %+v", got, attempts)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("independent redelivery readback: %v %v", completion, err)
	}
	var count int
	if err = s.Pool.QueryRow(ctx, `SELECT count(*) FROM webhook_operations WHERE operation_id=$1`, receipt.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed receipt persisted: %d %v", count, err)
	}
	if err = s.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		got, err := sc.WebhookDAO().Endpoint(ctx, owner, endpoint.ID)
		if err == nil && got.ConfigVersion != endpoint.ConfigVersion {
			return fmt.Errorf("endpoint changed")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestWebhookSubscriptionReplacementRollsBackWithBinding(t *testing.T) {
	s, owner, endpoint, initial, _, _ := webhookBoundaryStore(t)
	ctx := t.Context()
	subID, bindingID, project := uuid.NewString(), uuid.NewString(), uuid.NewString()
	now := time.Now().UTC().Truncate(time.Microsecond)
	sub := wm.Subscription{ID: subID, EndpointID: endpoint.ID, ProjectID: project, Owner: owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: now, UpdatedAt: now}
	binding := wm.Binding{ID: bindingID, SubscriptionID: subID, EventType: "task.created", CreatedAt: now}
	completion, err := s.WriteWebhook(ctx, owner, uuid.NewString(), func(sc store.WebhookWriteScope) error {
		if err := sc.WebhookWriter().PutSubscription(ctx, sub); err != nil {
			return err
		}
		return sc.WebhookWriter().PutBinding(ctx, binding)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("subscription setup: %v %v", completion, err)
	}
	mustQueryExec(t, s, `CREATE FUNCTION reject_boundary_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1912',MESSAGE='binding rejected'; END $$; CREATE TRIGGER reject_boundary_binding BEFORE INSERT ON webhook_bindings FOR EACH ROW EXECUTE FUNCTION reject_boundary_binding()`)
	receipt := initial
	receipt.ID, receipt.Kind = uuid.NewString(), "endpoint.update"
	completion, err = s.WriteWebhook(ctx, owner, receipt.ID, func(sc store.WebhookWriteScope) error {
		dao := sc.WebhookWriter()
		locked, err := dao.LockEndpoint(ctx, owner, endpoint.ID)
		if err != nil {
			return err
		}
		if _, err = dao.LockSubscriptions(ctx, endpoint.ID); err != nil {
			return err
		}
		locked.Name, locked.ConfigVersion = "replacement", 2
		if err = dao.PutEndpoint(ctx, locked); err != nil {
			return err
		}
		sub.AuthorizationEpoch, sub.AuthorizationState, sub.UpdatedAt = 2, "confirmation_required", now.Add(time.Second)
		if err = dao.PutSubscription(ctx, sub); err != nil {
			return err
		}
		receipt.ConfigVersion = 2
		if err = dao.PutOperation(ctx, receipt); err != nil {
			return err
		}
		binding.DeletedAt = &now
		return dao.PutBinding(ctx, binding)
	})
	failed, state := store.DatabaseErrorFacts(err)
	if completion.Outcome != store.TransactionNotCommitted || !failed || state != "P1912" {
		t.Fatalf("binding failure: %v %q %v", completion, state, err)
	}
	if err = s.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		dao := sc.WebhookDAO()
		got, err := dao.Endpoint(ctx, owner, endpoint.ID)
		if err != nil {
			return err
		}
		subs, err := dao.Subscriptions(ctx, endpoint.ID)
		if err != nil {
			return err
		}
		bindings, err := dao.Bindings(ctx, subID)
		if err != nil {
			return err
		}
		if got.Name != endpoint.Name || got.ConfigVersion != 1 || len(subs) != 1 || subs[0].AuthorizationEpoch != 1 || subs[0].AuthorizationState != "active" || len(bindings) != 1 || bindings[0].DeletedAt != nil {
			return fmt.Errorf("binding failure changed related records")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = s.Pool.QueryRow(ctx, `SELECT count(*) FROM webhook_operations WHERE operation_id=$1`, receipt.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("subscription receipt persisted: %d %v", count, err)
	}
}

func TestWebhookSourceAndCaptureShareRollback(t *testing.T) {
	s := isolatedStore(t)
	ctx := t.Context()
	project, task, team := uuid.NewString(), uuid.NewString(), uuid.NewString()
	mustQueryExec(t, s, `INSERT INTO projects(id,name,repo_url) VALUES($1,'source','https://example.org')`, project)
	mustQueryExec(t, s, `INSERT INTO teams(id,name) VALUES($1,'source team')`, team)
	mustQueryExec(t, s, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, team)
	owner := wm.Owner{Kind: "personal", ID: uuid.NewString()}
	event, prepared := webhookBoundaryCapture(owner, uuid.NewString(), project, task)
	prepared.Matches = append(prepared.Matches, prepared.Matches[0])
	completion, err := s.WriteProject(ctx, project, func(sc store.ProjectWriteScope) error {
		if _, err := sc.TaskDAO().CreateTask(ctx, task, store.TaskWrite{Title: "must roll back", Status: model.TaskTodo}); err != nil {
			return err
		}
		return sc.CaptureDAO().SaveCapture(ctx, event, []store.WebhookCapturedDelivery{prepared})
	})
	failed, state := store.DatabaseErrorFacts(err)
	if completion.Outcome != store.TransactionNotCommitted || !failed || state != "23505" {
		t.Fatalf("capture duplicate match: %v %q %v", completion, state, err)
	}
	var tasks, events, deliveries, matches int
	if err = s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM tasks WHERE id=$1),(SELECT count(*) FROM webhook_events WHERE id=$2),(SELECT count(*) FROM webhook_deliveries WHERE id=$3),(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=$3)`, task, event.ID, prepared.ID).Scan(&tasks, &events, &deliveries, &matches); err != nil || tasks != 0 || events != 0 || deliveries != 0 || matches != 0 {
		t.Fatalf("source rollback: task=%d event=%d delivery=%d matches=%d error=%v", tasks, events, deliveries, matches, err)
	}
}

func TestWebhookTransactionEntryCompletionAndReadback(t *testing.T) {
	s, _, _, _, original, _ := webhookBoundaryStore(t)
	ctx := t.Context()
	cause := errors.New("callback refused transaction")
	for _, entry := range []struct {
		name string
		call func(string) (store.Completion, error)
	}{
		{"delivery", func(state string) (store.Completion, error) {
			return s.WriteWebhookDelivery(ctx, func(sc store.WebhookDeliveryScope) error {
				row, err := sc.LockDelivery(ctx, original.ID)
				if err != nil {
					return err
				}
				row.PreparationErrorCode = &state
				if err = sc.UpdateDelivery(ctx, row); err != nil {
					return err
				}
				return cause
			})
		}},
		{"retention", func(state string) (store.Completion, error) {
			return s.WriteWebhookRetention(ctx, func(sc store.WebhookRetentionScope) error {
				_, err := sc.RemoveExpiredPayload(ctx, original.ID, time.Now())
				if err != nil {
					return err
				}
				return cause
			})
		}},
	} {
		t.Run(entry.name, func(t *testing.T) {
			completion, err := entry.call("injected")
			if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, cause) {
				t.Fatalf("entry error: %v %v", completion, err)
			}
			var code *string
			var body []byte
			if err = s.Pool.QueryRow(ctx, `SELECT preparation_error_code,body FROM webhook_deliveries WHERE id=$1`, original.ID).Scan(&code, &body); err != nil || code != nil || !bytes.Equal(body, original.Body) {
				t.Fatalf("entry rollback: code=%v body=%q error=%v", code, body, err)
			}
		})
	}
	completion, err := s.WriteWebhookRetention(ctx, func(sc store.WebhookRetentionScope) error {
		_, err := sc.RemoveExpiredPayload(ctx, original.ID, time.Now())
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("retention entry commit: %v %v", completion, err)
	}
	if err = s.ObserveWebhookRetention(ctx, "delivery", original.ID); err != nil {
		t.Fatal(err)
	}
	var removed bool
	if err = s.Pool.QueryRow(ctx, `SELECT body IS NULL AND payload_removed_at IS NOT NULL FROM webhook_deliveries WHERE id=$1`, original.ID).Scan(&removed); err != nil || !removed {
		t.Fatalf("retention entry did not persist removal: %v %v", removed, err)
	}
}

func TestWebhookTransactionProcessExitHelper(t *testing.T) {
	mode := os.Getenv("DAYNIGHT_WEBHOOK_BOUNDARY_CHILD")
	if mode == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, err := Open(ctx, os.Getenv("DAYNIGHT_WEBHOOK_BOUNDARY_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	id, attemptID, token := os.Getenv("DAYNIGHT_WEBHOOK_BOUNDARY_DELIVERY"), os.Getenv("DAYNIGHT_WEBHOOK_BOUNDARY_ATTEMPT"), os.Getenv("DAYNIGHT_WEBHOOK_BOUNDARY_TOKEN")
	completion, err := s.WriteWebhookDelivery(ctx, func(sc store.WebhookDeliveryScope) error {
		now, err := sc.ObservedAt(ctx)
		if err != nil {
			return err
		}
		claimed, err := sc.Claim(ctx, 1, now, []string{token})
		if err != nil {
			return err
		}
		if len(claimed) != 1 || claimed[0].ID != id {
			return fmt.Errorf("child claim did not acquire expected delivery")
		}
		row := claimed[0]
		slot := int16(1)
		attempt := store.WebhookAttempt{ID: attemptID, DeliveryID: row.ID, EndpointID: row.EndpointID, Trigger: "automatic", LeaseToken: token, Generation: row.Generation, DestinationRevision: row.DestinationRevision, Sequence: 2, SigningKeyIDs: []string{uuid.NewString()}, AutomaticPlanSlot: &slot, ClaimedAt: *row.LeaseClaimedAt, AdmittedAt: now}
		if err = sc.InsertAttempt(ctx, attempt); err != nil {
			return err
		}
		row.AttemptSequence, row.AutomaticAttemptCount, row.CurrentAttemptID, row.LeasePlanSlot = 2, 1, &attemptID, &slot
		if err = sc.UpdateDelivery(ctx, row); err != nil {
			return err
		}
		// Exiting from the callback bypasses client cleanup. PostgreSQL must
		// discard both the attempt and its Delivery update on disconnect.
		if mode == "before_commit" {
			os.Exit(23)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("child completion: %v %v", completion, err)
	}
	if mode != "after_commit" {
		t.Fatalf("unknown boundary mode %q", mode)
	}
	os.Exit(23)
}

func TestWebhookTransactionSurvivesProcessExitAtCommitBoundary(t *testing.T) {
	for _, mode := range []string{"before_commit", "after_commit"} {
		t.Run(mode, func(t *testing.T) {
			s, _, _, _, original, _ := webhookBoundaryStore(t)
			attemptID, token := uuid.NewString(), uuid.NewString()
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWebhookTransactionProcessExitHelper$", "-test.count=1", "-test.timeout=12s")
			command.Env = append(os.Environ(), "DAYNIGHT_WEBHOOK_BOUNDARY_CHILD="+mode, "DAYNIGHT_WEBHOOK_BOUNDARY_URL="+s.Pool.Config().ConnString(), "DAYNIGHT_WEBHOOK_BOUNDARY_DELIVERY="+original.ID, "DAYNIGHT_WEBHOOK_BOUNDARY_ATTEMPT="+attemptID, "DAYNIGHT_WEBHOOK_BOUNDARY_TOKEN="+token)
			output, err := command.CombinedOutput()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 23 {
				t.Fatalf("child did not exit at boundary: %v %s", err, output)
			}
			completion, err := s.WriteWebhookDelivery(ctx, func(sc store.WebhookDeliveryScope) error {
				row, err := sc.LockDelivery(ctx, original.ID)
				if err != nil {
					return err
				}
				attempts, err := sc.LockAttempts(ctx, original.ID)
				if err != nil {
					return err
				}
				if !bytes.Equal(row.Body, original.Body) {
					return fmt.Errorf("process exit changed immutable body")
				}
				if mode == "before_commit" {
					if row.State != "pending" || row.LeaseToken != nil || row.CurrentAttemptID != nil || len(attempts) != 1 {
						return fmt.Errorf("uncommitted process writes persisted: %+v %+v", row, attempts)
					}
				} else if row.State != "leased" || row.LeaseToken == nil || *row.LeaseToken != token || row.CurrentAttemptID == nil || *row.CurrentAttemptID != attemptID || len(attempts) != 2 || attempts[1].ID != attemptID {
					return fmt.Errorf("committed process writes lost: %+v %+v", row, attempts)
				}
				return nil
			})
			if err != nil || completion.Outcome != store.TransactionCommitted {
				t.Fatalf("fresh process-boundary readback: %v %v", completion, err)
			}
		})
	}
}

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

func TestWebhookTransactionEntryLostCommitReplyIsUnknown(t *testing.T) {
	for _, kind := range []string{"delivery", "retention"} {
		t.Run(kind, func(t *testing.T) {
			base, _, _, _, delivery, _ := webhookBoundaryStore(t)
			fault := &maintenanceReplyFault{command: "commit", reached: make(chan struct{})}
			pool := maintenanceFaultPool(t, base, fault)
			s := &Store{Pool: pool}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			var completion store.Completion
			var err error
			if kind == "delivery" {
				completion, err = s.WriteWebhookDelivery(ctx, func(sc store.WebhookDeliveryScope) error {
					row, err := sc.LockDelivery(ctx, delivery.ID)
					if err != nil {
						return err
					}
					code := "commit reply was lost"
					row.PreparationErrorCode = &code
					return sc.UpdateDelivery(ctx, row)
				})
			} else {
				completion, err = s.WriteWebhookRetention(ctx, func(sc store.WebhookRetentionScope) error {
					_, err := sc.RemoveExpiredPayload(ctx, delivery.ID, time.Now())
					return err
				})
			}
			var failure *store.TransactionError
			if completion.Outcome != store.TransactionUnknown || !errors.As(err, &failure) || !failure.CommitAttempted || !fault.observed.Load() {
				t.Fatalf("entry completion: %v failure=%+v error=%v", completion, failure, err)
			}
			var applied bool
			query := `SELECT preparation_error_code='commit reply was lost' FROM webhook_deliveries WHERE id=$1`
			if kind == "retention" {
				query = `SELECT body IS NULL AND payload_removed_at IS NOT NULL FROM webhook_deliveries WHERE id=$1`
			}
			if err = base.Pool.QueryRow(ctx, query, delivery.ID).Scan(&applied); err != nil || !applied {
				t.Fatalf("independent committed state: %v %v", applied, err)
			}
			if kind == "retention" {
				if err = s.ObserveWebhookRetention(ctx, "delivery", delivery.ID); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}
