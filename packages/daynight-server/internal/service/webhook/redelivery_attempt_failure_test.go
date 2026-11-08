package webhook_test

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	webhookhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestRedeliveryAttemptInsertFailureNeverSends(t *testing.T) {
	requests := make(chan struct{}, 1)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests <- struct{}{}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	f := newCaptureFixture(t, 1)
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true, DispatchEnabled: true}
	var endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	owner := webhook.Owner{Kind: "personal", ID: f.principal.UserID}
	_, err := svc.Mutate(f.ctx, f.principal, owner, webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL + "/hook"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "manual attempt failure"}); err != nil {
		t.Fatal(err)
	}
	var delivery string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.id::text,e.config_version FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id`).Scan(&delivery, &version); err != nil {
		t.Fatal(err)
	}
	token := secret.Random("dnst_")
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE sessions SET token_hash=$1 WHERE id=$2`, secret.Hash(token), f.principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	auth, err := authhttp.NewAuthentication(identityservice.New(f.db, nil, "https://daynight.example/auth/callback"), config.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	webhookhttp.NewRoutes(svc, auth, logger).RegisterRoutes(mux)
	host := httptest.NewServer(mux)
	defer host.Close()
	operation := uuid.NewString()
	body := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"ifVersion":%q,"ifGeneration":"1"}`, operation, time.Now().UTC().Format(time.RFC3339Nano), f.principal.UserID, fmt.Sprint(version))
	req, err := http.NewRequestWithContext(f.ctx, http.MethodPost, host.URL+"/api/v1/me/webhooks/"+endpoint+"/deliveries/"+delivery+"/redeliveries", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: token})
	req.Header.Set("Origin", "https://daynight.example")
	req.Header.Set("Content-Type", "application/json")
	response, err := host.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	responseBody, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusAccepted || response.Header.Get("Daynight-User-ID") != f.principal.UserID || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("manual intent: status=%d headers=%v body=%s", response.StatusCode, response.Header, responseBody)
	}
	type snapshot struct {
		generation, ticket                              int64
		manual, sequence, automatic, attempts, receipts int
	}
	observe := func() snapshot {
		t.Helper()
		var x snapshot
		err := f.db.Pool.QueryRow(f.ctx, `SELECT generation,queue_order,manual_operation_count,attempt_sequence,automatic_attempt_count,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=$1),(SELECT count(*) FROM webhook_operations WHERE operation_id=$2 AND kind='delivery.redeliver') FROM webhook_deliveries WHERE id=$1`, delivery, operation).Scan(&x.generation, &x.ticket, &x.manual, &x.sequence, &x.automatic, &x.attempts, &x.receipts)
		if err != nil {
			t.Fatal(err)
		}
		return x
	}
	before := observe()
	if before.generation != 2 || before.manual != 1 || before.sequence != 0 || before.automatic != 0 || before.attempts != 0 || before.receipts != 1 {
		t.Fatalf("initial intent: %+v", before)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `CREATE FUNCTION refuse_manual_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected attempt failure'; END $$; CREATE TRIGGER refuse_manual_attempt BEFORE INSERT ON webhook_attempts FOR EACH ROW EXECUTE FUNCTION refuse_manual_attempt()`); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner := newTestRunner(f.db, svc, true)
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err = runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if e := runner.Stop(ctx); e != nil {
			t.Error(e)
		}
	}()
	select {
	case failure := <-runner.Failures():
		var pgErr *pgconn.PgError
		if !errors.As(failure, &pgErr) || pgErr.Code != "P0001" || pgErr.Message != "injected attempt failure" {
			t.Fatalf("unexpected runner failure: %v", failure)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("attempt failure was not observed")
	}
	stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	err = runner.Stop(stop)
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	if after := observe(); after != before {
		t.Fatalf("failed admission changed counters, generation, ticket or receipt: before=%+v after=%+v", before, after)
	}
	select {
	case <-requests:
		t.Fatal("request sent despite failed manual admission")
	default:
	}
}
