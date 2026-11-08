package task

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type captureInterleavingFixture struct {
	ctx               context.Context
	db                *postgres.Store
	principal         model.Principal
	project, endpoint string
	capture           *webhook.Capturer
	config            *webhook.Service
	task              model.Task
}

func newCaptureInterleavingFixture(t *testing.T) *captureInterleavingFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	user, session, team, project := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	token := sha256.Sum256([]byte(session))
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, []any{user}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, user, token[:]}},
		{`INSERT INTO teams(id,name) VALUES($1,'capture')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'capture','https://example.test/repo')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err = db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	keys, err := secretbox.Parse([]byte(`{"activeKeyId":"primary","keys":{"primary":"` + key + `"}}`))
	if err != nil {
		t.Fatal(err)
	}
	principal := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: session}
	target, err := NewTasks(db).Create(ctx, principal, project, taskcore.CreateTask{Title: "source"})
	if err != nil {
		t.Fatal(err)
	}
	config := &webhook.Service{DB: db, Keys: keys, ConfigurationExpansionAvailable: true}
	name, enabled := "Receiver", true
	create := webhook.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: user, RequestSHA256: strings.Repeat("a", 64), Name: &name, Enabled: &enabled, Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/old"}, HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{{ProjectID: project, EventTypes: append([]string(nil), corewebhook.EventTypes[:]...)}}}
	result, err := config.Mutate(ctx, principal, webhook.Owner{Kind: "personal", ID: user}, create)
	if err != nil {
		t.Fatal(err)
	}
	body, ok := result.Body.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result %T", result.Body)
	}
	receipt, ok := body["endpoint"].(map[string]any)
	if !ok {
		t.Fatalf("unexpected result %+v", body)
	}
	endpoint, ok := receipt["id"].(string)
	if !ok {
		t.Fatalf("unexpected receipt %+v", receipt)
	}
	return &captureInterleavingFixture{ctx: ctx, db: db, principal: principal, project: project, endpoint: endpoint, capture: &webhook.Capturer{Keys: keys}, config: config, task: target}
}

type frozenGate struct {
	inner   Capturer
	frozen  chan struct{}
	release chan struct{}
}

func (g *frozenGate) CaptureBatch(ctx context.Context, d store.WebhookCaptureDAO, f []protocol.Fact) error {
	return g.inner.CaptureBatch(ctx, &gateDAO{WebhookCaptureDAO: d, gate: g}, f)
}

type gateDAO struct {
	store.WebhookCaptureDAO
	gate *frozenGate
}

func (d *gateDAO) FreezeAudience(ctx context.Context, project string, kinds []string) ([]store.WebhookAudience, error) {
	rows, err := d.WebhookCaptureDAO.FreezeAudience(ctx, project, kinds)
	if err != nil {
		return nil, err
	}
	close(d.gate.frozen)
	select {
	case <-d.gate.release:
		return rows, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func waitGate(t *testing.T, ctx context.Context, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestWebhookFrozenThreadAudienceSurvivesDestinationChange(t *testing.T) {
	f := newCaptureInterleavingFixture(t)
	gate := &frozenGate{inner: f.capture, frozen: make(chan struct{}), release: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		_, err := NewTaskThreads(f.db, gate).Post(f.ctx, f.principal, f.project, f.task.ID, CreateThreadMessage{Body: "snapshot"})
		done <- err
	}()
	waitGate(t, f.ctx, gate.frozen)
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: f.endpoint, IfVersion: 1, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, RequestSHA256: strings.Repeat("b", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/new"}}
	_, err := f.config.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m)
	if err != nil {
		close(gate.release)
		t.Fatal(err)
	}
	close(gate.release)
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	var oldRevision, currentRevision int64
	var encrypted []byte
	var id string
	var ver int
	var key string
	var nonce, cipher []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.id::text,d.destination_revision,e.destination_revision,d.destination_envelope_version,d.destination_master_key_id,d.destination_nonce,d.destination_ciphertext FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.endpoint_id=$1`, f.endpoint).Scan(&id, &oldRevision, &currentRevision, &ver, &key, &nonce, &cipher); err != nil {
		t.Fatal(err)
	}
	encrypted, err = (secretbox.Envelope{Version: ver, MasterKeyID: key, Nonce: nonce, Ciphertext: cipher}).MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	env, err := secretbox.ParseEnvelope(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := f.capture.Keys.Open(env, []string{"personal", f.principal.UserID, f.endpoint, "delivery-destination", id})
	if err != nil {
		t.Fatal(err)
	}
	if oldRevision != 1 || currentRevision != 2 || !strings.Contains(string(plain), "/old") || strings.Contains(string(plain), "/new") {
		t.Fatalf("frozen revision=%d current=%d destination=%s", oldRevision, currentRevision, plain)
	}
}

type countedCapture struct {
	inner   Capturer
	freezes int
	types   []string
}

func (c *countedCapture) CaptureBatch(ctx context.Context, d store.WebhookCaptureDAO, f []protocol.Fact) error {
	return c.inner.CaptureBatch(ctx, &countDAO{WebhookCaptureDAO: d, owner: c}, f)
}

type countDAO struct {
	store.WebhookCaptureDAO
	owner *countedCapture
}

func (d *countDAO) FreezeAudience(ctx context.Context, project string, kinds []string) ([]store.WebhookAudience, error) {
	d.owner.freezes++
	d.owner.types = append(d.owner.types, kinds...)
	return d.WebhookCaptureDAO.FreezeAudience(ctx, project, kinds)
}
func TestWebhookStatusAndPauseShareFreeze(t *testing.T) {
	f := newCaptureInterleavingFixture(t)
	var original string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text FROM webhook_subscriptions WHERE endpoint_id=$1 AND deleted_at IS NULL`, f.endpoint).Scan(&original); err != nil {
		t.Fatal(err)
	}
	owner := webhook.Owner{Kind: "personal", ID: f.principal.UserID}
	change := webhook.Mutation{Kind: "endpoint.update", EndpointID: f.endpoint, IfVersion: 1, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, RequestSHA256: strings.Repeat("a", 64), HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{
		{ID: &original, ProjectID: f.project, EventTypes: append([]string(nil), corewebhook.EventTypes[:]...)},
		{ProjectID: f.project, EventTypes: []string{protocol.StatusChanged, protocol.Paused}},
	}}
	if _, err := f.config.Mutate(f.ctx, f.principal, owner, change); err != nil {
		t.Fatal(err)
	}
	name, enabled := "second receiver", true
	create := webhook.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, RequestSHA256: strings.Repeat("b", 64), Name: &name, Enabled: &enabled, Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://second.example/hook"}, HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{{ProjectID: f.project, EventTypes: []string{protocol.StatusChanged, protocol.Paused}}}}
	if _, err := f.config.Mutate(f.ctx, f.principal, owner, create); err != nil {
		t.Fatal(err)
	}
	c := &countedCapture{inner: f.capture}
	s := NewTasks(f.db, c)
	result, err := s.write(f.ctx, f.principal, f.project, func(tx store.ProjectWriteScope) (taskcore.Mutation, error) {
		mutation, err := taskcore.PrepareStatus(f.ctx, tx.TaskDAO(), f.principal, f.task.ID, taskcore.SetTaskStatus{Version: f.task.Version, Status: model.TaskInProgress})
		if err != nil {
			return mutation, err
		}
		mutation.Values.Properties["paused"] = json.RawMessage(`true`)
		return mutation, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.freezes != 1 || len(c.types) != 2 || c.types[0] != protocol.StatusChanged || c.types[1] != protocol.Paused {
		t.Fatalf("freeze calls %d, types %v", c.freezes, c.types)
	}
	var events, deliveries, proofs int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_events WHERE task_id=$1),(SELECT count(*) FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE e.task_id=$1),(SELECT count(*) FROM webhook_delivery_matches m JOIN webhook_deliveries d ON d.id=m.delivery_id JOIN webhook_events e ON e.id=d.event_id WHERE e.task_id=$1)`, f.task.ID).Scan(&events, &deliveries, &proofs); err != nil {
		t.Fatal(err)
	}
	if result.Version != f.task.Version+1 || events != 2 || deliveries != 4 || proofs != 6 {
		t.Fatalf("version=%d events=%d deliveries=%d matches=%d", result.Version, events, deliveries, proofs)
	}
	rows, err := f.db.Pool.Query(f.ctx, `SELECT e.event_type,d.id::text,d.endpoint_id::text,d.original_match_count,d.original_match_sha256 FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.task_id=$1 ORDER BY e.event_type,d.endpoint_id`, f.task.ID)
	if err != nil {
		t.Fatal(err)
	}
	type record struct {
		kind, id, endpoint string
		count              int64
		hash               []byte
	}
	var records []record
	for rows.Next() {
		var x record
		if err = rows.Scan(&x.kind, &x.id, &x.endpoint, &x.count, &x.hash); err != nil {
			t.Fatal(err)
		}
		records = append(records, x)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	load := func(query string, args ...any) [][5]string {
		t.Helper()
		rows, err := f.db.Pool.Query(f.ctx, query, args...)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var tuples [][5]string
		for rows.Next() {
			var a, b, p, k string
			var epoch int64
			if err = rows.Scan(&a, &b, &p, &k, &epoch); err != nil {
				t.Fatal(err)
			}
			tuples = append(tuples, [5]string{a, b, p, k, strconv.FormatInt(epoch, 10)})
		}
		if err = rows.Err(); err != nil {
			t.Fatal(err)
		}
		return tuples
	}
	if len(records) != 4 {
		t.Fatalf("got %d deliveries", len(records))
	}
	for _, x := range records {
		got := load(`SELECT subscription_id::text,binding_id::text,project_id::text,event_type,authorization_epoch FROM webhook_delivery_matches WHERE delivery_id=$1 ORDER BY subscription_id,binding_id`, x.id)
		want := load(`SELECT s.id::text,b.id::text,s.project_id::text,b.event_type,s.authorization_epoch FROM webhook_subscriptions s JOIN webhook_bindings b ON b.subscription_id=s.id WHERE s.endpoint_id=$1 AND s.deleted_at IS NULL AND b.deleted_at IS NULL AND b.event_type=$2 ORDER BY s.id,b.id`, x.endpoint, x.kind)
		a, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		b, err := json.Marshal(want)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(a)
		if int64(len(got)) != x.count || !bytes.Equal(a, b) || !bytes.Equal(sum[:], x.hash) {
			t.Fatalf("proof %s %s differs: %s vs %s", x.kind, x.endpoint, a, b)
		}
	}
}

// commitReceiptLoss observes the actual PostgreSQL CommandComplete before
// dropping it. The source transaction commits, but the client cannot confirm it.
type commitReceiptLoss struct {
	armed    atomic.Bool
	observed atomic.Bool
}

func (l *commitReceiptLoss) TraceQueryStart(ctx context.Context, _ *pgx.Conn, q pgx.TraceQueryStartData) context.Context {
	if strings.EqualFold(strings.TrimSpace(q.SQL), "commit") {
		l.armed.Store(true)
	}
	return ctx
}
func (l *commitReceiptLoss) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

type dropCommitConn struct {
	net.Conn
	loss *commitReceiptLoss
}

func (c *dropCommitConn) Read(p []byte) (int, error) {
	if !c.loss.armed.Load() {
		return c.Conn.Read(p)
	}
	var received []byte
	for len(received) < 4096 {
		n, err := c.Conn.Read(p)
		received = append(received, p[:n]...)
		if bytes.Contains(received, []byte("COMMIT\x00")) {
			c.loss.observed.Store(true)
			return 0, io.ErrUnexpectedEOF
		}
		if err != nil {
			return 0, err
		}
	}
	return 0, errors.New("commit response lacked CommandComplete")
}
func TestWebhookCommittedFactsSurviveLostSourceReceipt(t *testing.T) {
	f := newCaptureInterleavingFixture(t)
	loss := &commitReceiptLoss{}
	config := f.db.Pool.Config().Copy()
	config.ConnConfig.Tracer = loss
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		c, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &dropCommitConn{Conn: c, loss: loss}, nil
	}
	pool, err := pgxpool.NewWithConfig(f.ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	s := NewTasks(&postgres.Store{Pool: pool}, f.capture)
	_, err = s.SetStatus(f.ctx, f.principal, f.project, f.task.ID, taskcore.SetTaskStatus{Version: f.task.Version, Status: model.TaskInProgress})
	var failure *store.TransactionError
	if err == nil || !loss.observed.Load() || !errors.As(err, &failure) || failure.Outcome != store.TransactionUnknown || !failure.CommitAttempted {
		t.Fatalf("outcome=%+v observed=%t error=%v", failure, loss.observed.Load(), err)
	}
	var status string
	var events, deliveries, matches int
	var id string
	var body, hash []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.body,d.body_sha256,t.status,e.id::text,(SELECT count(*) FROM webhook_events WHERE task_id=t.id),(SELECT count(*) FROM webhook_deliveries WHERE event_id=e.id),(SELECT count(*) FROM webhook_delivery_matches m JOIN webhook_deliveries d ON d.id=m.delivery_id WHERE d.event_id=e.id) FROM tasks t JOIN webhook_events e ON e.task_id=t.id JOIN webhook_deliveries d ON d.event_id=e.id WHERE t.id=$1`, f.task.ID).Scan(&body, &hash, &status, &id, &events, &deliveries, &matches); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	decoded, _, decodeErr := protocol.Decode(body)
	if status != "in_progress" || events != 1 || deliveries != 1 || matches != 1 || id == "" || !bytes.Equal(sum[:], hash) || decodeErr != nil || decoded != id {
		t.Fatalf("committed status=%s event=%s counts=%d/%d/%d", status, id, events, deliveries, matches)
	}
	var subscription, binding, project, kind string
	var epoch int64
	var proof []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT m.subscription_id::text,m.binding_id::text,m.project_id::text,m.event_type,m.authorization_epoch,d.original_match_sha256 FROM webhook_delivery_matches m JOIN webhook_deliveries d ON d.id=m.delivery_id WHERE d.event_id=$1`, id).Scan(&subscription, &binding, &project, &kind, &epoch, &proof); err != nil {
		t.Fatal(err)
	}
	proofBytes, err := json.Marshal([][5]string{{subscription, binding, project, kind, strconv.FormatInt(epoch, 10)}})
	if err != nil {
		t.Fatal(err)
	}
	proofHash := sha256.Sum256(proofBytes)
	if !bytes.Equal(proofHash[:], proof) {
		t.Fatal("committed original proof hash mismatch")
	}
}

func TestWebhookDeferredStepFailureRollsBackSourceAndCapture(t *testing.T) {
	f := newCaptureInterleavingFixture(t)
	steps := NewTaskSteps(f.db, f.capture)
	first, err := steps.Add(f.ctx, f.principal, f.project, f.task.ID, AddTaskStep{Version: f.task.Version, ID: "00000001", Title: "first"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := steps.Add(f.ctx, f.principal, f.project, f.task.ID, AddTaskStep{Version: first.Resource.Version, ID: "00000002", Title: "second"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.db.Pool.Exec(f.ctx, `CREATE FUNCTION break_position_on_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE task_steps SET position=0 WHERE task_id=NEW.task_id AND id='00000002'; RETURN NEW; END $$; CREATE TRIGGER break_position AFTER INSERT ON webhook_events FOR EACH ROW EXECUTE FUNCTION break_position_on_capture()`)
	if err != nil {
		t.Fatal(err)
	}
	title := "changed"
	result, err := steps.Update(f.ctx, f.principal, f.project, f.task.ID, "00000001", UpdateTaskStep{Version: second.Resource.Version, Title: &title})
	var pgErr *pgconn.PgError
	var failure *store.TransactionError
	if err == nil || !errors.As(err, &pgErr) || pgErr.Code != "23505" || !errors.As(err, &failure) || !failure.CommitAttempted || result.JSON != nil {
		t.Fatalf("commit failure: %+v %v", result, err)
	}
	var version int64
	var stored string
	var events, positions int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT t.version,(SELECT title FROM task_steps WHERE task_id=t.id AND id='00000001'),(SELECT count(*) FROM webhook_events WHERE task_id=t.id),(SELECT count(DISTINCT position) FROM task_steps WHERE task_id=t.id) FROM tasks t WHERE t.id=$1`, f.task.ID).Scan(&version, &stored, &events, &positions); err != nil {
		t.Fatal(err)
	}
	if version != second.Resource.Version || stored != "first" || events != 2 || positions != 2 {
		t.Fatalf("rollback: version=%d title=%s events=%d positions=%d", version, stored, events, positions)
	}
}

type capturePIDTracer struct{ pid chan uint32 }

func (p *capturePIDTracer) TraceQueryStart(ctx context.Context, c *pgx.Conn, q pgx.TraceQueryStartData) context.Context {
	if strings.Contains(q.SQL, "WITH facts AS MATERIALIZED") {
		select {
		case p.pid <- c.PgConn().PID():
		default:
		}
	}
	return ctx
}
func (*capturePIDTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}
func TestWebhookThreadCaptureDoesNotReverseProjectLock(t *testing.T) {
	f := newCaptureInterleavingFixture(t)
	trace := &capturePIDTracer{pid: make(chan uint32, 1)}
	cfg := f.db.Pool.Config().Copy()
	cfg.ConnConfig.Tracer = trace
	pool, err := pgxpool.NewWithConfig(f.ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	gate := &frozenGate{inner: f.capture, frozen: make(chan struct{}), release: make(chan struct{})}
	threadDone := make(chan error, 1)
	deleteDone := make(chan error, 1)
	go func() {
		_, err := NewTaskThreads(&postgres.Store{Pool: pool}, gate).Post(f.ctx, f.principal, f.project, f.task.ID, CreateThreadMessage{Body: "lock order"})
		threadDone <- err
	}()
	waitGate(t, f.ctx, gate.frozen)
	var pid uint32
	select {
	case pid = <-trace.pid:
	case <-f.ctx.Done():
		close(gate.release)
		t.Fatal(f.ctx.Err())
	}
	go func() {
		deleteDone <- NewTasks(f.db, f.capture).Delete(f.ctx, f.principal, f.project, f.task.ID, taskcore.DeleteTask{Version: f.task.Version})
	}()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	blocked := false
	for !blocked {
		if err = f.db.Pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM tasks%' AND wait_event_type='Lock')`, int32(pid)).Scan(&blocked); err != nil {
			close(gate.release)
			t.Fatal(err)
		}
		if !blocked {
			select {
			case <-ticker.C:
			case <-f.ctx.Done():
				close(gate.release)
				t.Fatal(f.ctx.Err())
			}
		}
	}
	close(gate.release)
	select {
	case err = <-threadDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-f.ctx.Done():
		t.Fatal(f.ctx.Err())
	}
	select {
	case err = <-deleteDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-f.ctx.Done():
		t.Fatal(f.ctx.Err())
	}
	var threads, deletes int
	var version int64
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_events WHERE task_id=$1 AND event_type='task.thread_posted'),(SELECT count(*) FROM webhook_events WHERE task_id=$1 AND event_type='task.deleted'),(SELECT version FROM tasks WHERE id=$1)`, f.task.ID).Scan(&threads, &deletes, &version); err != nil {
		t.Fatal(err)
	}
	if threads != 1 || deletes != 1 || version != f.task.Version+1 {
		t.Fatalf("thread=%d deletion=%d version=%d", threads, deletes, version)
	}
}

func TestWebhookCaptureSurvivesProcessExit(t *testing.T) {
	if os.Getenv("DAYNIGHT_WEBHOOK_EXIT_CHILD") == "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		db, err := postgres.Open(ctx, os.Getenv("DAYNIGHT_WEBHOOK_EXIT_DB"))
		if err != nil {
			t.Fatal(err)
		}
		key := base64.StdEncoding.EncodeToString(make([]byte, 32))
		keys, err := secretbox.Parse([]byte(`{"activeKeyId":"primary","keys":{"primary":"` + key + `"}}`))
		if err != nil {
			t.Fatal(err)
		}
		version, err := strconv.ParseInt(os.Getenv("DAYNIGHT_WEBHOOK_EXIT_VERSION"), 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		principal := model.Principal{Kind: model.SessionCredential, UserID: os.Getenv("DAYNIGHT_WEBHOOK_EXIT_USER"), CredentialID: os.Getenv("DAYNIGHT_WEBHOOK_EXIT_SESSION")}
		_, err = NewTasks(db, &webhook.Capturer{Keys: keys}).SetStatus(ctx, principal, os.Getenv("DAYNIGHT_WEBHOOK_EXIT_PROJECT"), os.Getenv("DAYNIGHT_WEBHOOK_EXIT_TASK"), taskcore.SetTaskStatus{Version: version, Status: model.TaskInProgress})
		if err != nil {
			t.Fatal(err)
		}
		os.Exit(0)
	}
	f := newCaptureInterleavingFixture(t)
	command := exec.CommandContext(f.ctx, os.Args[0], "-test.run=^TestWebhookCaptureSurvivesProcessExit$", "-test.count=1")
	command.Env = append(os.Environ(), "DAYNIGHT_WEBHOOK_EXIT_CHILD=1", "DAYNIGHT_WEBHOOK_EXIT_DB="+f.db.Pool.Config().ConnString(), "DAYNIGHT_WEBHOOK_EXIT_VERSION="+strconv.FormatInt(f.task.Version, 10), "DAYNIGHT_WEBHOOK_EXIT_USER="+f.principal.UserID, "DAYNIGHT_WEBHOOK_EXIT_SESSION="+f.principal.CredentialID, "DAYNIGHT_WEBHOOK_EXIT_PROJECT="+f.project, "DAYNIGHT_WEBHOOK_EXIT_TASK="+f.task.ID)
	out, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("child exited: %v %s", err, out)
	}
	// Open a separate pool after child exit; no process-owned in-memory state is reused.
	reopened, err := pgxpool.New(f.ctx, f.db.Pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	var id string
	var body, hash []byte
	var matches int
	if err = reopened.QueryRow(f.ctx, `SELECT e.id::text,d.body,d.body_sha256,(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=d.id) FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.task_id=$1`, f.task.ID).Scan(&id, &body, &hash, &matches); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	decoded, _, err := protocol.Decode(body)
	if err != nil || decoded != id || matches != 1 || !bytes.Equal(sum[:], hash) {
		t.Fatalf("reopened id=%s matches=%d decode=%v", id, matches, err)
	}
}

func TestWebhookNewSubscriptionAfterFreezeCannotAddProof(t *testing.T) {
	f := newCaptureInterleavingFixture(t)
	var original string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text FROM webhook_subscriptions WHERE endpoint_id=$1 AND deleted_at IS NULL`, f.endpoint).Scan(&original); err != nil {
		t.Fatal(err)
	}
	gate := &frozenGate{inner: f.capture, frozen: make(chan struct{}), release: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		_, err := NewTaskThreads(f.db, gate).Post(f.ctx, f.principal, f.project, f.task.ID, CreateThreadMessage{Body: "snapshot"})
		done <- err
	}()
	waitGate(t, f.ctx, gate.frozen)
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: f.endpoint, IfVersion: 1, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, RequestSHA256: strings.Repeat("c", 64), HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{
		{ID: &original, ProjectID: f.project, EventTypes: append([]string(nil), corewebhook.EventTypes[:]...)},
		{ProjectID: f.project, EventTypes: []string{protocol.ThreadPosted}},
	}}
	_, err := f.config.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m)
	if err != nil {
		close(gate.release)
		t.Fatal(err)
	}
	close(gate.release)
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	var count, subscriptions, matches int
	var matched string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.original_match_count,(SELECT count(*) FROM webhook_subscriptions WHERE endpoint_id=$1 AND deleted_at IS NULL),(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=d.id),(SELECT subscription_id::text FROM webhook_delivery_matches WHERE delivery_id=d.id) FROM webhook_deliveries d WHERE endpoint_id=$1`, f.endpoint).Scan(&count, &subscriptions, &matches, &matched); err != nil {
		t.Fatal(err)
	}
	if count != 1 || subscriptions != 2 || matches != 1 || matched != original {
		t.Fatalf("count=%d subscriptions=%d matches=%d matched=%s original=%s", count, subscriptions, matches, matched, original)
	}
}

func TestWebhookThreadSameTimestampOrderedIDAndReply(t *testing.T) {
	f := newCaptureInterleavingFixture(t)
	threads := NewTaskThreads(f.db, f.capture)
	first, err := threads.Post(f.ctx, f.principal, f.project, f.task.ID, CreateThreadMessage{Body: "original"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.db.Pool.Exec(f.ctx, `CREATE FUNCTION same_thread_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.created_at := (SELECT last_created_at FROM task_threads WHERE task_id=NEW.task_id); NEW.message_id := 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid; RETURN NEW; END $$; CREATE TRIGGER same_thread_timestamp BEFORE INSERT ON task_thread_messages FOR EACH ROW EXECUTE FUNCTION same_thread_timestamp()`)
	if err != nil {
		t.Fatal(err)
	}
	second, err := threads.Post(f.ctx, f.principal, f.project, f.task.ID, CreateThreadMessage{Body: "reply", ReplyTo: &first.Message.ID})
	if err != nil {
		t.Fatal(err)
	}
	if !first.Message.CreatedAt.Equal(second.Message.CreatedAt) || first.Message.ID >= second.Message.ID || second.Message.ReplyTo == nil || *second.Message.ReplyTo != first.Message.ID {
		t.Fatalf("first=%+v second=%+v", first.Message, second.Message)
	}
	var body []byte
	var version int64
	var storedVersion *int64
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.body,e.task_version,(SELECT version FROM tasks WHERE id=$1) FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.message_id=$2`, f.task.ID, second.Message.ID).Scan(&body, &storedVersion, &version); err != nil {
		t.Fatal(err)
	}
	_, fact, err := protocol.Decode(body)
	if err != nil || storedVersion != nil || version != f.task.Version || fact.MessageID != second.Message.ID || fact.CreatedAt == nil || !fact.CreatedAt.Equal(first.Message.CreatedAt) || fact.ReplyTo == nil || *fact.ReplyTo != first.Message.ID {
		t.Fatalf("body=%s fact=%+v version=%d stored=%v error=%v", body, fact, version, storedVersion, err)
	}
}

func TestWebhookDeletionBeforeThreadRejectsWithoutCapture(t *testing.T) {
	f := newCaptureInterleavingFixture(t)
	if err := NewTasks(f.db, f.capture).Delete(f.ctx, f.principal, f.project, f.task.ID, taskcore.DeleteTask{Version: f.task.Version}); err != nil {
		t.Fatal(err)
	}
	_, err := NewTaskThreads(f.db, f.capture).Post(f.ctx, f.principal, f.project, f.task.ID, CreateThreadMessage{Body: "rejected"})
	if err == nil {
		t.Fatal("thread accepted deleted task")
	}
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "task_deleted" {
		t.Fatalf("unexpected fault: %v", err)
	}
	var deleted, thread, messages, heads int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_events WHERE task_id=$1 AND event_type='task.deleted'),(SELECT count(*) FROM webhook_events WHERE task_id=$1 AND event_type='task.thread_posted'),(SELECT count(*) FROM task_thread_messages WHERE task_id=$1),(SELECT count(*) FROM task_threads WHERE task_id=$1)`, f.task.ID).Scan(&deleted, &thread, &messages, &heads); err != nil {
		t.Fatal(err)
	}
	if deleted != 1 || thread != 0 || messages != 0 || heads != 0 {
		t.Fatalf("deleted=%d thread=%d messages=%d heads=%d", deleted, thread, messages, heads)
	}
}

type preparedGate struct {
	inner    Capturer
	prepared chan struct{}
	release  chan struct{}
	event    store.WebhookCapturedEvent
	delivery store.WebhookCapturedDelivery
}

func (g *preparedGate) CaptureBatch(ctx context.Context, d store.WebhookCaptureDAO, f []protocol.Fact) error {
	return g.inner.CaptureBatch(ctx, &preparedGateDAO{WebhookCaptureDAO: d, gate: g}, f)
}

type preparedGateDAO struct {
	store.WebhookCaptureDAO
	gate *preparedGate
}

func (d *preparedGateDAO) SaveCapture(ctx context.Context, event store.WebhookCapturedEvent, deliveries []store.WebhookCapturedDelivery) error {
	if len(deliveries) != 1 {
		return errors.New("expected one delivery")
	}
	d.gate.event = event
	d.gate.event.FactBytes = bytes.Clone(event.FactBytes)
	d.gate.delivery = deliveries[0]
	d.gate.delivery.Body = bytes.Clone(deliveries[0].Body)
	d.gate.delivery.BodySHA256 = bytes.Clone(deliveries[0].BodySHA256)
	d.gate.delivery.OriginalMatchSHA256 = bytes.Clone(deliveries[0].OriginalMatchSHA256)
	d.gate.delivery.Matches = append([]store.WebhookCapturedMatch(nil), deliveries[0].Matches...)
	close(d.gate.prepared)
	select {
	case <-d.gate.release:
		return d.WebhookCaptureDAO.SaveCapture(ctx, event, deliveries)
	case <-ctx.Done():
		return ctx.Err()
	}
}
func TestWebhookPreparedBytesAndProofSurviveConfigurationCommit(t *testing.T) {
	f := newCaptureInterleavingFixture(t)
	gate := &preparedGate{inner: f.capture, prepared: make(chan struct{}), release: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		_, err := NewTaskThreads(f.db, gate).Post(f.ctx, f.principal, f.project, f.task.ID, CreateThreadMessage{Body: "snapshot"})
		done <- err
	}()
	waitGate(t, f.ctx, gate.prepared)
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: f.endpoint, IfVersion: 1, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, RequestSHA256: strings.Repeat("d", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/new"}}
	_, err := f.config.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m)
	if err != nil {
		close(gate.release)
		t.Fatal(err)
	}
	close(gate.release)
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	var eventID string
	var fact, body, bodyHash, proofHash []byte
	var count int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT e.id::text,e.fact_bytes,d.body,d.body_sha256,d.original_match_sha256,d.original_match_count FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.task_id=$1`, f.task.ID).Scan(&eventID, &fact, &body, &bodyHash, &proofHash, &count); err != nil {
		t.Fatal(err)
	}
	if eventID != gate.event.ID || count != len(gate.delivery.Matches) || !bytes.Equal(fact, gate.event.FactBytes) || !bytes.Equal(body, gate.delivery.Body) || !bytes.Equal(bodyHash, gate.delivery.BodySHA256) || !bytes.Equal(proofHash, gate.delivery.OriginalMatchSHA256) {
		t.Fatal("frozen facts, body or proof changed after configuration commit")
	}
	var sub, binding, project, kind string
	var epoch int64
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT subscription_id::text,binding_id::text,project_id::text,event_type,authorization_epoch FROM webhook_delivery_matches WHERE delivery_id=$1`, gate.delivery.ID).Scan(&sub, &binding, &project, &kind, &epoch); err != nil {
		t.Fatal(err)
	}
	expected := gate.delivery.Matches[0]
	if sub != expected.SubscriptionID || binding != expected.BindingID || project != expected.ProjectID || kind != expected.EventType || epoch != expected.AuthorizationEpoch {
		t.Fatal("frozen match tuple changed")
	}
	proof, err := json.Marshal([][5]string{{sub, binding, project, kind, strconv.FormatInt(epoch, 10)}})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(proof)
	if !bytes.Equal(sum[:], proofHash) {
		t.Fatal("proof hash differs from frozen tuple")
	}
}

func TestWebhookWorkerLocalPauseDoesNotPublishTaskPause(t *testing.T) {
	f := newCaptureInterleavingFixture(t)
	s := NewTasks(f.db, f.capture)
	allowed := true
	current, err := s.Update(f.ctx, f.principal, f.project, f.task.ID, taskcore.UpdateTask{Version: f.task.Version, AssignedTo: func() **string { p := &f.principal.UserID; return &p }()})
	if err != nil {
		t.Fatal(err)
	}
	current, err = s.Update(f.ctx, f.principal, f.project, current.ID, taskcore.UpdateTask{Version: current.Version, AllowAgents: &allowed})
	if err != nil {
		t.Fatal(err)
	}
	descriptor := taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, WorktreeID: uuid.NewString()}
	current, err = s.ClaimWorker(f.ctx, f.principal, f.project, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor})
	if err != nil {
		t.Fatal(err)
	}
	paused := model.WorkerPaused
	current, err = s.UpdateWorker(f.ctx, f.principal, f.project, current.ID, taskcore.UpdateWorker{Version: current.Version, ClaimID: descriptor.ClaimID, Phase: &paused})
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_events WHERE task_id=$1 AND event_type='task.paused'`, current.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("local pause events=%d err=%v", count, err)
	}
}
