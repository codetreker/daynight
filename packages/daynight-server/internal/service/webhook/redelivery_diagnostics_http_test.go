package webhook_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	webhookhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

type diagnosticLogBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *diagnosticLogBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}
func (b *diagnosticLogBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type diagnosticObservedStore struct {
	store.WebhookTransactions
	failures chan error
}

func (d *diagnosticObservedStore) WriteWebhook(ctx context.Context, o wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
	completion, err := d.WebhookTransactions.WriteWebhook(ctx, o, id, fn)
	d.failures <- err
	return completion, err
}

func TestRedeliveryHTTPDatabaseDiagnosticDoesNotExposeSecrets(t *testing.T) {
	r := newRetentionHTTP(t, false)
	const injectedURL = "https://private-canary.example/secret-path?token=query-canary"
	const injectedAuth = "Authorization: Bearer header-canary"
	const injectedPayload = "payload-canary-content"
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `CREATE FUNCTION refuse_redelivery_secret() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='delivery.redeliver' THEN RAISE EXCEPTION 'https://private-canary.example/secret-path?token=query-canary Authorization: Bearer header-canary payload-canary-content'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_redelivery_secret BEFORE INSERT ON webhook_operations FOR EACH ROW EXECUTE FUNCTION refuse_redelivery_secret()`); err != nil {
		t.Fatal(err)
	}
	pat := secret.Random("dnpat_")
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'diagnostic',now(),now()+interval '1 day')`, uuid.NewString(), r.f.principal.UserID, secret.Hash(pat)); err != nil {
		t.Fatal(err)
	}
	type snapshot struct {
		generation, ticket                              int64
		manual, sequence, automatic, attempts, receipts int
		state                                           string
	}
	observe := func() snapshot {
		t.Helper()
		var x snapshot
		if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT generation,queue_order,manual_operation_count,attempt_sequence,automatic_attempt_count,state,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=$1),(SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver') FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&x.generation, &x.ticket, &x.manual, &x.sequence, &x.automatic, &x.state, &x.attempts, &x.receipts); err != nil {
			t.Fatal(err)
		}
		return x
	}
	before := observe()
	var logs diagnosticLogBuffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	auth, err := authhttp.NewAuthentication(identityservice.New(r.f.db, nil, "https://daynight.example/auth/callback"), config.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	observed := &diagnosticObservedStore{WebhookTransactions: r.f.db, failures: make(chan error, 1)}
	svc := &webhook.Service{DB: observed, ConfigurationExpansionAvailable: true, DispatchEnabled: true}
	mux := http.NewServeMux()
	webhookhttp.NewRoutes(svc, auth, logger).RegisterRoutes(mux)
	host := httptest.NewServer(httpx.RequestLogging(logger, mux))
	defer host.Close()
	operation := uuid.NewString()
	requestID := uuid.NewString()
	body := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"ifVersion":"1","ifGeneration":"1"}`, operation, time.Now().UTC().Format(time.RFC3339Nano), r.f.principal.UserID)
	path := "/api/v1/me/webhooks/" + r.endpoint + "/deliveries/" + r.delivery + "/redeliveries"
	req, err := http.NewRequestWithContext(r.f.ctx, http.MethodPost, host.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+pat)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-ID", requestID)
	resp, err := host.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	response, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 503 || resp.Header.Get("Daynight-User-ID") != r.f.principal.UserID || resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("X-Request-ID") != requestID || !bytes.Contains(response, []byte(`"code":"dependency_unavailable"`)) {
		t.Fatalf("response status=%d headers=%v body=%s", resp.StatusCode, resp.Header, response)
	}
	var failure error
	select {
	case failure = <-observed.failures:
	case <-r.f.ctx.Done():
		t.Fatal(r.f.ctx.Err())
	}
	var pgErr *pgconn.PgError
	if !errors.As(failure, &pgErr) || pgErr.Code != "P0001" || !strings.Contains(pgErr.Message, injectedURL) || !strings.Contains(pgErr.Message, injectedAuth) || !strings.Contains(pgErr.Message, injectedPayload) {
		t.Fatalf("expected injected database failure: %v", failure)
	}
	if after := observe(); after != before {
		t.Fatalf("failure left partial effects before=%+v after=%+v", before, after)
	}
	all := logs.String() + string(response)
	for _, sensitive := range []string{injectedURL, "private-canary.example", "secret-path", "query-canary", injectedAuth, "header-canary", injectedPayload, pat} {
		if strings.Contains(all, sensitive) {
			t.Fatalf("response or logs contain sensitive marker %q", sensitive)
		}
	}
	found := false
	scanner := bufio.NewScanner(strings.NewReader(logs.String()))
	for scanner.Scan() {
		var entry map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			t.Fatalf("invalid log: %v", err)
		}
		if entry["component"] == "webhook" && entry["phase"] == "redeliver" && entry["error_code"] == "dependency_unavailable" {
			if entry["user_id"] != r.f.principal.UserID || entry["endpoint_id"] != r.endpoint || entry["delivery_id"] != r.delivery || entry["request_id"] != requestID {
				t.Fatalf("missing safe correlation: %v", entry)
			}
			found = true
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("missing correlated webhook failure log")
	}
}
