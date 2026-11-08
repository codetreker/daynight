package webhook_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

type captureFixture struct {
	ctx       context.Context
	db        *postgres.Store
	principal model.Principal
	project   string
	capture   *webhook.Capturer
}

func newCaptureFixture(t *testing.T, subscriptions int) *captureFixture {
	return newCaptureFixtureForProject(t, subscriptions, uuid.NewString())
}

func newCaptureFixtureForProject(t *testing.T, subscriptions int, project string) *captureFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	user, session, team := uuid.NewString(), uuid.NewString(), uuid.NewString()
	token := sha256.Sum256([]byte(session))
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$1::uuid::text,now(),now())`, []any{user}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, user, token[:]}},
		{`INSERT INTO teams(id,name) VALUES($1,'capture')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'capture','https://example.test/repo')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
	keys, err := secretbox.Parse([]byte(`{"activeKeyId":"primary","keys":{"primary":"` + key + `"}}`))
	if err != nil {
		t.Fatal(err)
	}
	principal := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: session}
	svc := &webhook.Service{DB: db, Keys: keys, ConfigurationExpansionAvailable: true}
	name, enabled := "Receiver", true
	m := webhook.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: user, RequestSHA256: strings.Repeat("a", 64), Name: &name, Enabled: &enabled, Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/hook"}, HasSubscriptions: true}
	for i := 0; i < subscriptions; i++ {
		m.Subscriptions = append(m.Subscriptions, corewebhook.SubscriptionInput{ProjectID: project, EventTypes: append([]string(nil), corewebhook.EventTypes[:]...)})
	}
	if _, err = svc.Mutate(ctx, principal, webhook.Owner{Kind: "personal", ID: user}, m); err != nil {
		t.Fatal(err)
	}
	return &captureFixture{ctx: ctx, db: db, principal: principal, project: project, capture: &webhook.Capturer{Keys: keys}}
}

func TestCaptureRealTaskSourcesAndOriginalProof(t *testing.T) {
	f := newCaptureFixture(t, 2)
	tasks := taskservice.NewTasks(f.db, f.capture)
	steps := taskservice.NewTaskSteps(f.db, f.capture)
	threads := taskservice.NewTaskThreads(f.db, f.capture)
	created, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "source"})
	if err != nil {
		t.Fatal(err)
	}
	status, err := tasks.SetStatus(f.ctx, f.principal, f.project, created.ID, taskcore.SetTaskStatus{Version: created.Version, Status: model.TaskInProgress})
	if err != nil {
		t.Fatal(err)
	}
	paused, err := tasks.Update(f.ctx, f.principal, f.project, created.ID, taskcore.UpdateTask{Version: status.Version, Properties: model.TaskPropertiesPatch{"paused": json.RawMessage(`true`)}})
	if err != nil {
		t.Fatal(err)
	}
	same, err := tasks.Update(f.ctx, f.principal, f.project, created.ID, taskcore.UpdateTask{Version: paused.Version, Properties: model.TaskPropertiesPatch{"paused": json.RawMessage(`true`)}})
	if err != nil || same.Version != paused.Version {
		t.Fatalf("paused no-op: %v", err)
	}
	if _, err = tasks.SetStatus(f.ctx, f.principal, f.project, created.ID, taskcore.SetTaskStatus{Version: created.Version, Status: model.TaskDone}); err == nil {
		t.Fatal("stale status accepted")
	}
	added, err := steps.Add(f.ctx, f.principal, f.project, created.ID, taskservice.AddTaskStep{Version: paused.Version, ID: "00000001", Title: "step"})
	if err != nil {
		t.Fatal(err)
	}
	message, err := threads.Post(f.ctx, f.principal, f.project, created.ID, taskservice.CreateThreadMessage{Body: "private body"})
	if err != nil {
		t.Fatal(err)
	}
	afterThread, err := tasks.Get(f.ctx, f.principal, f.project, created.ID)
	if err != nil || afterThread.Version != added.Resource.Version {
		t.Fatalf("thread changed Task version: %v", err)
	}
	if err = tasks.Delete(f.ctx, f.principal, f.project, created.ID, taskcore.DeleteTask{Version: added.Resource.Version}); err != nil {
		t.Fatal(err)
	}
	var deletedVersion int64
	var deletedAt time.Time
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT version,deleted_at FROM tasks WHERE id=$1`, created.ID).Scan(&deletedVersion, &deletedAt); err != nil {
		t.Fatal(err)
	}
	rows, err := f.db.Pool.Query(f.ctx, `SELECT e.id::text,e.event_type,e.task_version,e.message_id::text,d.body,d.body_sha256,d.original_match_count,d.original_match_sha256,d.id::text FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id ORDER BY e.event_type`)
	if err != nil {
		t.Fatal(err)
	}
	type row struct {
		id, kind, delivery string
		version            *int64
		message            *string
		body, hash, proof  []byte
		count              int64
	}
	var events []row
	for rows.Next() {
		var x row
		if err = rows.Scan(&x.id, &x.kind, &x.version, &x.message, &x.body, &x.hash, &x.count, &x.proof, &x.delivery); err != nil {
			t.Fatal(err)
		}
		events = append(events, x)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(events) != 6 {
		t.Fatalf("got %d events, want six: %+v", len(events), events)
	}
	for _, e := range events {
		if e.count != 2 {
			t.Fatalf("%s proof count %d", e.kind, e.count)
		}
		var envelope struct {
			ID   string         `json:"id"`
			Type string         `json:"type"`
			Data map[string]any `json:"data"`
		}
		if err = json.Unmarshal(e.body, &envelope); err != nil {
			t.Fatal(err)
		}
		actual := sha256.Sum256(e.body)
		if !bytes.Equal(actual[:], e.hash) || envelope.ID != e.id || envelope.Type != "cc.daynight."+e.kind+".v1" || envelope.Data["taskId"] != created.ID || bytes.Contains(e.body, []byte("private body")) {
			t.Fatalf("invalid event %s %s", e.kind, e.body)
		}
		if e.kind == "task.thread_posted" && (e.version != nil || e.message == nil || *e.message != message.Message.ID) {
			t.Fatalf("thread anchor: %+v", e)
		}
		versions := map[string]int64{"task.created": created.Version, "task.status_changed": status.Version, "task.paused": paused.Version, "task.step_updated": added.Resource.Version, "task.deleted": deletedVersion}
		if expected, ok := versions[e.kind]; ok && (e.version == nil || *e.version != expected || envelope.Data["taskVersion"] != fmt.Sprint(expected)) {
			t.Fatalf("task version: %+v data=%v", e, envelope.Data)
		}
		if e.kind == "task.deleted" {
			timestamp, err := time.Parse(time.RFC3339Nano, envelope.Data["deletedAt"].(string))
			if err != nil || !timestamp.Equal(deletedAt) {
				t.Fatalf("deleted time mismatch: %v %v", timestamp, err)
			}
		}
		if e.kind == "task.step_updated" && (envelope.Data["stepId"] != "00000001" || envelope.Data["action"] != "created") {
			t.Fatalf("step fields: %v", envelope.Data)
		}
		if e.kind == "task.thread_posted" {
			position, ok := envelope.Data["position"].(map[string]any)
			if !ok || position["messageId"] != message.Message.ID {
				t.Fatalf("thread position: %v", envelope.Data)
			}
			at, err := time.Parse(time.RFC3339Nano, position["createdAt"].(string))
			if err != nil || !at.Equal(message.Message.CreatedAt) {
				t.Fatalf("thread time: %v %v", at, err)
			}
		}
		mr, err := f.db.Pool.Query(f.ctx, `SELECT subscription_id::text,binding_id::text,project_id::text,event_type,authorization_epoch FROM webhook_delivery_matches WHERE delivery_id=$1`, e.delivery)
		if err != nil {
			t.Fatal(err)
		}
		var tuples [][5]string
		for mr.Next() {
			var a, b, c, d string
			var epoch int64
			if err = mr.Scan(&a, &b, &c, &d, &epoch); err != nil {
				t.Fatal(err)
			}
			tuples = append(tuples, [5]string{a, b, c, d, fmt.Sprint(epoch)})
		}
		mr.Close()
		if err = mr.Err(); err != nil {
			t.Fatal(err)
		}
		sort.Slice(tuples, func(i, j int) bool {
			if tuples[i][0] != tuples[j][0] {
				return tuples[i][0] < tuples[j][0]
			}
			return tuples[i][1] < tuples[j][1]
		})
		proofBytes, err := json.Marshal(tuples)
		if err != nil {
			t.Fatal(err)
		}
		proof := sha256.Sum256(proofBytes)
		if len(tuples) != 2 || !bytes.Equal(proof[:], e.proof) {
			t.Fatalf("invalid original proof %s: %v", e.kind, tuples)
		}
	}
}

func TestCapturePersistenceFailureRollsBackSource(t *testing.T) {
	f := newCaptureFixture(t, 1)
	_, err := f.db.Pool.Exec(f.ctx, `CREATE FUNCTION fail_capture_match() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected capture persistence failure'; END $$;
		CREATE TRIGGER fail_capture_match BEFORE INSERT ON webhook_delivery_matches FOR EACH ROW EXECUTE FUNCTION fail_capture_match()`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "must roll back"})
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Message != "injected capture persistence failure" {
		t.Fatalf("missing persistence cause: %v", err)
	}
	var tasks, events, deliveries, matches int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM tasks WHERE project_id=$1),(SELECT count(*) FROM webhook_events),(SELECT count(*) FROM webhook_deliveries),(SELECT count(*) FROM webhook_delivery_matches)`, f.project).Scan(&tasks, &events, &deliveries, &matches); err != nil {
		t.Fatal(err)
	}
	if tasks != 0 || events != 0 || deliveries != 0 || matches != 0 {
		t.Fatalf("partial commit task=%d event=%d delivery=%d match=%d", tasks, events, deliveries, matches)
	}
}

type captureTestEntropyFailure struct{ err error }

func (r captureTestEntropyFailure) Read([]byte) (int, error) { return 0, r.err }
func TestCaptureEntropyFailureRollsBackSource(t *testing.T) {
	f := newCaptureFixture(t, 1)
	sentinel := errors.New("entropy failure")
	f.capture.Random = captureTestEntropyFailure{sentinel}
	_, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "must roll back"})
	if !errors.Is(err, sentinel) {
		t.Fatalf("missing entropy cause: %v", err)
	}
	var tasks, events int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM tasks WHERE project_id=$1),(SELECT count(*) FROM webhook_events)`, f.project).Scan(&tasks, &events); err != nil {
		t.Fatal(err)
	}
	if tasks != 0 || events != 0 {
		t.Fatalf("partial commit task=%d event=%d", tasks, events)
	}
}

type countedCaptureDAO struct {
	store.WebhookCaptureDAO
	calls int
}

func (d *countedCaptureDAO) FreezeAudience(ctx context.Context, project string, types []string) ([]store.WebhookAudience, error) {
	d.calls++
	return d.WebhookCaptureDAO.FreezeAudience(ctx, project, types)
}

// A real project transaction and DAO demonstrate batch capture. The public Task
// APIs do not expose a combined status and properties write.
func TestCaptureTwoFactsOneFreezeAndProof(t *testing.T) {
	f := newCaptureFixture(t, 2)
	created, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "batch"})
	if err != nil {
		t.Fatal(err)
	}
	var calls int
	completion, err := f.db.WriteProject(f.ctx, f.project, func(tx store.ProjectWriteScope) error {
		current, err := tx.TaskDAO().Task(f.ctx, created.ID)
		if err != nil {
			return err
		}
		values := taskcore.CurrentWrite(current)
		values.Status = model.TaskInProgress
		values.Properties["paused"] = json.RawMessage(`true`)
		final, err := tx.TaskDAO().UpdateTask(f.ctx, created.ID, values)
		if err != nil {
			return err
		}
		dao := &countedCaptureDAO{WebhookCaptureDAO: tx.CaptureDAO()}
		err = f.capture.CaptureBatch(f.ctx, dao, []protocol.Fact{
			{Type: protocol.StatusChanged, ProjectID: f.project, TaskID: created.ID, TaskVersion: final.Version, OccurredAt: final.UpdatedAt, PreviousStatus: string(current.Status), Status: string(final.Status)},
			{Type: protocol.Paused, ProjectID: f.project, TaskID: created.ID, TaskVersion: final.Version, OccurredAt: final.UpdatedAt, Paused: true},
		})
		calls = dao.calls
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted || calls != 1 {
		t.Fatalf("batch outcome=%+v freeze calls=%d err=%v", completion, calls, err)
	}
	rows, err := f.db.Pool.Query(f.ctx, `SELECT e.event_type,e.id::text,d.original_match_count,count(m.binding_id) FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id JOIN webhook_delivery_matches m ON m.delivery_id=d.id WHERE e.event_type IN ('task.status_changed','task.paused') GROUP BY e.event_type,e.id,d.original_match_count ORDER BY e.event_type`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var kind, id string
		var saved, actual int64
		if err = rows.Scan(&kind, &id, &saved, &actual); err != nil {
			t.Fatal(err)
		}
		if saved != 2 || actual != 2 {
			t.Fatalf("%s saved=%d actual=%d", kind, saved, actual)
		}
		ids = append(ids, id)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] == ids[1] {
		t.Fatalf("batch event IDs %v", ids)
	}
}

func TestCaptureWorkerLifecycleSources(t *testing.T) {
	f := newCaptureFixture(t, 1)
	tasks := taskservice.NewTasks(f.db, f.capture)
	current, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "worker", AssignedTo: &f.principal.UserID})
	if err != nil {
		t.Fatal(err)
	}
	enabled := true
	current, err = tasks.Update(f.ctx, f.principal, f.project, current.ID, taskcore.UpdateTask{Version: current.Version, AllowAgents: &enabled})
	if err != nil {
		t.Fatal(err)
	}
	descriptor := func() taskcore.WorkerDescriptor {
		return taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "test machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, WorktreeID: uuid.NewString()}
	}
	first := descriptor()
	current, err = tasks.ClaimWorker(f.ctx, f.principal, f.project, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: first})
	if err != nil {
		t.Fatal(err)
	}
	phase := model.WorkerExecuting
	current, err = tasks.UpdateWorker(f.ctx, f.principal, f.project, current.ID, taskcore.UpdateWorker{Version: current.Version, ClaimID: first.ClaimID, Phase: &phase})
	if err != nil {
		t.Fatal(err)
	}
	current, err = tasks.ReleaseWorker(f.ctx, f.principal, f.project, current.ID, taskcore.ReleaseWorker{Version: current.Version, ClaimID: first.ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	next := descriptor()
	current, err = tasks.ResumeWorker(f.ctx, f.principal, f.project, current.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: next}, PreviousClaimID: first.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	current, err = tasks.WithdrawWorker(f.ctx, f.principal, f.project, current.ID, taskcore.WithdrawWorker{Version: current.Version, ClaimID: next.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	var created, status, paused int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FILTER (WHERE event_type='task.created'),count(*) FILTER (WHERE event_type='task.status_changed'),count(*) FILTER (WHERE event_type='task.paused') FROM webhook_events WHERE task_id=$1`, current.ID).Scan(&created, &status, &paused); err != nil {
		t.Fatal(err)
	}
	if created != 1 || status != 4 || paused != 0 {
		t.Fatalf("worker lifecycle counts created=%d status=%d paused=%d", created, status, paused)
	}
}

func TestCaptureStepLogicalChangesAndNoOps(t *testing.T) {
	f := newCaptureFixture(t, 1)
	tasks, steps := taskservice.NewTasks(f.db, f.capture), taskservice.NewTaskSteps(f.db, f.capture)
	parent, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "steps"})
	if err != nil {
		t.Fatal(err)
	}
	first, err := steps.Add(f.ctx, f.principal, f.project, parent.ID, taskservice.AddTaskStep{Version: parent.Version, ID: "00000001", Title: "first"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := steps.Add(f.ctx, f.principal, f.project, parent.ID, taskservice.AddTaskStep{Version: first.Resource.Version, ID: "00000002", Title: "second"})
	if err != nil {
		t.Fatal(err)
	}
	changedTitle := "revised"
	updated, err := steps.Update(f.ctx, f.principal, f.project, parent.ID, "00000002", taskservice.UpdateTaskStep{Version: second.Resource.Version, Title: &changedTitle})
	if err != nil {
		t.Fatal(err)
	}
	status, err := steps.SetStatus(f.ctx, f.principal, f.project, parent.ID, "00000002", taskservice.SetTaskStepStatus{Version: updated.Resource.Version, Status: model.TaskStepDone})
	if err != nil {
		t.Fatal(err)
	}
	before := "00000001"
	moved, err := steps.Move(f.ctx, f.principal, f.project, parent.ID, "00000002", taskservice.MoveTaskStep{Version: status.Resource.Version, Before: &before})
	if err != nil {
		t.Fatal(err)
	}
	noop, err := steps.Move(f.ctx, f.principal, f.project, parent.ID, "00000002", taskservice.MoveTaskStep{Version: moved.Resource.Version, Before: &before})
	if err != nil || noop.Changed || noop.Resource.Version != moved.Resource.Version {
		t.Fatalf("move noop: %v", err)
	}
	deleted, err := steps.Delete(f.ctx, f.principal, f.project, parent.ID, "00000002", taskservice.DeleteTaskStep{Version: moved.Resource.Version})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := f.db.Pool.Query(f.ctx, `SELECT e.task_version,d.body FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.task_id=$1 AND e.event_type='task.step_updated' ORDER BY e.task_version`, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	want := []struct {
		version      int64
		action, step string
	}{{first.Resource.Version, "created", "00000001"}, {second.Resource.Version, "created", "00000002"}, {updated.Resource.Version, "updated", "00000002"}, {status.Resource.Version, "status_changed", "00000002"}, {moved.Resource.Version, "moved", "00000002"}, {deleted.Resource.Version, "deleted", "00000002"}}
	i := 0
	for rows.Next() {
		var version int64
		var body []byte
		if err = rows.Scan(&version, &body); err != nil {
			t.Fatal(err)
		}
		if i >= len(want) {
			t.Fatal("extra Step event")
		}
		var event struct {
			Data map[string]any `json:"data"`
		}
		if err = json.Unmarshal(body, &event); err != nil {
			t.Fatal(err)
		}
		w := want[i]
		if version != w.version || event.Data["taskVersion"] != fmt.Sprint(w.version) || event.Data["action"] != w.action || event.Data["stepId"] != w.step {
			t.Fatalf("step event %d: %s", i, body)
		}
		if w.action == "moved" && (event.Data["fromPosition"] != "1" || event.Data["toPosition"] != "0") {
			t.Fatalf("step movement: %s", body)
		}
		if w.action == "updated" {
			fields, ok := event.Data["changedFields"].([]any)
			if !ok || len(fields) != 1 || fields[0] != "title" {
				t.Fatalf("step fields: %s", body)
			}
		}
		i++
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	if i != len(want) {
		t.Fatalf("got %d Step events, want %d", i, len(want))
	}
}

func TestCaptureNoAudienceAndPausedTransitions(t *testing.T) {
	t.Run("empty audience", func(t *testing.T) {
		f := newCaptureFixture(t, 0)
		if _, err := taskservice.NewTasks(f.db, &webhook.Capturer{}).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "unsubscribed"}); err != nil {
			t.Fatal(err)
		}
		var events int
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_events`).Scan(&events); err != nil || events != 0 {
			t.Fatalf("no audience event count=%d err=%v", events, err)
		}
	})
	t.Run("disabled endpoint", func(t *testing.T) {
		f := newCaptureFixture(t, 1)
		var endpoint string
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text FROM webhook_endpoints`).Scan(&endpoint); err != nil {
			t.Fatal(err)
		}
		enabled := false
		svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true}
		m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: 1, RequestSHA256: strings.Repeat("d", 64), Enabled: &enabled}
		if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
			t.Fatal(err)
		}
		if _, err := taskservice.NewTasks(f.db, &webhook.Capturer{}).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "disabled"}); err != nil {
			t.Fatal(err)
		}
		var events int
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_events`).Scan(&events); err != nil || events != 0 {
			t.Fatalf("disabled event count=%d err=%v", events, err)
		}
	})
	t.Run("created paused and transitions", func(t *testing.T) {
		f := newCaptureFixture(t, 1)
		tasks := taskservice.NewTasks(f.db, f.capture)
		current, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "paused", Properties: model.TaskProperties{"paused": json.RawMessage(`true`)}})
		if err != nil {
			t.Fatal(err)
		}
		current, err = tasks.SetProperty(f.ctx, f.principal, f.project, current.ID, "paused", "true", current.Version)
		if err != nil {
			t.Fatal(err)
		}
		current, err = tasks.RemoveProperty(f.ctx, f.principal, f.project, current.ID, "paused", current.Version)
		if err != nil {
			t.Fatal(err)
		}
		current, err = tasks.SetProperty(f.ctx, f.principal, f.project, current.ID, "paused", "true", current.Version)
		if err != nil {
			t.Fatal(err)
		}
		var created, paused int
		if err = f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FILTER(WHERE event_type='task.created'),count(*) FILTER(WHERE event_type='task.paused') FROM webhook_events WHERE task_id=$1`, current.ID).Scan(&created, &paused); err != nil || created != 1 || paused != 1 {
			t.Fatalf("paused created=%d transition=%d err=%v", created, paused, err)
		}
	})
}

func TestCapturePersistsPublishedVectorBytes(t *testing.T) {
	project := "22222222-2222-4222-8222-222222222222"
	task := "33333333-3333-4333-8333-333333333333"
	eventID := uuid.MustParse("a0be4d96-fb33-41ba-a7bd-7885c1e94247")
	f := newCaptureFixtureForProject(t, 1, project)
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO tasks(id,project_id,title,version) VALUES($1,$2,'vector source',42)`, task, project); err != nil {
		t.Fatal(err)
	}
	f.capture.Random = io.MultiReader(bytes.NewReader(eventID[:]), rand.Reader)
	at := time.Date(2026, 11, 6, 8, 0, 0, 0, time.UTC)
	completion, err := f.db.WriteProject(f.ctx, project, func(tx store.ProjectWriteScope) error {
		return f.capture.CaptureBatch(f.ctx, tx.CaptureDAO(), []protocol.Fact{{Type: protocol.Paused, ProjectID: project, TaskID: task, TaskVersion: 42, OccurredAt: at, Paused: true}})
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("capture: %+v %v", completion, err)
	}
	var body, fact, hash []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.body,e.fact_bytes,d.body_sha256 FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.id=$1`, eventID.String()).Scan(&body, &fact, &hash); err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("../../core/webhook/protocol/testdata/event.json")
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(want)
	if len(want) != 433 || !bytes.Equal(body, want) || !bytes.Equal(fact, want) || !bytes.Equal(hash, digest[:]) {
		t.Fatal("persisted vector bytes or hash differ")
	}
}

func TestCaptureRetainsOriginalSubscriptionAndBindingIdentity(t *testing.T) {
	f := newCaptureFixture(t, 1)
	tasks := taskservice.NewTasks(f.db, f.capture)
	first, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "original"})
	if err != nil {
		t.Fatal(err)
	}
	var endpoint, oldSub, oldBinding, delivery string
	var oldHash, oldBody []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.endpoint_id::text,m.subscription_id::text,m.binding_id::text,d.id::text,d.original_match_sha256,d.body FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id JOIN webhook_delivery_matches m ON m.delivery_id=d.id WHERE e.task_id=$1`, first.ID).Scan(&endpoint, &oldSub, &oldBinding, &delivery, &oldHash, &oldBody); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true}
	base := func(version int64) webhook.Mutation {
		return webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), HasSubscriptions: true}
	}
	withoutCreated := []string{"task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"}
	m := base(1)
	m.Subscriptions = []corewebhook.SubscriptionInput{{ID: &oldSub, ProjectID: f.project, EventTypes: withoutCreated}, {ProjectID: f.project, EventTypes: []string{"task.created"}}}
	if _, err = svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	var newSub, newBinding string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT s.id::text,b.id::text FROM webhook_subscriptions s JOIN webhook_bindings b ON b.subscription_id=s.id WHERE s.endpoint_id=$1 AND s.id<>$2 AND b.event_type='task.created' AND s.deleted_at IS NULL AND b.deleted_at IS NULL`, endpoint, oldSub).Scan(&newSub, &newBinding); err != nil {
		t.Fatal(err)
	}
	second, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "replacement"})
	if err != nil {
		t.Fatal(err)
	}
	var capturedSub, capturedBinding string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT m.subscription_id::text,m.binding_id::text FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id JOIN webhook_delivery_matches m ON m.delivery_id=d.id WHERE e.task_id=$1`, second.ID).Scan(&capturedSub, &capturedBinding); err != nil {
		t.Fatal(err)
	}
	if capturedSub != newSub || capturedBinding != newBinding || newSub == oldSub || newBinding == oldBinding {
		t.Fatalf("new proof differs: %s %s", capturedSub, capturedBinding)
	}
	m = base(2)
	m.Subscriptions = []corewebhook.SubscriptionInput{{ID: &oldSub, ProjectID: f.project, EventTypes: append([]string(nil), corewebhook.EventTypes[:]...)}, {ID: &newSub, ProjectID: f.project, EventTypes: []string{"task.created"}}}
	if _, err = svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	third, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "binding re-added"})
	if err != nil {
		t.Fatal(err)
	}
	var newOldBinding string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT m.binding_id::text FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id JOIN webhook_delivery_matches m ON m.delivery_id=d.id WHERE e.task_id=$1 AND m.subscription_id=$2`, third.ID, oldSub).Scan(&newOldBinding); err != nil {
		t.Fatal(err)
	}
	if newOldBinding == oldBinding {
		t.Fatal("re-added binding reused old identity")
	}
	var savedSub, savedBinding string
	var savedHash, savedBody []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT m.subscription_id::text,m.binding_id::text,d.original_match_sha256,d.body FROM webhook_deliveries d JOIN webhook_delivery_matches m ON m.delivery_id=d.id WHERE d.id=$1`, delivery).Scan(&savedSub, &savedBinding, &savedHash, &savedBody); err != nil {
		t.Fatal(err)
	}
	if savedSub != oldSub || savedBinding != oldBinding || !bytes.Equal(savedHash, oldHash) || !bytes.Equal(savedBody, oldBody) {
		t.Fatal("historical proof or body changed after configuration updates")
	}
}

func TestCaptureTaskAndStepStatusMatrices(t *testing.T) {
	f := newCaptureFixture(t, 1)
	tasks, steps := taskservice.NewTasks(f.db, f.capture), taskservice.NewTaskSteps(f.db, f.capture)
	parent, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "status matrix"})
	if err != nil {
		t.Fatal(err)
	}
	for _, next := range []model.TaskStatus{model.TaskInProgress, model.TaskDone, model.TaskTodo, model.TaskCancelled} {
		before := parent
		parent, err = tasks.SetStatus(f.ctx, f.principal, f.project, parent.ID, taskcore.SetTaskStatus{Version: parent.Version, Status: next})
		if err != nil {
			t.Fatalf("Task %s: %v", next, err)
		}
		var body []byte
		if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.body FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.task_id=$1 AND e.event_type='task.status_changed' AND e.task_version=$2`, parent.ID, parent.Version).Scan(&body); err != nil {
			t.Fatal(err)
		}
		var event struct {
			Data map[string]any `json:"data"`
		}
		if err = json.Unmarshal(body, &event); err != nil {
			t.Fatal(err)
		}
		if event.Data["previousStatus"] != string(before.Status) || event.Data["status"] != string(next) {
			t.Fatalf("Task status event: %s", body)
		}
	}
	stepParent, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "step status matrix"})
	if err != nil {
		t.Fatal(err)
	}
	added, err := steps.Add(f.ctx, f.principal, f.project, stepParent.ID, taskservice.AddTaskStep{Version: stepParent.Version, ID: "00000001", Title: "step"})
	if err != nil {
		t.Fatal(err)
	}
	version, previous := added.Resource.Version, model.TaskStepTodo
	for _, next := range []model.TaskStepStatus{model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped, model.TaskStepTodo} {
		result, err := steps.SetStatus(f.ctx, f.principal, f.project, stepParent.ID, "00000001", taskservice.SetTaskStepStatus{Version: version, Status: next})
		if err != nil {
			t.Fatalf("Step %s: %v", next, err)
		}
		version = result.Resource.Version
		var body []byte
		if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.body FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.task_id=$1 AND e.event_type='task.step_updated' AND e.task_version=$2`, stepParent.ID, version).Scan(&body); err != nil {
			t.Fatal(err)
		}
		var event struct {
			Data map[string]any `json:"data"`
		}
		if err = json.Unmarshal(body, &event); err != nil {
			t.Fatal(err)
		}
		if event.Data["action"] != "status_changed" || event.Data["previousStatus"] != string(previous) || event.Data["status"] != string(next) {
			t.Fatalf("Step status event: %s", body)
		}
		previous = next
	}
	no, err := steps.SetStatus(f.ctx, f.principal, f.project, stepParent.ID, "00000001", taskservice.SetTaskStepStatus{Version: version, Status: previous})
	if err != nil || no.Changed || no.Resource.Version != version {
		t.Fatalf("Step same status: %v", err)
	}
	var taskCount, stepCount int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_events WHERE task_id=$1 AND event_type='task.status_changed'),(SELECT count(*) FROM webhook_events WHERE task_id=$2 AND event_type='task.step_updated')`, parent.ID, stepParent.ID).Scan(&taskCount, &stepCount); err != nil || taskCount != 4 || stepCount != 5 {
		t.Fatalf("status event counts task=%d step=%d err=%v", taskCount, stepCount, err)
	}
}

func TestCaptureRetainsOriginalEpochAfterRevocationAndRegrant(t *testing.T) {
	f := newCaptureFixture(t, 1)
	adminID, session := uuid.NewString(), uuid.NewString()
	token := sha256.Sum256([]byte(session))
	var team string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, f.project).Scan(&team); err != nil {
		t.Fatal(err)
	}
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, []any{adminID}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, adminID, token[:]}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, adminID}},
	} {
		if _, err := f.db.Pool.Exec(f.ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	admin := model.Principal{Kind: model.SessionCredential, UserID: adminID, CredentialID: session}
	tasks := taskservice.NewTasks(f.db, f.capture)
	before, err := tasks.Create(f.ctx, admin, f.project, taskcore.CreateTask{Title: "epoch one"})
	if err != nil {
		t.Fatal(err)
	}
	var delivery, subscription, endpoint string
	var epoch int64
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.id::text,m.subscription_id::text,d.endpoint_id::text,m.authorization_epoch FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id JOIN webhook_delivery_matches m ON m.delivery_id=d.id WHERE e.task_id=$1`, before.ID).Scan(&delivery, &subscription, &endpoint, &epoch); err != nil || epoch != 1 {
		t.Fatalf("original epoch %d: %v", epoch, err)
	}
	var membershipVersion int64
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT version FROM team_members WHERE team_id=$1 AND user_id=$2`, team, f.principal.UserID).Scan(&membershipVersion); err != nil {
		t.Fatal(err)
	}
	teams := teamservice.NewTeams(f.db)
	if _, err = teams.RemoveMember(f.ctx, admin, team, f.principal.UserID, coreteam.ChangeTeamMember{Version: membershipVersion, ExpectedUserID: adminID}); err != nil {
		t.Fatal(err)
	}
	invite, err := teams.CreateInvitation(f.ctx, admin, team, adminID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = teams.AcceptInvitation(f.ctx, f.principal, invite.Secret, f.principal.UserID); err != nil {
		t.Fatal(err)
	}
	var state string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, subscription).Scan(&state, &epoch); err != nil || state != "confirmation_required" || epoch != 2 {
		t.Fatalf("regrant state %s/%d: %v", state, epoch, err)
	}
	without, err := tasks.Create(f.ctx, admin, f.project, taskcore.CreateTask{Title: "unconfirmed"})
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_events WHERE task_id=$1`, without.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("unconfirmed capture %d: %v", count, err)
	}
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true}
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: 1, RequestSHA256: strings.Repeat("a", 64), ConfirmProjectIDs: []string{f.project}}
	if _, err = svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	after, err := tasks.Create(f.ctx, admin, f.project, taskcore.CreateTask{Title: "epoch two"})
	if err != nil {
		t.Fatal(err)
	}
	var oldEpoch, newEpoch int64
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT authorization_epoch FROM webhook_delivery_matches WHERE delivery_id=$1`, delivery).Scan(&oldEpoch); err != nil {
		t.Fatal(err)
	}
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT m.authorization_epoch FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id JOIN webhook_delivery_matches m ON m.delivery_id=d.id WHERE e.task_id=$1`, after.ID).Scan(&newEpoch); err != nil {
		t.Fatal(err)
	}
	if oldEpoch != 1 || newEpoch != 2 {
		t.Fatalf("epochs old=%d new=%d", oldEpoch, newEpoch)
	}
}
