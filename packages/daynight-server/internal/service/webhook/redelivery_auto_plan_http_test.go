package webhook_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	webhookhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

// Every initial automatic and subsequent manual observation uses the real
// runner and controlled TLS receiver; HTTP registration uses production routes.
func TestRedeliveryHTTPPreservesAutomaticPlan(t *testing.T) {
	for _, mode := range []string{"open manual failure", "open manual success", "closed after acknowledgement"} {
		t.Run(mode, func(t *testing.T) {
			f := newCaptureFixture(t, 1)
			requests := make(chan observedRequest, 4)
			var status atomic.Int64
			if mode == "closed after acknowledgement" {
				status.Store(http.StatusAccepted)
			} else {
				status.Store(http.StatusInternalServerError)
			}
			svc, transport := remainingReceiver(t, f, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				body, err := io.ReadAll(req.Body)
				if err != nil {
					t.Error(err)
				}
				requests <- observedRequest{body: body, id: req.Header.Get("Webhook-Id"), timestamp: req.Header.Get("Webhook-Timestamp"), signature: req.Header.Get("Webhook-Signature")}
				w.WriteHeader(int(status.Load()))
			}))
			svc.DispatchEnabled = true
			if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "automatic budget"}); err != nil {
				t.Fatal(err)
			}
			var endpoint, delivery, event string
			var configVersion int64
			var original []byte
			var originalDeadline time.Time
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.endpoint_id::text,d.id::text,d.event_id::text,d.body,d.automatic_expires_at,e.config_version FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id`).Scan(&endpoint, &delivery, &event, &original, &originalDeadline, &configVersion); err != nil {
				t.Fatal(err)
			}
			runner := remainingRunner(t, f, svc, transport)
			receive := func() observedRequest {
				t.Helper()
				select {
				case got := <-requests:
					if got.id != event || !bytes.Equal(got.body, original) || got.timestamp == "" || got.signature == "" {
						t.Fatal("receiver lost original identity, bytes or authentication")
					}
					return got
				case err := <-runner.Failures():
					t.Fatalf("runner failure: %v", err)
				case <-time.After(10 * time.Second):
					t.Fatal("receiver timeout")
				}
				return observedRequest{}
			}
			receive()
			initialState := "pending"
			if mode == "closed after acknowledgement" {
				initialState = "delivered"
			}
			remainingWait(t, f, runner, func() bool {
				var state string
				var count int
				return f.db.Pool.QueryRow(f.ctx, `SELECT state,attempt_sequence FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&state, &count) == nil && state == initialState && count == 1
			})
			stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := runner.Stop(stopCtx); err != nil {
				cancel()
				t.Fatal(err)
			}
			cancel()
			var priorTicket int64
			var beforeOpen bool
			var autoCount int
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT queue_order,automatic_open,automatic_attempt_count FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&priorTicket, &beforeOpen, &autoCount); err != nil || autoCount != 1 || beforeOpen != (mode != "closed after acknowledgement") {
				t.Fatalf("automatic starting state open=%t count=%d err=%v", beforeOpen, autoCount, err)
			}
			token := secret.Random("dnst_")
			if _, err := f.db.Pool.Exec(f.ctx, `UPDATE sessions SET token_hash=$1 WHERE id=$2`, secret.Hash(token), f.principal.CredentialID); err != nil {
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
			base := host.URL + "/api/v1/me/webhooks/" + endpoint + "/deliveries/" + delivery
			call := func(method, path, body string) (int, []byte) {
				t.Helper()
				req, err := http.NewRequestWithContext(f.ctx, method, base+path, strings.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: token})
				req.Header.Set("Origin", "https://daynight.example")
				req.Header.Set("Content-Type", "application/json")
				res, err := host.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer res.Body.Close()
				b, err := io.ReadAll(res.Body)
				if err != nil || res.Header.Get("Daynight-User-ID") != f.principal.UserID || res.Header.Get("Cache-Control") != "no-store" {
					t.Fatalf("HTTP headers/read: %v", err)
				}
				return res.StatusCode, b
			}
			var initialAck *time.Time
			if mode == "closed after acknowledgement" {
				code, b := call(http.MethodGet, "", "")
				var view struct {
					LastAcknowledgedAt *time.Time `json:"lastAcknowledgedAt"`
				}
				if code != 200 || json.Unmarshal(b, &view) != nil || view.LastAcknowledgedAt == nil {
					t.Fatalf("initial acknowledgement: %d %s", code, b)
				}
				initialAck = view.LastAcknowledgedAt
			}
			operation := uuid.NewString()
			body := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"ifVersion":%q,"ifGeneration":"1"}`, operation, time.Now().UTC().Format(time.RFC3339Nano), f.principal.UserID, fmt.Sprint(configVersion))
			code, b := call(http.MethodPost, "/redeliveries", body)
			if code != http.StatusAccepted {
				t.Fatalf("registration: %d %s", code, b)
			}
			var manualTicket int64
			var generation int64
			var manualCount, seq int
			var trigger string
			if err = f.db.Pool.QueryRow(f.ctx, `SELECT queue_order,generation,manual_operation_count,attempt_sequence,trigger,automatic_attempt_count FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&manualTicket, &generation, &manualCount, &seq, &trigger, &autoCount); err != nil || manualTicket <= priorTicket || generation != 2 || manualCount != 1 || seq != 1 || trigger != "manual" || autoCount != 1 {
				t.Fatalf("registered intent ticket=%d prior=%d gen=%d manual=%d seq=%d trigger=%s auto=%d err=%v", manualTicket, priorTicket, generation, manualCount, seq, trigger, autoCount, err)
			}
			if mode == "open manual success" {
				status.Store(http.StatusAccepted)
			} else {
				status.Store(http.StatusInternalServerError)
			}
			runner = remainingRunner(t, f, svc, transport)
			receive()
			wantState := "pending"
			if mode == "open manual success" {
				wantState = "delivered"
			}
			if mode == "closed after acknowledgement" {
				wantState = "failed"
			}
			remainingWait(t, f, runner, func() bool {
				var state string
				var count int
				return f.db.Pool.QueryRow(f.ctx, `SELECT state,attempt_sequence FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&state, &count) == nil && state == wantState && count == 2
			})
			var state string
			var open bool
			var next *time.Time
			var ticket int64
			var deadline time.Time
			if err = f.db.Pool.QueryRow(f.ctx, `SELECT state,trigger,automatic_open,next_attempt_at,queue_order,automatic_expires_at,automatic_attempt_count,manual_operation_count,attempt_sequence FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&state, &trigger, &open, &next, &ticket, &deadline, &autoCount, &manualCount, &seq); err != nil {
				t.Fatal(err)
			}
			if state != wantState || autoCount != 1 || manualCount != 1 || seq != 2 || !deadline.Equal(originalDeadline) {
				t.Fatalf("post-manual state=%s counts=%d/%d/%d deadline=%v err=%v", state, autoCount, manualCount, seq, deadline, err)
			}
			if mode == "open manual failure" {
				if !open || trigger != "automatic" || next == nil || !next.Before(deadline) || ticket <= manualTicket {
					t.Fatalf("original plan not requeued: open=%t trigger=%s next=%v tickets=%d/%d", open, trigger, next, manualTicket, ticket)
				}
			} else if open || next != nil {
				t.Fatalf("closed automatic cycle reopened: open=%t next=%v", open, next)
			}
			code, b = call(http.MethodGet, "", "")
			var view struct {
				LastAcknowledgedAt *time.Time `json:"lastAcknowledgedAt"`
				LastResult         *struct {
					Category string `json:"category"`
				} `json:"lastResult"`
			}
			if code != 200 || json.Unmarshal(b, &view) != nil || view.LastResult == nil {
				t.Fatalf("diagnostic: %d %s", code, b)
			}
			if mode == "closed after acknowledgement" && (view.LastAcknowledgedAt == nil || !view.LastAcknowledgedAt.Equal(*initialAck) || view.LastResult.Category != "http_error") {
				t.Fatalf("historical acknowledgement lost: %s", b)
			}
			var automaticAttempts, manualAttempts int
			if err = f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FILTER(WHERE trigger='automatic'),count(*) FILTER(WHERE trigger='manual' AND manual_operation_id=$2) FROM webhook_attempts WHERE delivery_id=$1`, delivery, operation).Scan(&automaticAttempts, &manualAttempts); err != nil || automaticAttempts != 1 || manualAttempts != 1 {
				t.Fatalf("attempt history auto=%d manual=%d err=%v", automaticAttempts, manualAttempts, err)
			}
		})
	}
}

func TestRedeliveryHTTPRejectsIneligibleWithoutSending(t *testing.T) {
	for _, kind := range []string{"paused", "revoked", "changed target", "expired"} {
		t.Run(kind, func(t *testing.T) {
			f := newCaptureFixture(t, 1)
			requests := make(chan struct{}, 4)
			svc, transport := remainingReceiver(t, f, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests <- struct{}{}
				w.WriteHeader(http.StatusAccepted)
			}))
			svc.DispatchEnabled = true
			if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "ineligible source"}); err != nil {
				t.Fatal(err)
			}
			var endpoint, delivery string
			var configVersion, oldTicket int64
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.endpoint_id::text,d.id::text,d.queue_order,e.config_version FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id`).Scan(&endpoint, &delivery, &oldTicket, &configVersion); err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='failed',automatic_open=false,next_attempt_at=NULL,terminal_at=clock_timestamp() WHERE id=$1`, delivery); err != nil {
				t.Fatal(err)
			}
			owner := webhook.Owner{Kind: "personal", ID: f.principal.UserID}
			wantCode, wantStatus := "delivery_stopped", http.StatusConflict
			switch kind {
			case "paused", "changed target":
				m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: configVersion, RequestSHA256: strings.Repeat("a", 64)}
				if kind == "paused" {
					disabled := false
					m.Enabled = &disabled
				} else {
					m.Destination = &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://changed.example/private"}
					wantCode = "target_changed"
				}
				if _, err := svc.Mutate(f.ctx, f.principal, owner, m); err != nil {
					t.Fatal(err)
				}
				configVersion++
			case "revoked":
				var team string
				var memberVersion int64
				if err := f.db.Pool.QueryRow(f.ctx, `SELECT o.team_id::text,m.version FROM project_ownership o JOIN team_members m ON m.team_id=o.team_id AND m.user_id=$2 WHERE o.project_id=$1`, f.project, f.principal.UserID).Scan(&team, &memberVersion); err != nil {
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
				if _, err := teamservice.NewTeams(f.db).RemoveMember(f.ctx, principal, team, f.principal.UserID, coreteam.ChangeTeamMember{Version: memberVersion, ExpectedUserID: admin}); err != nil {
					t.Fatal(err)
				}
			case "expired":
				shiftRetentionOccurrence(t, &retentionHTTP{f: f, delivery: delivery}, "8 days")
				wantCode, wantStatus = "payload_expired", http.StatusGone
			}
			token := secret.Random("dnst_")
			if _, err := f.db.Pool.Exec(f.ctx, `UPDATE sessions SET token_hash=$1 WHERE id=$2`, secret.Hash(token), f.principal.CredentialID); err != nil {
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
			runner := remainingRunner(t, f, svc, transport)
			operation := uuid.NewString()
			body := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"ifVersion":%q,"ifGeneration":"1"}`, operation, time.Now().UTC().Format(time.RFC3339Nano), f.principal.UserID, fmt.Sprint(configVersion))
			req, err := http.NewRequestWithContext(f.ctx, http.MethodPost, host.URL+"/api/v1/me/webhooks/"+endpoint+"/deliveries/"+delivery+"/redeliveries", strings.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: token})
			req.Header.Set("Origin", "https://daynight.example")
			req.Header.Set("Content-Type", "application/json")
			res, err := host.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			b, err := io.ReadAll(res.Body)
			res.Body.Close()
			if err != nil || res.StatusCode != wantStatus || !strings.Contains(string(b), `"code":"`+wantCode+`"`) || res.Header.Get("Daynight-User-ID") != f.principal.UserID || res.Header.Get("Cache-Control") != "no-store" {
				t.Fatalf("rejection status=%d body=%s err=%v", res.StatusCode, b, err)
			}
			select {
			case <-requests:
				t.Fatal("ineligible redelivery reached TLS receiver")
			case err := <-runner.Failures():
				t.Fatalf("runner failure: %v", err)
			case <-time.After(time.Second):
			}
			var generation, ticket int64
			var manual, seq, receipts int
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT generation,queue_order,manual_operation_count,attempt_sequence,(SELECT count(*) FROM webhook_operations WHERE operation_id=$2) FROM webhook_deliveries WHERE id=$1`, delivery, operation).Scan(&generation, &ticket, &manual, &seq, &receipts); err != nil || generation != 1 || ticket != oldTicket || manual != 0 || seq != 0 || receipts != 0 {
				t.Fatalf("ineligible effects gen=%d ticket=%d manual=%d attempts=%d receipts=%d err=%v", generation, ticket, manual, seq, receipts, err)
			}
		})
	}
}
