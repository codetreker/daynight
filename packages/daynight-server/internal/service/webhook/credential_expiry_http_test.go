package webhook_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	httpwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

// A credential can expire while its FOR SHARE read waits on a row lock.
func TestHTTPCredentialExpiresWhileWaitingForCredentialLock(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	user, session, token := uuid.NewString(), uuid.NewString(), secret.Random("dnst_")
	if _, err = db.Pool.Exec(ctx, `INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$2,now(),now())`, user, user); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),clock_timestamp()+interval '4 seconds')`, session, user, secret.Hash(token)); err != nil {
		t.Fatal(err)
	}
	lock, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(context.Background())
	var blocker int32
	if err = lock.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blocker); err != nil {
		t.Fatal(err)
	}
	if _, err = lock.Exec(ctx, `SELECT id FROM sessions WHERE id=$1 FOR UPDATE`, session); err != nil {
		t.Fatal(err)
	}

	const origin = "http://127.0.0.1:8787"
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	authenticator, err := auth.NewAuthentication(identity.New(db, nil, origin+"/auth/callback"), config.AuthSettings{PublicOrigin: origin, AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	httpwebhook.NewRoutes(&webhook.Service{DB: db, ConfigurationExpansionAvailable: true}, authenticator, logger).RegisterRoutes(mux)
	server := httptest.NewServer(mux)
	defer func() { cancel(); server.Close() }()
	requestBody, err := json.Marshal(map[string]any{
		"operationId": uuid.NewString(), "issuedAt": time.Now().UTC().Format(time.RFC3339Nano), "expectedUserId": user,
		"name": "blocked", "enabled": true, "destination": map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": "https://receiver.example/path"}}, "subscriptions": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/api/v1/me/webhooks", bytes.NewReader(requestBody))
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: "daynight_session", Value: token})
	req.Header.Set("Origin", origin)
	req.Header.Set("Content-Type", "application/json")
	type outcome struct {
		status int
		body   string
		err    error
	}
	result := make(chan outcome, 1)
	go func() {
		response, err := server.Client().Do(req)
		if err != nil {
			result <- outcome{err: err}
			return
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		result <- outcome{status: response.StatusCode, body: string(body), err: err}
	}()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		if err = db.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			t.Logf("observed credential row lock wait for backend %d", blocker)
			break
		}
		select {
		case got := <-result:
			t.Fatalf("request returned before waiting: status=%d error=%v body=%s", got.status, got.err, got.body)
		case <-deadline.C:
			t.Fatal("credential lock wait was not observed")
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
	for {
		var expired bool
		if err = db.Pool.QueryRow(ctx, `SELECT expires_at <= clock_timestamp() FROM sessions WHERE id=$1`, session).Scan(&expired); err != nil {
			t.Fatal(err)
		}
		if expired {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
	if err = lock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-result:
		if got.err != nil || got.status != http.StatusUnauthorized || !strings.Contains(got.body, `"unauthenticated"`) {
			t.Fatalf("expected 401 unauthenticated: status=%d error=%v body=%s", got.status, got.err, got.body)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var endpoints, keysCount, receipts int
	if err = db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1), (SELECT count(*) FROM webhook_signing_keys), (SELECT count(*) FROM webhook_operations WHERE owner_id=$1)`, user).Scan(&endpoints, &keysCount, &receipts); err != nil {
		t.Fatal(err)
	}
	if endpoints != 0 || keysCount != 0 || receipts != 0 {
		t.Fatalf("expired credential wrote endpoint=%d keys=%d receipts=%d", endpoints, keysCount, receipts)
	}
}
