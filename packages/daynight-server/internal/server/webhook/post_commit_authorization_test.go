package webhook_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	httpwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	identity "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
)

type completedWrite struct {
	completion store.Completion
	err        error
}

type postCommitGate struct {
	store.WebhookTransactions
	completed chan completedWrite
	resume    chan struct{}
}

func (g *postCommitGate) WriteWebhook(ctx context.Context, owner wm.Owner, operationID string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
	completion, err := g.WebhookTransactions.WriteWebhook(ctx, owner, operationID, fn)
	g.completed <- completedWrite{completion, err}
	select {
	case <-g.resume:
	case <-ctx.Done():
		return completion, ctx.Err()
	}
	return completion, err
}

type gatedHTTPResult struct {
	status int
	header http.Header
	body   []byte
	err    error
}

func TestHTTPCommittedWriteWhenResponseAuthorizationChanges(t *testing.T) {
	for _, scenario := range []string{"credential revoked", "team membership removed"} {
		t.Run(scenario, func(t *testing.T) {
			f := newHTTPFixture(t)
			actor := f.actor(t)
			ownerID := actor.id
			path := "/api/v1/me/webhooks"
			if scenario == "team membership removed" {
				ownerID = uuid.NewString()
				path = "/api/v1/teams/" + ownerID + "/webhooks"
				if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO teams(id,name) VALUES($1,'shared')`, ownerID); err != nil {
					t.Fatal(err)
				}
				if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, ownerID, actor.id); err != nil {
					t.Fatal(err)
				}
			}
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			identityService := identity.New(f.db, nil, testOrigin+"/auth/callback")
			authenticator, err := auth.NewAuthentication(identityService, config.AuthSettings{PublicOrigin: testOrigin, AllowHTTPTestOrigin: true}, logger)
			if err != nil {
				t.Fatal(err)
			}
			gate := &postCommitGate{WebhookTransactions: f.db, completed: make(chan completedWrite, 1), resume: make(chan struct{})}
			mux := http.NewServeMux()
			httpwebhook.NewRoutes(&service.Service{DB: gate, ConfigurationExpansionAvailable: true}, authenticator, logger).RegisterRoutes(mux)
			server := httptest.NewServer(mux)
			defer server.Close()
			defer func() {
				select {
				case <-gate.resume:
				default:
					close(gate.resume)
				}
			}()
			destination := "https://receiver.example/private-path?token=private-query"
			fields := createFields(actor, "commit before revoke", destination)
			body := encoded(t, fields)
			operationID := fields["operationId"].(string)
			result := make(chan gatedHTTPResult, 1)
			go func() {
				r, err := http.NewRequestWithContext(f.ctx, http.MethodPost, server.URL+path, strings.NewReader(body))
				if err != nil {
					result <- gatedHTTPResult{err: err}
					return
				}
				r.AddCookie(&http.Cookie{Name: "daynight_session", Value: actor.cookie})
				r.Header.Set("Origin", testOrigin)
				r.Header.Set("Content-Type", "application/json")
				response, err := server.Client().Do(r)
				if err != nil {
					result <- gatedHTTPResult{err: err}
					return
				}
				defer response.Body.Close()
				b, err := io.ReadAll(response.Body)
				result <- gatedHTTPResult{status: response.StatusCode, header: response.Header, body: b, err: err}
			}()
			select {
			case finished := <-gate.completed:
				if finished.err != nil || finished.completion.Outcome != store.TransactionCommitted {
					t.Fatalf("write did not commit: %#v %v", finished.completion, finished.err)
				}
			case <-f.ctx.Done():
				t.Fatal(f.ctx.Err())
			}
			var endpointID, hash string
			var endpointCount, receiptCount int
			err = f.db.Pool.QueryRow(f.ctx, `SELECT o.endpoint_id::text,encode(o.request_sha256,'hex'),(SELECT count(*) FROM webhook_endpoints e WHERE e.owner_id=$1),(SELECT count(*) FROM webhook_operations r WHERE r.owner_id=$1) FROM webhook_operations o WHERE o.owner_id=$1 AND o.operation_id=$2`, ownerID, operationID).Scan(&endpointID, &hash, &endpointCount, &receiptCount)
			sum := sha256.Sum256([]byte(body))
			if err != nil || endpointID == "" || endpointCount != 1 || receiptCount != 1 || hash != hex.EncodeToString(sum[:]) {
				t.Fatalf("committed effect endpoint=%s endpoints=%d receipts=%d hash=%s err=%v", endpointID, endpointCount, receiptCount, hash, err)
			}
			if scenario == "credential revoked" {
				_, err = f.db.Pool.Exec(f.ctx, `DELETE FROM sessions WHERE user_id=$1`, actor.id)
			} else {
				_, err = f.db.Pool.Exec(f.ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, ownerID, actor.id)
			}
			if err != nil {
				t.Fatal(err)
			}
			close(gate.resume)
			select {
			case received := <-result:
				if received.err != nil || received.status != http.StatusServiceUnavailable || !strings.Contains(string(received.body), `"code":"write_outcome_unknown"`) || received.header.Get("Cache-Control") != "no-store" || received.header.Get("Daynight-User-ID") != actor.id {
					t.Fatalf("response status=%d headers=%v body=%s err=%v", received.status, received.header, received.body, received.err)
				}
				if strings.Contains(string(received.body), "private-path") || strings.Contains(string(received.body), "private-query") || strings.Contains(logs.String(), "private-path") || strings.Contains(logs.String(), "private-query") {
					t.Fatal("post-commit failure exposed destination in response or logs")
				}
			case <-f.ctx.Done():
				t.Fatal(f.ctx.Err())
			}
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_id=$2 AND operation_id=$3)`, endpointID, ownerID, operationID).Scan(&endpointCount, &receiptCount); err != nil || endpointCount != 1 || receiptCount != 1 {
				t.Fatalf("effect disappeared: endpoints=%d receipts=%d err=%v", endpointCount, receiptCount, err)
			}
		})
	}
}
