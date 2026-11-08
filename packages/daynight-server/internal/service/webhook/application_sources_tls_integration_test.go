package webhook_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
)

type sourceTLSObservation struct {
	path, id, timestamp, signature, media string
	body                                  []byte
}

// Uses the production Application source wiring, Capturer and Runner, but injects
// loopback address policy and a private CA solely in the test transport. OpenApp's
// production transport is not modified and cannot send to this test receiver.
func TestApplicationSourcesToTwoOwnersTLS(t *testing.T) {
	requests := make(chan sourceTLSObservation, 64)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("receiver body: %v", err)
		}
		requests <- sourceTLSObservation{r.URL.Path, r.Header.Get("Webhook-Id"), r.Header.Get("Webhook-Timestamp"), r.Header.Get("Webhook-Signature"), r.Header.Get("Content-Type"), body}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	f := newCaptureFixture(t, 1)
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true, DispatchEnabled: true}
	var personal, team string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&personal, &version); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, f.project).Scan(&team); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, webhook.Mutation{Kind: "endpoint.update", EndpointID: personal, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL + "/personal"}})
	if err != nil {
		t.Fatal(err)
	}
	name, enabled := "Team receiver", true
	_, err = svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "team", ID: team}, webhook.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, RequestSHA256: strings.Repeat("a", 64), Name: &name, Enabled: &enabled, Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL + "/team"}, HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{{ProjectID: f.project, EventTypes: append([]string(nil), corewebhook.EventTypes[:]...)}}})
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string][]byte{}
	rows, err := f.db.Pool.Query(f.ctx, `SELECT e.owner_kind,e.owner_id::text,e.id::text,k.id::text,k.envelope_version,k.master_key_id,k.nonce,k.ciphertext FROM webhook_endpoints e JOIN webhook_signing_keys k ON k.id=e.active_key_id`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var kind, owner, endpoint, keyID string
		var envelope secretbox.Envelope
		if err = rows.Scan(&kind, &owner, &endpoint, &keyID, &envelope.Version, &envelope.MasterKeyID, &envelope.Nonce, &envelope.Ciphertext); err != nil {
			t.Fatal(err)
		}
		key, e := f.capture.Keys.Open(envelope, []string{kind, owner, endpoint, "signing-key", keyID})
		if e != nil {
			t.Fatal(e)
		}
		keys["/"+kind] = key
	}
	rows.Close()
	if err = rows.Err(); err != nil || len(keys) != 2 {
		t.Fatalf("keys=%d err=%v", len(keys), err)
	}
	app := application.New(f.db, nil, nil, "https://daynight.example/auth/callback", 0, f.capture)
	runner := newTestRunner(f.db, svc, true)
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err = runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if e := runner.Stop(ctx); e != nil {
			t.Error(e)
		}
		if e := app.Engine.Stop(ctx); e != nil {
			t.Error(e)
		}
	})

	regular, err := app.Tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "ordinary source"})
	if err != nil {
		t.Fatal(err)
	}
	status, err := app.Tasks.SetStatus(f.ctx, f.principal, f.project, regular.ID, taskcore.SetTaskStatus{Version: regular.Version, Status: model.TaskInProgress})
	if err != nil {
		t.Fatal(err)
	}
	paused, err := app.Tasks.Update(f.ctx, f.principal, f.project, regular.ID, taskcore.UpdateTask{Version: status.Version, Properties: model.TaskPropertiesPatch{"paused": json.RawMessage(`true`)}})
	if err != nil {
		t.Fatal(err)
	}
	step, err := app.TaskSteps.Add(f.ctx, f.principal, f.project, regular.ID, taskservice.AddTaskStep{Version: paused.Version, ID: "00000001", Title: "step"})
	if err != nil {
		t.Fatal(err)
	}
	message, err := app.TaskThreads.Post(f.ctx, f.principal, f.project, regular.ID, taskservice.CreateThreadMessage{Body: "not sent in event"})
	if err != nil {
		t.Fatal(err)
	}
	current, err := app.Tasks.Get(f.ctx, f.principal, f.project, regular.ID)
	if err != nil || current.Version != step.Resource.Version {
		t.Fatalf("thread changed version: %v", err)
	}
	current, err = app.Tasks.SetStatus(f.ctx, f.principal, f.project, regular.ID, taskcore.SetTaskStatus{Version: current.Version, Status: model.TaskCancelled})
	if err != nil {
		t.Fatal(err)
	}
	initial, err := app.Tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "initially paused", Properties: model.TaskProperties{"paused": json.RawMessage(`true`)}})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := app.Tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "worker", AssignedTo: &f.principal.UserID})
	if err != nil {
		t.Fatal(err)
	}
	worker, err = app.Tasks.Update(f.ctx, f.principal, f.project, worker.ID, taskcore.UpdateTask{Version: worker.Version, AllowAgents: &enabled})
	if err != nil {
		t.Fatal(err)
	}
	descriptor := func() taskcore.WorkerDescriptor {
		return taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "test machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, WorktreeID: uuid.NewString()}
	}
	first := descriptor()
	worker, err = app.Tasks.ClaimWorker(f.ctx, f.principal, f.project, worker.ID, taskcore.ClaimWorker{Version: worker.Version, WorkerDescriptor: first})
	if err != nil {
		t.Fatal(err)
	}
	phase := model.WorkerExecuting
	worker, err = app.Tasks.UpdateWorker(f.ctx, f.principal, f.project, worker.ID, taskcore.UpdateWorker{Version: worker.Version, ClaimID: first.ClaimID, Phase: &phase})
	if err != nil {
		t.Fatal(err)
	}
	worker, err = app.Tasks.ReleaseWorker(f.ctx, f.principal, f.project, worker.ID, taskcore.ReleaseWorker{Version: worker.Version, ClaimID: first.ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	next := descriptor()
	worker, err = app.Tasks.ResumeWorker(f.ctx, f.principal, f.project, worker.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: worker.Version, WorkerDescriptor: next}, PreviousClaimID: first.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	worker, err = app.Tasks.WithdrawWorker(f.ctx, f.principal, f.project, worker.ID, taskcore.WithdrawWorker{Version: worker.Version, ClaimID: next.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	batch, err := app.Tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "batched facts"})
	if err != nil {
		t.Fatal(err)
	}
	// Public Task APIs have no combined status/properties operation. Exercise the
	// real capture batch against a single committed source transaction explicitly.
	completion, err := f.db.WriteProject(f.ctx, f.project, func(tx store.ProjectWriteScope) error {
		before, e := tx.TaskDAO().Task(f.ctx, batch.ID)
		if e != nil {
			return e
		}
		values := taskcore.CurrentWrite(before)
		values.Status = model.TaskInProgress
		values.Properties["paused"] = json.RawMessage(`true`)
		after, e := tx.TaskDAO().UpdateTask(f.ctx, batch.ID, values)
		if e != nil {
			return e
		}
		return f.capture.CaptureBatch(f.ctx, tx.CaptureDAO(), []protocol.Fact{{Type: protocol.StatusChanged, ProjectID: f.project, TaskID: batch.ID, TaskVersion: after.Version, OccurredAt: after.UpdatedAt, PreviousStatus: string(before.Status), Status: string(after.Status)}, {Type: protocol.Paused, ProjectID: f.project, TaskID: batch.ID, TaskVersion: after.Version, OccurredAt: after.UpdatedAt, Paused: true}})
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("batch %v %v", completion, err)
	}
	waitSourceDeliveryCount(t, f, 30)
	if err = app.Tasks.Delete(f.ctx, f.principal, f.project, regular.ID, taskcore.DeleteTask{Version: current.Version}); err != nil {
		t.Fatal(err)
	}
	waitSourceDeliveryCount(t, f, 32)

	for _, check := range []struct {
		id                                             string
		created, status, paused, step, thread, deleted int
	}{{regular.ID, 1, 2, 1, 1, 1, 1}, {worker.ID, 1, 4, 0, 0, 0, 0}, {initial.ID, 1, 0, 0, 0, 0, 0}, {batch.ID, 1, 1, 1, 0, 0, 0}} {
		var created, status, paused, step, thread, deleted int
		err = f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FILTER(WHERE event_type='task.created'),count(*) FILTER(WHERE event_type='task.status_changed'),count(*) FILTER(WHERE event_type='task.paused'),count(*) FILTER(WHERE event_type='task.step_updated'),count(*) FILTER(WHERE event_type='task.thread_posted'),count(*) FILTER(WHERE event_type='task.deleted') FROM webhook_events WHERE task_id=$1`, check.id).Scan(&created, &status, &paused, &step, &thread, &deleted)
		if err != nil || created != check.created || status != check.status || paused != check.paused || step != check.step || thread != check.thread || deleted != check.deleted {
			t.Fatalf("source %s counts=%d,%d,%d,%d,%d,%d err=%v", check.id, created, status, paused, step, thread, deleted, err)
		}
	}
	seen := map[string]bool{}
	for i := 0; i < 32; i++ {
		select {
		case got := <-requests:
			key := keys[got.path]
			if key == nil || got.media != "application/cloudevents+json" {
				t.Fatalf("unexpected receiver %s media %s", got.path, got.media)
			}
			mac := hmac.New(sha256.New, key)
			fmt.Fprintf(mac, "%s.%s.", got.id, got.timestamp)
			mac.Write(got.body)
			if got.signature != "v1,"+base64.StdEncoding.EncodeToString(mac.Sum(nil)) {
				t.Fatal("signature mismatch")
			}
			var body []byte
			var kind, taskID string
			var attempts int
			ownerKind := strings.TrimPrefix(got.path, "/")
			err = f.db.Pool.QueryRow(f.ctx, `SELECT d.body,e.event_type,e.task_id::text,(SELECT count(*) FROM webhook_attempts a WHERE a.delivery_id=d.id AND a.outcome='acknowledged') FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE e.id=$1 AND d.owner_kind=$2`, got.id, ownerKind).Scan(&body, &kind, &taskID, &attempts)
			if err != nil || !bytes.Equal(body, got.body) || attempts != 1 || bytes.Contains(got.body, []byte("not sent in event")) || seen[got.path+got.id] {
				t.Fatalf("receiver event=%s kind=%s attempts=%d err=%v", got.id, kind, attempts, err)
			}
			var event struct {
				ID, Type string
				Data     map[string]any
			}
			if err := json.Unmarshal(got.body, &event); err != nil || event.ID != got.id || event.Type != "cc.daynight."+kind+".v1" || event.Data["taskId"] != taskID || event.Data["projectId"] != f.project {
				t.Fatalf("event identity %s: %v", got.id, err)
			}
			if taskID == initial.ID && (kind != "task.created" || event.Data["paused"] != true) {
				t.Fatalf("initial pause event: %s %v", kind, event.Data)
			}
			if taskID == regular.ID && kind == "task.step_updated" && (event.Data["stepId"] != "00000001" || event.Data["action"] != "created") {
				t.Fatalf("step event: %v", event.Data)
			}
			if taskID == regular.ID && kind == "task.thread_posted" && (event.Data["messageId"] != message.Message.ID || event.Data["taskVersion"] != nil) {
				t.Fatalf("thread event: %v", event.Data)
			}
			seen[got.path+got.id] = true
		case e := <-runner.Failures():
			t.Fatalf("runner: %v", e)
		case <-time.After(5 * time.Second):
			t.Fatal("receiver count timed out")
		}
	}
}

func waitSourceDeliveryCount(t *testing.T, f *captureFixture, want int) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		var events, delivered, attempts int
		err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_events),(SELECT count(*) FROM webhook_deliveries WHERE state='delivered'),(SELECT count(*) FROM webhook_attempts WHERE outcome='acknowledged')`).Scan(&events, &delivered, &attempts)
		if err != nil {
			t.Fatal(err)
		}
		if events == want/2 && delivered == want && attempts == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("events=%d delivered=%d attempts=%d want=%d", events, delivered, attempts, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
