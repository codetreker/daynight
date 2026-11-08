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
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type testResolver struct{}

func (testResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
}

type observedRequest struct {
	body                            []byte
	id, timestamp, signature, media string
}

func TestDeliveryRealCaptureTLSAndSignature(t *testing.T) {
	requests := make(chan observedRequest, 1)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read receiver body: %v", err)
		}
		requests <- observedRequest{b, r.Header.Get("Webhook-Id"), r.Header.Get("Webhook-Timestamp"), r.Header.Get("Webhook-Signature"), r.Header.Get("Content-Type")}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	f := newCaptureFixture(t, 1)
	var endpoint, keyID string
	var version int64
	var key []byte
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT e.id::text,e.config_version,k.id::text,k.secret FROM webhook_endpoints e JOIN webhook_signing_keys k ON k.id=e.active_key_id`).Scan(&endpoint, &version, &keyID, &key); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL + "/hook"}}
	if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	tasks := taskservice.NewTasks(f.db, f.capture)
	if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "delivery source"}); err != nil {
		t.Fatal(err)
	}
	var delivery, event string
	var original []byte
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,event_id::text,body FROM webhook_deliveries`).Scan(&delivery, &event, &original); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner := webhook.NewRunner(f.db, svc, true)
	if os.Getenv("DAYNIGHT_T07_LOG_STDERR") == "1" {
		runner.Logger = slog.New(slog.NewJSONHandler(os.Stderr, nil))
	}
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	var got observedRequest
	select {
	case got = <-requests:
	case err := <-runner.Failures():
		t.Fatalf("runner failure: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("receiver did not receive request")
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(got.body, &body); err != nil {
		t.Fatal(err)
	}
	if got.id != event || body.ID != event || !bytes.Equal(got.body, original) || got.media != "application/cloudevents+json" {
		t.Fatalf("incorrect request identity, bytes or type")
	}
	mac := hmac.New(sha256.New, key)
	fmt.Fprintf(mac, "%s.%s.", got.id, got.timestamp)
	mac.Write(got.body)
	if got.signature != "v1,"+base64.StdEncoding.EncodeToString(mac.Sum(nil)) {
		t.Fatal("signature did not verify")
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var state string
		var outcome *string
		var count int
		err := f.db.Pool.QueryRow(f.ctx, `SELECT d.state,a.outcome,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=d.id) FROM webhook_deliveries d LEFT JOIN webhook_attempts a ON a.delivery_id=d.id WHERE d.id=$1`, delivery).Scan(&state, &outcome, &count)
		if err != nil {
			t.Fatal(err)
		}
		if state == "delivered" && outcome != nil && *outcome == "acknowledged" && count == 1 {
			return
		}
		select {
		case err := <-runner.Failures():
			t.Fatalf("runner failure: %v", err)
		case <-time.After(20 * time.Millisecond):
		}
	}
	t.Fatal("acknowledgement was not persisted")
}

func TestDeliveryAttemptInsertFailureNeverSends(t *testing.T) {
	requests := make(chan struct{}, 1)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests <- struct{}{}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	f := newCaptureFixture(t, 1)
	var endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}}
	if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "delivery source"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `CREATE FUNCTION refuse_webhook_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected attempt failure'; END $$; CREATE TRIGGER refuse_webhook_attempt BEFORE INSERT ON webhook_attempts FOR EACH ROW EXECUTE FUNCTION refuse_webhook_attempt()`); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner := webhook.NewRunner(f.db, svc, true)
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	}()
	select {
	case <-runner.Failures():
	case <-time.After(10 * time.Second):
		t.Fatal("attempt failure was not reported")
	}
	var attempts, automatic, sequence int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_attempts), automatic_attempt_count, attempt_sequence FROM webhook_deliveries`).Scan(&attempts, &automatic, &sequence); err != nil {
		t.Fatal(err)
	}
	if attempts != 0 || automatic != 0 || sequence != 0 {
		t.Fatalf("admission partially committed: attempts=%d automatic=%d sequence=%d", attempts, automatic, sequence)
	}
	select {
	case <-requests:
		t.Fatal("request was sent despite failed admission")
	default:
	}
}

func TestDeliveryOldDestinationDoesNotRevive(t *testing.T) {
	requests := make(chan struct{}, 1)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests <- struct{}{}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	f := newCaptureFixture(t, 1)
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "original target"}); err != nil {
		t.Fatal(err)
	}
	var endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
	for _, destination := range []string{receiver.URL, "https://receiver.example/hook"} {
		m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: destination}}
		if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
			t.Fatal(err)
		}
		version++
	}
	// An upgrade initializes current revision rows only; old captured work may lack one.
	if _, err := f.db.Pool.Exec(f.ctx, `DELETE FROM webhook_endpoint_waits WHERE endpoint_id=$1 AND destination_revision=1`, endpoint); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner := webhook.NewRunner(f.db, svc, true)
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	}()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var state string
		var count int
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT state,(SELECT count(*) FROM webhook_attempts) FROM webhook_deliveries`).Scan(&state, &count); err != nil {
			t.Fatal(err)
		}
		if state == "suppressed" {
			if count != 0 {
				t.Fatalf("old destination admitted %d attempts", count)
			}
			select {
			case <-requests:
				t.Fatal("old destination was sent")
			default:
				return
			}
		}
		select {
		case err := <-runner.Failures():
			t.Fatalf("runner failure: %v", err)
		case <-time.After(20 * time.Millisecond):
		}
	}
	t.Fatal("old destination was not suppressed")
}

func TestDeliveryRetryAfterPreservesBytes(t *testing.T) {
	requests := make(chan observedRequest, 2)
	var count atomic.Int32
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read receiver body: %v", err)
		}
		requests <- observedRequest{b, r.Header.Get("Webhook-Id"), r.Header.Get("Webhook-Timestamp"), r.Header.Get("Webhook-Signature"), r.Header.Get("Content-Type")}
		if count.Add(1) == 1 {
			w.Header().Set("Retry-After", "6")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	f := newCaptureFixture(t, 1)
	var endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	var keyID string
	var key []byte
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT k.id::text,k.secret FROM webhook_signing_keys k JOIN webhook_endpoints e ON e.active_key_id=k.id WHERE e.id=$1`, endpoint).Scan(&keyID, &key); err != nil {
		t.Fatal(err)
	}

	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}}
	if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "retry source"}); err != nil {
		t.Fatal(err)
	}
	// Use a near-future second slot so this test observes the receiver's wait.
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET automatic_schedule_at[2]=occurred_at+interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner := webhook.NewRunner(f.db, svc, true)
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	}()
	var first, second observedRequest
	select {
	case first = <-requests:
	case err := <-runner.Failures():
		t.Fatalf("runner failure: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("first request missing")
	}
	var waitUntil time.Time
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var wait *time.Time
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT not_before FROM webhook_endpoint_waits WHERE endpoint_id=$1 AND destination_revision=2`, endpoint).Scan(&wait); err != nil {
			t.Fatal(err)
		}
		if wait != nil {
			waitUntil = *wait
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if waitUntil.IsZero() {
		t.Fatal("receiver wait was not persisted")
	}
	select {
	case <-requests:
		t.Fatal("retry ignored receiver wait")
	case err := <-runner.Failures():
		t.Fatalf("runner failure: %v", err)
	case <-time.After(3 * time.Second):
	}
	select {
	case second = <-requests:
	case err := <-runner.Failures():
		t.Fatalf("runner failure: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("retry missing")
	}
	if time.Now().Before(waitUntil) || first.id != second.id || !bytes.Equal(first.body, second.body) || first.timestamp == second.timestamp {
		t.Fatalf("retry changed event bytes or violated waiting")
	}
	for _, request := range []observedRequest{first, second} {
		mac := hmac.New(sha256.New, key)
		fmt.Fprintf(mac, "%s.%s.", request.id, request.timestamp)
		mac.Write(request.body)
		if request.signature != "v1,"+base64.StdEncoding.EncodeToString(mac.Sum(nil)) {
			t.Fatal("retry signature did not verify")
		}
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var state string
		var attempts, sameRevision int
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.state,count(a.id),count(a.id) FILTER(WHERE a.destination_revision=d.destination_revision AND d.destination_revision=2) FROM webhook_deliveries d LEFT JOIN webhook_attempts a ON a.delivery_id=d.id GROUP BY d.id`).Scan(&state, &attempts, &sameRevision); err != nil {
			t.Fatal(err)
		}
		if state == "delivered" && attempts == 2 && sameRevision == 2 {
			return
		}
		select {
		case err := <-runner.Failures():
			t.Fatalf("runner failure: %v", err)
		case <-time.After(20 * time.Millisecond):
		}
	}
	t.Fatal("retry attempts or destination revision not retained")
}

type heldRemovalStore struct {
	*postgres.Store
	held, release chan struct{}
}

func (s heldRemovalStore) WriteTeam(ctx context.Context, id string, work func(store.TeamWriteScope) error) (store.Completion, error) {
	return s.Store.WriteTeam(ctx, id, func(sc store.TeamWriteScope) error {
		if err := work(sc); err != nil {
			return err
		}
		close(s.held)
		select {
		case <-s.release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
}

func TestDeliveryRevocationWinsAdmission(t *testing.T) {
	f := newCaptureFixture(t, 1)
	var team string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, f.project).Scan(&team); err != nil {
		t.Fatal(err)
	}
	admin, session := uuid.NewString(), uuid.NewString()
	hash := sha256.Sum256([]byte(session))
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, []any{admin}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, admin, hash[:]}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, admin}},
		{`UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, []any{team, f.principal.UserID}},
	} {
		if _, err := f.db.Pool.Exec(f.ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}

	principal := model.Principal{Kind: model.SessionCredential, UserID: admin, CredentialID: session}
	var memberVersion int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT version FROM team_members WHERE team_id=$1 AND user_id=$2`, team, f.principal.UserID).Scan(&memberVersion); err != nil {
		t.Fatal(err)
	}
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "revocation source"}); err != nil {
		t.Fatal(err)
	}
	held, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	done := make(chan error, 1)
	go func() {
		_, err := teamservice.NewTeams(heldRemovalStore{f.db, held, release}).RemoveMember(f.ctx, principal, team, f.principal.UserID, coreteam.ChangeTeamMember{Version: memberVersion, ExpectedUserID: admin})
		done <- err
	}()
	select {
	case <-held:
	case err := <-done:
		t.Fatalf("remove failed: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("removal did not hold source lock")
	}
	svc := &webhook.Service{DB: f.db}
	runner := webhook.NewRunner(f.db, svc, true)
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	}()
	var application string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT current_setting('application_name')`).Scan(&application); err != nil {
		t.Fatal(err)
	}
	blocked := false
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid))>0)`, application).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("admission never waited on the removal transaction")
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("removal did not commit")
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var state string
		var attempts int
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT state,(SELECT count(*) FROM webhook_attempts) FROM webhook_deliveries`).Scan(&state, &attempts); err != nil {
			t.Fatal(err)
		}
		if state == "suppressed" {
			if attempts != 0 {
				t.Fatalf("revoked source admitted %d attempts", attempts)
			}
			return
		}
		select {
		case err := <-runner.Failures():
			t.Fatalf("runner failure: %v", err)
		case <-time.After(20 * time.Millisecond):
		}
	}
	t.Fatal("revoked delivery not suppressed")
}

func TestDeliveryAdmissionBeforeRevocationPreservesAcknowledgement(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(entered)
		<-release
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	f := newCaptureFixture(t, 1)
	var team, endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, f.project).Scan(&team); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	admin, session := uuid.NewString(), uuid.NewString()
	hash := sha256.Sum256([]byte(session))
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, []any{admin}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, admin, hash[:]}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, admin}},
		{`UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, []any{team, f.principal.UserID}},
	} {
		if _, err := f.db.Pool.Exec(f.ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}}
	if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "admitted source"}); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner := webhook.NewRunner(f.db, svc, true)
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	}()
	select {
	case <-entered:
	case err := <-runner.Failures():
		t.Fatalf("runner failure: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("admitted request missing")
	}
	var memberVersion int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT version FROM team_members WHERE team_id=$1 AND user_id=$2`, team, f.principal.UserID).Scan(&memberVersion); err != nil {
		t.Fatal(err)
	}
	p := model.Principal{Kind: model.SessionCredential, UserID: admin, CredentialID: session}
	if _, err := teamservice.NewTeams(f.db).RemoveMember(f.ctx, p, team, f.principal.UserID, coreteam.ChangeTeamMember{Version: memberVersion, ExpectedUserID: admin}); err != nil {
		t.Fatal(err)
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var state string
		var outcome *string
		var count int
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.state,a.outcome,(SELECT count(*) FROM webhook_attempts) FROM webhook_deliveries d LEFT JOIN webhook_attempts a ON a.delivery_id=d.id`).Scan(&state, &outcome, &count); err != nil {
			t.Fatal(err)
		}
		if state == "delivered" && outcome != nil && *outcome == "acknowledged" && count == 1 {
			return
		}
		select {
		case err := <-runner.Failures():
			t.Fatalf("runner failure: %v", err)
		case <-time.After(20 * time.Millisecond):
		}
	}
	t.Fatal("admitted acknowledgement was not retained")
}

func TestDeliveryTaskAndStepDeletionAnchors(t *testing.T) {
	requests := make(chan []byte, 8)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		requests <- b
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	f := newCaptureFixture(t, 1)
	var endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}}
	if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	tasks := taskservice.NewTasks(f.db, f.capture)
	steps := taskservice.NewTaskSteps(f.db, f.capture)
	active, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "active source"})
	if err != nil {
		t.Fatal(err)
	}
	added, err := steps.Add(f.ctx, f.principal, f.project, active.ID, taskservice.AddTaskStep{Version: active.Version, ID: "00000001", Title: "step"})
	if err != nil {
		t.Fatal(err)
	}
	removed, err := steps.Delete(f.ctx, f.principal, f.project, active.ID, "00000001", taskservice.DeleteTaskStep{Version: added.Resource.Version})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tasks.Update(f.ctx, f.principal, f.project, active.ID, taskcore.UpdateTask{Version: removed.Resource.Version, Properties: model.TaskPropertiesPatch{"paused": json.RawMessage(`true`)}}); err != nil {
		t.Fatal(err)
	}
	gone, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "deleted source"})
	if err != nil {
		t.Fatal(err)
	}
	if err = tasks.Delete(f.ctx, f.principal, f.project, gone.ID, taskcore.DeleteTask{Version: gone.Version}); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner := webhook.NewRunner(f.db, svc, true)
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err = runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	}()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var delivered, suppressed int
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FILTER(WHERE state='delivered'),count(*) FILTER(WHERE state='suppressed') FROM webhook_deliveries`).Scan(&delivered, &suppressed); err != nil {
			t.Fatal(err)
		}
		if delivered == 5 && suppressed == 1 {
			break
		}
		select {
		case err := <-runner.Failures():
			t.Fatalf("runner failure: %v", err)
		case <-time.After(20 * time.Millisecond):
		}
	}
	var delivered, suppressed int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FILTER(WHERE state='delivered'),count(*) FILTER(WHERE state='suppressed') FROM webhook_deliveries`).Scan(&delivered, &suppressed); err != nil || delivered != 5 || suppressed != 1 {
		t.Fatalf("states delivered=%d suppressed=%d err=%v", delivered, suppressed, err)
	}
	seen := map[string]bool{}
	for i := 0; i < 5; i++ {
		var event struct {
			Type string `json:"type"`
			Data struct {
				Action string `json:"action"`
			} `json:"data"`
		}
		if err := json.Unmarshal(<-requests, &event); err != nil {
			t.Fatal(err)
		}
		seen[event.Type+"/"+event.Data.Action] = true
	}
	for _, key := range []string{"cc.daynight.task.deleted.v1/", "cc.daynight.task.paused.v1/", "cc.daynight.task.step_updated.v1/deleted"} {
		if !seen[key] {
			t.Fatalf("missing delivered event %s", key)
		}
	}
}

func TestDeliveryOriginalProofContinuity(t *testing.T) {
	for _, scenario := range []string{"new_only", "one_retained", "binding_readded"} {
		t.Run(scenario, func(t *testing.T) {
			requests := make(chan struct{}, 2)
			receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests <- struct{}{}
				w.WriteHeader(http.StatusAccepted)
			}))
			defer receiver.Close()
			f := newCaptureFixture(t, 2)
			svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
			var endpoint string
			var version int64
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
				t.Fatal(err)
			}
			update := func(subs []corewebhook.SubscriptionInput, destination *webhook.Destination) {
				t.Helper()
				m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: destination, HasSubscriptions: subs != nil, Subscriptions: subs}
				if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
					t.Fatal(err)
				}
				version++
			}
			update(nil, &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL})
			if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "original proof"}); err != nil {
				t.Fatal(err)
			}
			rows, err := f.db.Pool.Query(f.ctx, `SELECT id::text FROM webhook_subscriptions WHERE endpoint_id=$1 AND deleted_at IS NULL ORDER BY id`, endpoint)
			if err != nil {
				t.Fatal(err)
			}
			var ids []string
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					t.Fatal(err)
				}
				ids = append(ids, id)
			}
			rows.Close()
			if err := rows.Err(); err != nil || len(ids) != 2 {
				t.Fatalf("subscriptions=%v err=%v", ids, err)
			}
			newSub := corewebhook.SubscriptionInput{ProjectID: f.project, EventTypes: []string{"task.created"}}
			switch scenario {
			case "new_only":
				update([]corewebhook.SubscriptionInput{newSub}, nil)
			case "one_retained":
				update([]corewebhook.SubscriptionInput{{ID: &ids[1], ProjectID: f.project, EventTypes: []string{"task.created"}}, newSub}, nil)
			case "binding_readded":
				update([]corewebhook.SubscriptionInput{{ID: &ids[0], ProjectID: f.project, EventTypes: []string{"task.paused"}}, newSub}, nil)
				update([]corewebhook.SubscriptionInput{{ID: &ids[0], ProjectID: f.project, EventTypes: []string{"task.paused", "task.created"}}}, nil)
			}
			roots := x509.NewCertPool()
			roots.AddCert(receiver.Certificate())
			runner := webhook.NewRunner(f.db, svc, true)
			runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
			if err := runner.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			defer func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := runner.Stop(ctx); err != nil {
					t.Error(err)
				}
			}()
			expected := "suppressed"
			if scenario == "one_retained" {
				expected = "delivered"
			}
			deadline := time.Now().Add(8 * time.Second)
			for time.Now().Before(deadline) {
				var state string
				var attempts int
				if err := f.db.Pool.QueryRow(f.ctx, `SELECT state,(SELECT count(*) FROM webhook_attempts) FROM webhook_deliveries`).Scan(&state, &attempts); err != nil {
					t.Fatal(err)
				}
				if state == expected {
					if expected == "suppressed" && attempts != 0 {
						t.Fatal("new proof admitted history")
					}
					if expected == "delivered" && attempts != 1 {
						t.Fatal("retained proof did not admit")
					}
					return
				}
				select {
				case err := <-runner.Failures():
					t.Fatalf("runner failure: %v", err)
				case <-time.After(20 * time.Millisecond):
				}
			}
			t.Fatal("delivery did not reach expected state")
		})
	}
}

func TestDeliveryRunsAfterSourceHTTPContextCancelled(t *testing.T) {
	received := make(chan struct{}, 1)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		received <- struct{}{}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	f := newCaptureFixture(t, 1)
	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
	var endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}}
	if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	token := secret.Random("dnst_")
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE sessions SET token_hash=$1 WHERE id=$2`, secret.Hash(token), f.principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	identity := identityservice.New(f.db, nil, "https://daynight.example/api/v1/auth/callback")
	auth, err := authhttp.NewAuthentication(identity, config.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	taskhttp.TaskRoutes(mux, taskservice.NewTasks(f.db, f.capture), auth, logger)
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+f.project+"/tasks", strings.NewReader(`{"title":"source HTTP"}`)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://daynight.example")
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: token})
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, req)
	if response.Code != http.StatusCreated {
		t.Fatalf("source HTTP status=%d body=%s", response.Code, response.Body.String())
	}
	cancel()
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner := webhook.NewRunner(f.db, svc, true)
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	}()
	select {
	case <-received:
	case err := <-runner.Failures():
		t.Fatalf("runner failure: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("source cancellation stopped delivery")
	}
}

func TestDeliveryRegrantDoesNotReviveOriginalEpoch(t *testing.T) {
	f := newCaptureFixture(t, 1)
	var team, endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, f.project).Scan(&team); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	admin, session := uuid.NewString(), uuid.NewString()
	hash := sha256.Sum256([]byte(session))
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, []any{admin}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, admin, hash[:]}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, admin}},
		{`UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, []any{team, f.principal.UserID}},
	} {
		if _, err := f.db.Pool.Exec(f.ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "original epoch"}); err != nil {
		t.Fatal(err)
	}
	var memberVersion int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT version FROM team_members WHERE team_id=$1 AND user_id=$2`, team, f.principal.UserID).Scan(&memberVersion); err != nil {
		t.Fatal(err)
	}
	p := model.Principal{Kind: model.SessionCredential, UserID: admin, CredentialID: session}
	teams := teamservice.NewTeams(f.db)
	if _, err := teams.RemoveMember(f.ctx, p, team, f.principal.UserID, coreteam.ChangeTeamMember{Version: memberVersion, ExpectedUserID: admin}); err != nil {
		t.Fatal(err)
	}
	invitation, err := teams.CreateInvitation(f.ctx, p, team, admin)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = teams.AcceptInvitation(f.ctx, f.principal, invitation.Secret, f.principal.UserID); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), ConfirmProjectIDs: []string{f.project}}
	if _, err = svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	var original, current int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT m.authorization_epoch,s.authorization_epoch FROM webhook_delivery_matches m JOIN webhook_subscriptions s ON s.id=m.subscription_id`).Scan(&original, &current); err != nil || original != 1 || current != 2 {
		t.Fatalf("epochs %d/%d err=%v", original, current, err)
	}
	runner := webhook.NewRunner(f.db, svc, true)
	if err = runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	}()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var state string
		var attempts int
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT state,(SELECT count(*) FROM webhook_attempts) FROM webhook_deliveries`).Scan(&state, &attempts); err != nil {
			t.Fatal(err)
		}
		if state == "suppressed" {
			if attempts != 0 {
				t.Fatal("restored access admitted old epoch")
			}
			return
		}
		select {
		case err := <-runner.Failures():
			t.Fatalf("runner failure: %v", err)
		case <-time.After(20 * time.Millisecond):
		}
	}
	t.Fatal("old epoch was not suppressed")
}
