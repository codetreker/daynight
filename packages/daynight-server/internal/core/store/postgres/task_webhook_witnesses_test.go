package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWebhookFrozenThreadAudienceSurvivesDestinationChange(t *testing.T) {
	f := taskWebhookStore(t)
	var expected [5]string
	for _, binding := range f.bindings {
		if binding.EventType == protocol.ThreadPosted {
			expected = taskWebhookFixtureTuple(f.subscription, binding)
		}
	}
	if expected[1] == "" {
		t.Fatal("thread binding absent from fixture")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	prepared, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	var event store.WebhookCapturedEvent
	var deliveries []store.WebhookCapturedDelivery
	done := make(chan error, 1)
	go func() {
		completion, err := f.db.WriteThread(ctx, func(sc store.ThreadScope) error {
			message, err := taskWebhookInsertMessage(ctx, sc, f, "snapshot", nil)
			if err != nil {
				return err
			}
			audience, err := sc.CaptureDAO().FreezeAudience(ctx, f.project, []string{protocol.ThreadPosted})
			if err != nil {
				return err
			}
			event, deliveries, err = taskWebhookPrepared(protocol.Fact{Type: protocol.ThreadPosted, ProjectID: f.project, TaskID: f.task, MessageID: message.ID, CreatedAt: &message.CreatedAt, OccurredAt: message.CreatedAt}, audience)
			if err != nil {
				return err
			}
			close(prepared)
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			return sc.CaptureDAO().SaveCapture(ctx, event, deliveries)
		})
		if err == nil && completion.Outcome != store.TransactionCommitted {
			err = fmt.Errorf("source outcome %v", completion)
		}
		done <- err
	}()
	taskWebhookWait(t, ctx, prepared)
	if len(deliveries) != 1 || len(deliveries[0].Matches) != 1 {
		t.Fatalf("prepared audience: %+v", deliveries)
	}
	match := deliveries[0].Matches[0]
	actual := [5]string{match.SubscriptionID, match.BindingID, match.ProjectID, match.EventType, strconv.FormatInt(match.AuthorizationEpoch, 10)}
	if actual != expected {
		t.Fatalf("prepared audience differs from fixture: got=%v want=%v", actual, expected)
	}
	oldBinding := expected[1]
	now := time.Now().UTC().Truncate(time.Microsecond)
	changed := f.endpoint
	changed.ConfigVersion, changed.DestinationRevision = 2, 2
	changed.DestinationConfiguration = []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://example.org/new"}}`)
	newSubscription := f.subscription
	newSubscription.ID = uuid.NewString()
	completion, err := f.db.WriteWebhook(ctx, f.owner, uuid.NewString(), func(sc store.WebhookWriteScope) error {
		dao := sc.WebhookWriter()
		if err := dao.PutEndpoint(ctx, changed); err != nil {
			return err
		}
		if err := dao.PutSubscription(ctx, newSubscription); err != nil {
			return err
		}
		if err := dao.PutBinding(ctx, wm.Binding{ID: uuid.NewString(), SubscriptionID: newSubscription.ID, EventType: protocol.ThreadPosted, CreatedAt: now}); err != nil {
			return err
		}
		for _, binding := range f.bindings {
			if binding.ID == oldBinding {
				binding.DeletedAt = &now
				return dao.PutBinding(ctx, binding)
			}
		}
		return errors.New("frozen binding missing")
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("configuration commit: %v %v", completion, err)
	}
	scan, err := f.db.ScanWebhookConfigGC(ctx, nil, 500)
	if err != nil {
		t.Fatal(err)
	}
	var candidate *store.WebhookConfigGCCandidate
	for i := range scan.Candidates {
		if scan.Candidates[i].ID == oldBinding {
			candidate = &scan.Candidates[i]
		}
	}
	if candidate == nil {
		t.Fatal("retired frozen binding absent from scan")
	}
	passed, err := f.db.WebhookConfigGCBarrierPassed(ctx, scan.Barrier)
	if err != nil || passed {
		t.Fatalf("open source barrier: passed=%v error=%v", passed, err)
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var fact, body, bodyHash, proofHash, destination []byte
	var count, currentRevision, frozenRevision int64
	if err = f.db.Pool.QueryRow(ctx, `SELECT e.fact_bytes,d.body,d.body_sha256,d.original_match_sha256,d.original_match_count,d.destination_revision,ep.destination_revision,d.destination_configuration FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id JOIN webhook_endpoints ep ON ep.id=d.endpoint_id WHERE e.id=$1`, event.ID).Scan(&fact, &body, &bodyHash, &proofHash, &count, &frozenRevision, &currentRevision, &destination); err != nil {
		t.Fatal(err)
	}
	if count != 1 || frozenRevision != 1 || currentRevision != 2 || !bytes.Equal(fact, event.FactBytes) || !bytes.Equal(body, deliveries[0].Body) || !bytes.Equal(bodyHash, deliveries[0].BodySHA256) || !bytes.Equal(proofHash, deliveries[0].OriginalMatchSHA256) || !bytes.Equal(destination, f.endpoint.DestinationConfiguration) {
		t.Fatal("frozen source bytes, destination or proof changed")
	}
	var subscriptions int
	if err = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM webhook_subscriptions WHERE endpoint_id=$1 AND deleted_at IS NULL`, f.endpoint.ID).Scan(&subscriptions); err != nil || subscriptions != 2 {
		t.Fatalf("post-freeze subscription count=%d error=%v", subscriptions, err)
	}
	var subscription, binding, project, kind string
	var epoch int64
	if err = f.db.Pool.QueryRow(ctx, `SELECT subscription_id::text,binding_id::text,project_id::text,event_type,authorization_epoch FROM webhook_delivery_matches WHERE delivery_id=$1`, deliveries[0].ID).Scan(&subscription, &binding, &project, &kind, &epoch); err != nil {
		t.Fatal(err)
	}
	actual = [5]string{subscription, binding, project, kind, strconv.FormatInt(epoch, 10)}
	if actual != expected {
		t.Fatalf("frozen match differs from fixture: got=%v want=%v", actual, expected)
	}
	expectedProof, err := json.Marshal([][5]string{expected})
	if err != nil {
		t.Fatal(err)
	}
	expectedHash := sha256.Sum256(expectedProof)
	if !bytes.Equal(proofHash, expectedHash[:]) {
		t.Fatal("frozen proof hash differs from fixture tuple")
	}
	completion, err = f.db.WriteWebhookConfigGC(ctx, *candidate, func(sc store.WebhookConfigGCScope) error {
		facts, err := sc.LockConfigCandidate(ctx, *candidate)
		if err == nil && (!facts.Present || !facts.Retired || !facts.Referenced) {
			return fmt.Errorf("frozen proof was not rechecked: %+v", facts)
		}
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("capture proof recheck: %v %v", completion, err)
	}
	present, err := f.db.ObserveWebhookConfigGC(ctx, *candidate)
	if err != nil || !present {
		t.Fatalf("captured binding lost: %v %v", present, err)
	}
}

func TestWebhookStatusAndPauseShareFreeze(t *testing.T) {
	f := taskWebhookStore(t)
	expected := make(map[[2]string][][5]string)
	for _, binding := range f.bindings {
		if binding.EventType == protocol.StatusChanged || binding.EventType == protocol.Paused {
			key := [2]string{f.endpoint.ID, binding.EventType}
			expected[key] = append(expected[key], taskWebhookFixtureTuple(f.subscription, binding))
		}
	}
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)
	_, second, key, receipt := webhookStoredFixture(t)
	second.Owner, receipt.Owner, receipt.ActorID = f.owner, f.owner, f.user
	completion, err := f.db.WriteWebhook(ctx, f.owner, receipt.ID, func(sc store.WebhookWriteScope) error {
		dao := sc.WebhookWriter()
		if err := dao.PutEndpoint(ctx, second); err != nil {
			return err
		}
		if err := dao.PutSigningKey(ctx, key); err != nil {
			return err
		}
		for _, endpoint := range []string{f.endpoint.ID, second.ID} {
			sub := f.subscription
			sub.ID, sub.EndpointID = uuid.NewString(), endpoint
			if err := dao.PutSubscription(ctx, sub); err != nil {
				return err
			}
			for _, kind := range []string{protocol.StatusChanged, protocol.Paused} {
				binding := wm.Binding{ID: uuid.NewString(), SubscriptionID: sub.ID, EventType: kind, CreatedAt: now}
				if err := dao.PutBinding(ctx, binding); err != nil {
					return err
				}
				key := [2]string{endpoint, kind}
				expected[key] = append(expected[key], taskWebhookFixtureTuple(sub, binding))
			}
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("audience fixture: %v %v", completion, err)
	}
	completion, err = f.db.WriteProject(ctx, f.project, func(sc store.ProjectWriteScope) error {
		changed, err := sc.TaskDAO().UpdateTask(ctx, f.task, store.TaskWrite{Title: "source", Status: model.TaskInProgress, Properties: model.TaskProperties{"paused": json.RawMessage(`true`)}})
		if err != nil {
			return err
		}
		audience, err := sc.CaptureDAO().FreezeAudience(ctx, f.project, []string{protocol.StatusChanged, protocol.Paused})
		if err != nil {
			return err
		}
		for _, fact := range []protocol.Fact{
			{Type: protocol.StatusChanged, ProjectID: f.project, TaskID: f.task, TaskVersion: changed.Version, OccurredAt: changed.UpdatedAt, PreviousStatus: "todo", Status: "in_progress"},
			{Type: protocol.Paused, ProjectID: f.project, TaskID: f.task, TaskVersion: changed.Version, OccurredAt: changed.UpdatedAt, Paused: true},
		} {
			event, deliveries, err := taskWebhookPrepared(fact, audience)
			if err != nil {
				return err
			}
			if err = sc.CaptureDAO().SaveCapture(ctx, event, deliveries); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("status capture: %v %v", completion, err)
	}
	var version int64
	var events, deliveries, matches int
	if err = f.db.Pool.QueryRow(ctx, `SELECT t.version,(SELECT count(*) FROM webhook_events WHERE task_id=t.id),(SELECT count(*) FROM webhook_deliveries WHERE event_id IN(SELECT id FROM webhook_events WHERE task_id=t.id)),(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id IN(SELECT id FROM webhook_deliveries WHERE event_id IN(SELECT id FROM webhook_events WHERE task_id=t.id))) FROM tasks t WHERE id=$1`, f.task).Scan(&version, &events, &deliveries, &matches); err != nil {
		t.Fatal(err)
	}
	if version != 2 || events != 2 || deliveries != 4 || matches != 6 {
		t.Fatalf("version=%d events=%d deliveries=%d matches=%d", version, events, deliveries, matches)
	}
	rows, err := f.db.Pool.Query(ctx, `SELECT d.id::text,d.endpoint_id::text,d.event_type,d.original_match_count,d.original_match_sha256 FROM webhook_deliveries d WHERE event_id IN(SELECT id FROM webhook_events WHERE task_id=$1) ORDER BY id`, f.task)
	if err != nil {
		t.Fatal(err)
	}
	type proofRow struct {
		id, endpoint, kind string
		count              int64
		hash               []byte
	}
	var proofs []proofRow
	for rows.Next() {
		var p proofRow
		if err = rows.Scan(&p.id, &p.endpoint, &p.kind, &p.count, &p.hash); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		proofs = append(proofs, p)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	for _, p := range proofs {
		rows, err := f.db.Pool.Query(ctx, `SELECT subscription_id::text,binding_id::text,project_id::text,event_type,authorization_epoch FROM webhook_delivery_matches WHERE delivery_id=$1 ORDER BY subscription_id,binding_id`, p.id)
		if err != nil {
			t.Fatal(err)
		}
		var tuples [][5]string
		for rows.Next() {
			var a, b, project, kind string
			var epoch int64
			if err = rows.Scan(&a, &b, &project, &kind, &epoch); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			tuples = append(tuples, [5]string{a, b, project, kind, strconv.FormatInt(epoch, 10)})
		}
		rows.Close()
		if err = rows.Err(); err != nil {
			t.Fatal(err)
		}
		want := expected[[2]string{p.endpoint, p.kind}]
		sort.Slice(want, func(i, j int) bool {
			if want[i][0] != want[j][0] {
				return want[i][0] < want[j][0]
			}
			return want[i][1] < want[j][1]
		})
		if !slices.Equal(tuples, want) {
			t.Fatalf("delivery %s audience differs from fixture: got=%v want=%v", p.id, tuples, want)
		}
		proof, err := json.Marshal(want)
		if err != nil {
			t.Fatal(err)
		}
		hash := sha256.Sum256(proof)
		if p.count != int64(len(want)) || !bytes.Equal(p.hash, hash[:]) {
			t.Fatal("persisted delivery proof differs from fixture matches")
		}
	}
}

func TestWebhookCommittedFactsSurviveLostSourceReceipt(t *testing.T) {
	f := taskWebhookStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	fault := &maintenanceReplyFault{command: "commit", reached: make(chan struct{})}
	uncertain := &Store{Pool: maintenanceFaultPool(t, f.db, fault)}
	var event store.WebhookCapturedEvent
	completion, err := uncertain.WriteProject(ctx, f.project, func(sc store.ProjectWriteScope) error {
		changed, err := sc.TaskDAO().UpdateTask(ctx, f.task, store.TaskWrite{Title: "source", Status: model.TaskInProgress})
		if err != nil {
			return err
		}
		audience, err := sc.CaptureDAO().FreezeAudience(ctx, f.project, []string{protocol.StatusChanged})
		if err != nil {
			return err
		}
		var deliveries []store.WebhookCapturedDelivery
		event, deliveries, err = taskWebhookPrepared(protocol.Fact{Type: protocol.StatusChanged, ProjectID: f.project, TaskID: f.task, TaskVersion: changed.Version, OccurredAt: changed.UpdatedAt, PreviousStatus: "todo", Status: "in_progress"}, audience)
		if err != nil {
			return err
		}
		return sc.CaptureDAO().SaveCapture(ctx, event, deliveries)
	})
	var failure *store.TransactionError
	if completion.Outcome != store.TransactionUnknown || !errors.As(err, &failure) || !failure.CommitAttempted || !fault.observed.Load() {
		t.Fatalf("source completion: %v failure=%+v error=%v", completion, failure, err)
	}
	var body, hash, proof []byte
	var status, id, subscription, binding, project, kind string
	var events, deliveries, matches int
	var epoch int64
	if err = f.db.Pool.QueryRow(ctx, `SELECT t.status,e.id::text,d.body,d.body_sha256,d.original_match_sha256,(SELECT count(*) FROM webhook_events WHERE task_id=t.id),(SELECT count(*) FROM webhook_deliveries WHERE event_id=e.id),(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=d.id),m.subscription_id::text,m.binding_id::text,m.project_id::text,m.event_type,m.authorization_epoch FROM tasks t JOIN webhook_events e ON e.task_id=t.id JOIN webhook_deliveries d ON d.event_id=e.id JOIN webhook_delivery_matches m ON m.delivery_id=d.id WHERE t.id=$1`, f.task).Scan(&status, &id, &body, &hash, &proof, &events, &deliveries, &matches, &subscription, &binding, &project, &kind, &epoch); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	decoded, _, decodeErr := protocol.Decode(body)
	proofBytes, err := json.Marshal([][5]string{{subscription, binding, project, kind, strconv.FormatInt(epoch, 10)}})
	if err != nil {
		t.Fatal(err)
	}
	proofHash := sha256.Sum256(proofBytes)
	if status != "in_progress" || id != event.ID || decoded != id || decodeErr != nil || events != 1 || deliveries != 1 || matches != 1 || !bytes.Equal(sum[:], hash) || !bytes.Equal(proofHash[:], proof) {
		t.Fatalf("independent source/capture readback: status=%s id=%s counts=%d/%d/%d decode=%v", status, id, events, deliveries, matches, decodeErr)
	}
}

func TestWebhookDeferredStepFailureRollsBackSourceAndCapture(t *testing.T) {
	f := taskWebhookStore(t)
	ctx := t.Context()
	for i, id := range []string{"00000001", "00000002"} {
		completion, err := f.db.WriteProject(ctx, f.project, func(sc store.ProjectWriteScope) error {
			now, err := sc.TaskDAO().ObservedAt(ctx)
			if err != nil {
				return err
			}
			step := model.TaskStep{ID: id, Position: int64(i), Title: []string{"first", "second"}[i], Status: model.TaskStepTodo, CreatedAt: now, UpdatedAt: now}
			if err = sc.TaskDAO().InsertTaskStep(ctx, f.task, step); err != nil {
				return err
			}
			if err = sc.TaskDAO().TouchTask(ctx, f.task, now); err != nil {
				return err
			}
			header, err := sc.TaskDAO().TaskHeader(ctx, f.task)
			if err != nil {
				return err
			}
			audience, err := sc.CaptureDAO().FreezeAudience(ctx, f.project, []string{protocol.StepUpdated})
			if err != nil {
				return err
			}
			event, deliveries, err := taskWebhookPrepared(protocol.Fact{Type: protocol.StepUpdated, ProjectID: f.project, TaskID: f.task, TaskVersion: header.Version, OccurredAt: now, StepID: id, Action: "created"}, audience)
			if err != nil {
				return err
			}
			return sc.CaptureDAO().SaveCapture(ctx, event, deliveries)
		})
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("step fixture: %v %v", completion, err)
		}
	}
	mustQueryExec(t, f.db, `CREATE FUNCTION task_capture_break_position() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE task_steps SET position=0 WHERE task_id=NEW.task_id AND id='00000002'; RETURN NEW; END $$;CREATE TRIGGER task_capture_break_position AFTER INSERT ON webhook_events FOR EACH ROW EXECUTE FUNCTION task_capture_break_position()`)
	completion, err := f.db.WriteProject(ctx, f.project, func(sc store.ProjectWriteScope) error {
		steps, err := sc.TaskDAO().TaskSteps(ctx, f.task)
		if err != nil {
			return err
		}
		now, err := sc.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		changed := steps[0]
		changed.Title, changed.UpdatedAt = "changed", now
		if err = sc.TaskDAO().UpdateTaskStep(ctx, f.task, changed); err != nil {
			return err
		}
		if err = sc.TaskDAO().TouchTask(ctx, f.task, now); err != nil {
			return err
		}
		header, err := sc.TaskDAO().TaskHeader(ctx, f.task)
		if err != nil {
			return err
		}
		audience, err := sc.CaptureDAO().FreezeAudience(ctx, f.project, []string{protocol.StepUpdated})
		if err != nil {
			return err
		}
		event, deliveries, err := taskWebhookPrepared(protocol.Fact{Type: protocol.StepUpdated, ProjectID: f.project, TaskID: f.task, TaskVersion: header.Version, OccurredAt: now, StepID: changed.ID, Action: "updated", ChangedFields: []string{"title"}}, audience)
		if err != nil {
			return err
		}
		return sc.CaptureDAO().SaveCapture(ctx, event, deliveries)
	})
	var failure *store.TransactionError
	failed, state := store.DatabaseErrorFacts(err)
	if completion.Outcome != store.TransactionUnknown || !errors.As(err, &failure) || !failure.CommitAttempted || !failed || state != "23505" {
		t.Fatalf("deferred step commit: %v failure=%+v state=%s error=%v", completion, failure, state, err)
	}
	var version int64
	var title string
	var events, positions int
	if err = f.db.Pool.QueryRow(ctx, `SELECT t.version,(SELECT title FROM task_steps WHERE task_id=t.id AND id='00000001'),(SELECT count(*) FROM webhook_events WHERE task_id=t.id),(SELECT count(DISTINCT position) FROM task_steps WHERE task_id=t.id) FROM tasks t WHERE id=$1`, f.task).Scan(&version, &title, &events, &positions); err != nil {
		t.Fatal(err)
	}
	if version != 3 || title != "first" || events != 2 || positions != 2 {
		t.Fatalf("rollback version=%d title=%s events=%d positions=%d", version, title, events, positions)
	}
}

func TestWebhookThreadCaptureDoesNotReverseProjectLock(t *testing.T) {
	f := taskWebhookStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	frozen, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	threadDone, deleteDone := make(chan error, 1), make(chan error, 1)
	var sourcePID uint32
	go func() {
		completion, err := f.db.WriteThread(ctx, func(sc store.ThreadScope) error {
			message, err := taskWebhookInsertMessage(ctx, sc, f, "lock order", nil)
			if err != nil {
				return err
			}
			audience, err := sc.CaptureDAO().FreezeAudience(ctx, f.project, []string{protocol.ThreadPosted})
			if err != nil {
				return err
			}
			sourcePID = sc.(*ThreadTx).tx.Conn().PgConn().PID()
			close(frozen)
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			event, deliveries, err := taskWebhookPrepared(protocol.Fact{Type: protocol.ThreadPosted, ProjectID: f.project, TaskID: f.task, MessageID: message.ID, CreatedAt: &message.CreatedAt, OccurredAt: message.CreatedAt}, audience)
			if err != nil {
				return err
			}
			return sc.CaptureDAO().SaveCapture(ctx, event, deliveries)
		})
		if err == nil && completion.Outcome != store.TransactionCommitted {
			err = fmt.Errorf("thread source outcome %v", completion)
		}
		threadDone <- err
	}()
	taskWebhookWait(t, ctx, frozen)
	go func() {
		completion, err := f.db.WriteProject(ctx, f.project, func(sc store.ProjectWriteScope) error {
			tombstone, err := sc.TaskDAO().DeleteTask(ctx, f.task, true)
			if err != nil {
				return err
			}
			audience, err := sc.CaptureDAO().FreezeAudience(ctx, f.project, []string{protocol.Deleted})
			if err != nil {
				return err
			}
			event, deliveries, err := taskWebhookPrepared(protocol.Fact{Type: protocol.Deleted, ProjectID: f.project, TaskID: f.task, TaskVersion: tombstone.Version, OccurredAt: tombstone.DeletedAt, DeletedAt: &tombstone.DeletedAt}, audience)
			if err != nil {
				return err
			}
			return sc.CaptureDAO().SaveCapture(ctx, event, deliveries)
		})
		if err == nil && completion.Outcome != store.TransactionCommitted {
			err = fmt.Errorf("deletion outcome %v", completion)
		}
		deleteDone <- err
	}()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		if err := f.db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock')`, int32(sourcePID)).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	close(release)
	for _, done := range []<-chan error{threadDone, deleteDone} {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	var threads, deletes int
	var version int64
	if err := f.db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_events WHERE task_id=$1 AND event_type='task.thread_posted'),(SELECT count(*) FROM webhook_events WHERE task_id=$1 AND event_type='task.deleted'),(SELECT version FROM tasks WHERE id=$1)`, f.task).Scan(&threads, &deletes, &version); err != nil {
		t.Fatal(err)
	}
	if threads != 1 || deletes != 1 || version != 2 {
		t.Fatalf("thread=%d deletion=%d version=%d", threads, deletes, version)
	}
}

func TestWebhookCaptureSurvivesProcessExit(t *testing.T) {
	if os.Getenv("DAYNIGHT_TASK_CAPTURE_EXIT_CHILD") == "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		db, err := Open(ctx, os.Getenv("DAYNIGHT_TASK_CAPTURE_EXIT_DB"))
		if err != nil {
			t.Fatal(err)
		}
		project, task := os.Getenv("DAYNIGHT_TASK_CAPTURE_EXIT_PROJECT"), os.Getenv("DAYNIGHT_TASK_CAPTURE_EXIT_TASK")
		completion, err := db.WriteProject(ctx, project, func(sc store.ProjectWriteScope) error {
			changed, err := sc.TaskDAO().UpdateTask(ctx, task, store.TaskWrite{Title: "source", Status: model.TaskInProgress})
			if err != nil {
				return err
			}
			audience, err := sc.CaptureDAO().FreezeAudience(ctx, project, []string{protocol.StatusChanged})
			if err != nil {
				return err
			}
			event, deliveries, err := taskWebhookPrepared(protocol.Fact{Type: protocol.StatusChanged, ProjectID: project, TaskID: task, TaskVersion: changed.Version, OccurredAt: changed.UpdatedAt, PreviousStatus: "todo", Status: "in_progress"}, audience)
			if err != nil {
				return err
			}
			return sc.CaptureDAO().SaveCapture(ctx, event, deliveries)
		})
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("child source commit: %v %v", completion, err)
		}
		os.Exit(0)
	}
	f := taskWebhookStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWebhookCaptureSurvivesProcessExit$", "-test.count=1", "-test.timeout=12s")
	command.Env = append(os.Environ(), "DAYNIGHT_TASK_CAPTURE_EXIT_CHILD=1", "DAYNIGHT_TASK_CAPTURE_EXIT_DB="+f.db.Pool.Config().ConnString(), "DAYNIGHT_TASK_CAPTURE_EXIT_PROJECT="+f.project, "DAYNIGHT_TASK_CAPTURE_EXIT_TASK="+f.task)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("child source exit: %v %s", err, output)
	}
	reopened, err := pgxpool.New(ctx, f.db.Pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	var id, status string
	var version int64
	var body, hash []byte
	var matches int
	if err = reopened.QueryRow(ctx, `SELECT t.status,t.version,e.id::text,d.body,d.body_sha256,(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=d.id) FROM tasks t JOIN webhook_events e ON e.task_id=t.id JOIN webhook_deliveries d ON d.event_id=e.id WHERE t.id=$1`, f.task).Scan(&status, &version, &id, &body, &hash, &matches); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	decoded, _, err := protocol.Decode(body)
	if err != nil || decoded != id || status != "in_progress" || version != 2 || matches != 1 || !bytes.Equal(sum[:], hash) {
		t.Fatalf("reopened source/capture: status=%s version=%d id=%s matches=%d decode=%v", status, version, id, matches, err)
	}
}

func TestWebhookThreadSameTimestampOrderedIDAndReply(t *testing.T) {
	f := taskWebhookStore(t)
	ctx := t.Context()
	var first, second model.ThreadMessage
	completion, err := f.db.WriteThread(ctx, func(sc store.ThreadScope) error {
		var err error
		first, err = taskWebhookInsertMessage(ctx, sc, f, "original", nil)
		if err != nil {
			return err
		}
		return taskWebhookSaveThread(ctx, sc, f, first)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("first capture: %v %v", completion, err)
	}
	mustQueryExec(t, f.db, `CREATE FUNCTION task_capture_same_time() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.created_at:=(SELECT last_created_at FROM task_threads WHERE task_id=NEW.task_id);NEW.message_id:='ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid;RETURN NEW;END $$;CREATE TRIGGER task_capture_same_time BEFORE INSERT ON task_thread_messages FOR EACH ROW EXECUTE FUNCTION task_capture_same_time()`)
	completion, err = f.db.WriteThread(ctx, func(sc store.ThreadScope) error {
		var err error
		second, err = taskWebhookInsertMessage(ctx, sc, f, "reply", &first.ID)
		if err != nil {
			return err
		}
		return taskWebhookSaveThread(ctx, sc, f, second)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("reply capture: %v %v", completion, err)
	}
	if !first.CreatedAt.Equal(second.CreatedAt) || first.ID >= second.ID || second.ReplyTo == nil || *second.ReplyTo != first.ID {
		t.Fatalf("same timestamp messages: %+v %+v", first, second)
	}
	var body []byte
	var version int64
	var sourceVersion *int64
	if err = f.db.Pool.QueryRow(ctx, `SELECT d.body,e.task_version,(SELECT version FROM tasks WHERE id=$1) FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.message_id=$2`, f.task, second.ID).Scan(&body, &sourceVersion, &version); err != nil {
		t.Fatal(err)
	}
	_, fact, err := protocol.Decode(body)
	if err != nil || sourceVersion != nil || version != 1 || fact.MessageID != second.ID || fact.CreatedAt == nil || !fact.CreatedAt.Equal(first.CreatedAt) || fact.ReplyTo == nil || *fact.ReplyTo != first.ID {
		t.Fatalf("stored reply fact=%+v version=%d source=%v error=%v", fact, version, sourceVersion, err)
	}
}

func TestWebhookDeletionBeforeThreadRejectsWithoutCapture(t *testing.T) {
	f := taskWebhookStore(t)
	ctx := t.Context()
	completion, err := f.db.WriteProject(ctx, f.project, func(sc store.ProjectWriteScope) error {
		tombstone, err := sc.TaskDAO().DeleteTask(ctx, f.task, true)
		if err != nil {
			return err
		}
		audience, err := sc.CaptureDAO().FreezeAudience(ctx, f.project, []string{protocol.Deleted})
		if err != nil {
			return err
		}
		event, deliveries, err := taskWebhookPrepared(protocol.Fact{Type: protocol.Deleted, ProjectID: f.project, TaskID: f.task, TaskVersion: tombstone.Version, OccurredAt: tombstone.DeletedAt, DeletedAt: &tombstone.DeletedAt}, audience)
		if err != nil {
			return err
		}
		return sc.CaptureDAO().SaveCapture(ctx, event, deliveries)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("deletion capture: %v %v", completion, err)
	}
	refusal := errors.New("deleted task cannot be a thread source")
	completion, err = f.db.WriteThread(ctx, func(sc store.ThreadScope) error {
		presence, err := sc.TaskDAO().LockTaskPresence(ctx, f.project, f.task)
		if err != nil {
			return err
		}
		if presence.DeletedAt != nil {
			return refusal
		}
		message, err := taskWebhookInsertMessage(ctx, sc, f, "rejected", nil)
		if err != nil {
			return err
		}
		return taskWebhookSaveThread(ctx, sc, f, message)
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, refusal) {
		t.Fatalf("deleted source presence: %v %v", completion, err)
	}
	var deleted, thread, messages, heads int
	if err = f.db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_events WHERE task_id=$1 AND event_type='task.deleted'),(SELECT count(*) FROM webhook_events WHERE task_id=$1 AND event_type='task.thread_posted'),(SELECT count(*) FROM task_thread_messages WHERE task_id=$1),(SELECT count(*) FROM task_threads WHERE task_id=$1)`, f.task).Scan(&deleted, &thread, &messages, &heads); err != nil {
		t.Fatal(err)
	}
	if deleted != 1 || thread != 0 || messages != 0 || heads != 0 {
		t.Fatalf("deleted=%d thread=%d messages=%d heads=%d", deleted, thread, messages, heads)
	}
}

func TestWebhookConfigGCRespectsReceiptAndReclaimsTombstone(t *testing.T) {
	f := taskWebhookStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	now := time.Now().UTC().Truncate(time.Microsecond)
	completion, err := f.db.WriteWebhook(ctx, f.owner, uuid.NewString(), func(sc store.WebhookWriteScope) error {
		dao := sc.WebhookWriter()
		endpoint := f.endpoint
		endpoint.DeletedAt = &now
		endpoint.ConfigVersion++
		endpoint.Enabled = false
		if err := dao.PutEndpoint(ctx, endpoint); err != nil {
			return err
		}
		subscription := f.subscription
		subscription.DeletedAt, subscription.UpdatedAt = &now, now
		if err := dao.PutSubscription(ctx, subscription); err != nil {
			return err
		}
		for _, binding := range f.bindings {
			binding.DeletedAt = &now
			if err := dao.PutBinding(ctx, binding); err != nil {
				return err
			}
		}
		if err := dao.DeleteSigningKeys(ctx, f.endpoint.ID); err != nil {
			return err
		}
		receipt := f.receipt
		receipt.ID, receipt.Kind, receipt.ConfigVersion = uuid.NewString(), "endpoint.delete", endpoint.ConfigVersion
		return dao.PutOperation(ctx, receipt)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("endpoint tombstone: %v %v", completion, err)
	}
	remaining := make(map[store.WebhookConfigGCCandidate]struct{})
	for _, binding := range f.bindings {
		remaining[store.WebhookConfigGCCandidate{Order: 2, Kind: "binding", ID: binding.ID, EndpointID: f.endpoint.ID, ProjectID: f.project, Owner: f.owner}] = struct{}{}
	}
	remaining[store.WebhookConfigGCCandidate{Order: 3, Kind: "subscription", ID: f.subscription.ID, EndpointID: f.endpoint.ID, ProjectID: f.project, Owner: f.owner}] = struct{}{}
	remaining[store.WebhookConfigGCCandidate{Order: 4, Kind: "wait", ID: f.endpoint.ID, EndpointID: f.endpoint.ID, Owner: f.owner, Revision: f.endpoint.DestinationRevision}] = struct{}{}
	for len(remaining) > 0 {
		scan, err := f.db.ScanWebhookConfigGC(ctx, nil, 500)
		if err != nil {
			t.Fatal(err)
		}
		if len(scan.Candidates) == 0 {
			t.Fatalf("retired fixture records not discoverable: %v", remaining)
		}
		for _, candidate := range scan.Candidates {
			if _, exists := remaining[candidate]; !exists {
				t.Fatalf("unexpected collection candidate: %+v", candidate)
			}
			completion, err := f.db.WriteWebhookConfigGC(ctx, candidate, func(sc store.WebhookConfigGCScope) error {
				facts, err := sc.LockConfigCandidate(ctx, candidate)
				if err != nil {
					return err
				}
				if !facts.Present || !facts.Retired || facts.Referenced {
					return fmt.Errorf("retired fixture records changed: %+v %+v", candidate, facts)
				}
				removed, err := sc.DeleteConfigCandidate(ctx, candidate)
				if err == nil && !removed {
					return fmt.Errorf("retired fixture record not removed: %+v", candidate)
				}
				return err
			})
			if err != nil || completion.Outcome != store.TransactionCommitted {
				t.Fatalf("retired record collection: %v %v", completion, err)
			}
			present, err := f.db.ObserveWebhookConfigGC(ctx, candidate)
			if err != nil || present {
				t.Fatalf("retired record survived collection: %+v present=%v error=%v", candidate, present, err)
			}
			delete(remaining, candidate)
		}
	}
	candidate := store.WebhookConfigGCCandidate{Order: 5, Kind: "endpoint", ID: f.endpoint.ID, EndpointID: f.endpoint.ID, Owner: f.owner}
	completion, err = f.db.WriteWebhookConfigGC(ctx, candidate, func(sc store.WebhookConfigGCScope) error {
		facts, err := sc.LockConfigCandidate(ctx, candidate)
		if err == nil && (!facts.Present || !facts.Retired || !facts.Referenced) {
			return fmt.Errorf("receipt did not retain tombstone: %+v", facts)
		}
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("receipt recheck: %v %v", completion, err)
	}
	mustQueryExec(t, f.db, `UPDATE webhook_operations SET recorded_at=now()-interval '31 days',expires_at=now()-interval '1 day' WHERE endpoint_id=$1`, f.endpoint.ID)
	identities, err := f.db.ExpiredWebhookReceipts(ctx, nil, 500)
	if err != nil {
		t.Fatal(err)
	}
	if len(identities) != 2 {
		t.Fatalf("expired operation count=%d", len(identities))
	}
	for _, identity := range identities {
		completion, err = f.db.WriteWebhookReceiptGC(ctx, identity, func(sc store.WebhookReceiptGCScope) error {
			expires, observed, present, err := sc.ReceiptExpiry(ctx, identity)
			if err != nil {
				return err
			}
			if !present || expires.After(observed) {
				return errors.New("expired operation unavailable")
			}
			removed, err := sc.DeleteReceipt(ctx, identity)
			if err == nil && !removed {
				return errors.New("expired receipt not removed")
			}
			return err
		})
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("receipt collection: %v %v", completion, err)
		}
	}
	scan, err := f.db.ScanWebhookConfigGC(ctx, nil, 500)
	if err != nil || len(scan.Candidates) != 1 || scan.Candidates[0] != candidate {
		t.Fatalf("receipt release did not expose endpoint: %+v error=%v", scan.Candidates, err)
	}
	completion, err = f.db.WriteWebhookConfigGC(ctx, candidate, func(sc store.WebhookConfigGCScope) error {
		facts, err := sc.LockConfigCandidate(ctx, candidate)
		if err != nil {
			return err
		}
		if !facts.Present || !facts.Retired || facts.Referenced {
			return fmt.Errorf("receipt release not observed: %+v", facts)
		}
		removed, err := sc.DeleteConfigCandidate(ctx, candidate)
		if err == nil && !removed {
			return errors.New("unreferenced endpoint not reclaimed")
		}
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("tombstone collection: %v %v", completion, err)
	}
	present, err := f.db.ObserveWebhookConfigGC(ctx, candidate)
	if err != nil || present {
		t.Fatalf("endpoint tombstone survived: %v %v", present, err)
	}
}
