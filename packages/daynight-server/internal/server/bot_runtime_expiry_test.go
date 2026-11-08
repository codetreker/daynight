package server

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
)

func TestBotRuntimeHTTPChecksCredentialAfterUnchangedBotLockWait(t *testing.T) {
	for _, operation := range []string{"register", "report", "report_replay"} {
		for _, expired := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/expired=%t", operation, expired), func(t *testing.T) {
				db := projectTestStore(t)
				h := projectTestHandler(t, db, io.Discard)
				worker := uuid.NewString()
				reportSnapshotHTTP(t, h, worker, workerSnapshotReportBody())
				bot := seedHTTPBot(t, db, h, worker)
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				base := "/api/v1/me/workers/" + worker + "/bots/" + bot.ID
				path := base + "/report"
				body := map[string]any{"botVersion": "1", "fence": nil, "controllerId": "", "controllerInstanceId": "", "nativeSessionId": nil, "result": map[string]any{"state": "failed", "code": "directory_missing"}}
				if operation == "register" {
					path = base + "/register"
					instructions := "Use the Daynight CLI."
					body = map[string]any{"botVersion": "1", "registration": sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}, "configuration": bot.ResolvedConfiguration, "roleConfiguration": map[string]any{"instructions": instructions, "revision": "v1", "digest": fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}}
				} else if operation == "report_replay" {
					decodeResponse[api.Bot](t, projectRequest(h, http.MethodPost, path, jsonBody(t, body)), http.StatusOK)
					body["botVersion"] = "2"
				}
				before := botRuntimeStoredState(t, ctx, db, bot.ID)
				lock, err := db.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer lock.Rollback(context.Background())
				if _, err = lock.Exec(ctx, "SELECT id FROM bots WHERE id=$1 FOR UPDATE", bot.ID); err != nil {
					t.Fatal(err)
				}
				if expired {
					if _, err = db.Pool.Exec(ctx, "UPDATE personal_access_tokens SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", h.principal.CredentialID); err != nil {
						t.Fatal(err)
					}
				}
				request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(jsonBody(t, body))).WithContext(ctx)
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("X-Request-ID", "project-test")
				authorizeResourceRequest(h, request)
				response, finished := httptest.NewRecorder(), make(chan struct{})
				go func() { h.ServeHTTP(response, request); close(finished) }()
				defer func() {
					_ = lock.Rollback(context.Background())
					cancel()
					select {
					case <-finished:
					case <-time.After(3 * time.Second):
						t.Error("Bot request did not stop during cleanup")
					}
				}()
				// Match the owning blocker and schema, not an unrelated test's waiter.
				botRuntimeWait(t, ctx, finished, func() (bool, error) {
					var waiting bool
					err := db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT id::text FROM bots WHERE id=%')`, int32(lock.Conn().PgConn().PID())).Scan(&waiting)
					return waiting, err
				})
				if expired {
					botRuntimeWait(t, ctx, finished, func() (bool, error) {
						var expired bool
						err := db.Pool.QueryRow(ctx, "SELECT expires_at<=clock_timestamp() FROM personal_access_tokens WHERE id=$1", h.principal.CredentialID).Scan(&expired)
						return expired, err
					})
				}
				// Commit the lock holder without changing any Bot fields or its version.
				if err = lock.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				select {
				case <-finished:
				case <-ctx.Done():
					t.Fatal("Bot request did not finish after releasing its lock")
				}
				if expired {
					assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
					if after := botRuntimeStoredState(t, ctx, db, bot.ID); after != before {
						t.Fatal("expired PAT changed Bot, role, Session or preferences")
					}
					return
				}
				if operation == "register" {
					type registrationResult struct {
						Bot     api.Bot     `json:"bot"`
						Session sp.Snapshot `json:"session"`
					}
					out := decodeResponse[registrationResult](t, response, http.StatusOK)
					if out.Bot.Version != 2 || out.Bot.RoleConfiguration == nil || out.Bot.SessionID == nil || *out.Bot.SessionID != out.Session.SessionID {
						t.Fatal("valid PAT did not bind the role and Session")
					}
					registered := botRuntimeStoredState(t, ctx, db, bot.ID)
					replay := decodeResponse[registrationResult](t, projectRequest(h, http.MethodPost, path, jsonBody(t, body)), http.StatusOK)
					if jsonBody(t, replay.Bot) != jsonBody(t, out.Bot) || replay.Session.SessionID != out.Session.SessionID || replay.Session.TestExecutionID != out.Session.TestExecutionID || botRuntimeStoredState(t, ctx, db, bot.ID) != registered {
						t.Fatal("valid registration replay changed its result")
					}
				} else {
					out := decodeResponse[api.Bot](t, response, http.StatusOK)
					if out.Version != 2 || out.StartupResult.State != "failed" || out.StartupResult.Code == nil || *out.StartupResult.Code != "directory_missing" || out.SessionID != nil || out.RoleConfiguration != nil {
						t.Fatal("valid PAT changed preflight semantics")
					}
					body["botVersion"] = "2"
					replay := decodeResponse[api.Bot](t, projectRequest(h, http.MethodPost, path, jsonBody(t, body)), http.StatusOK)
					if jsonBody(t, replay) != jsonBody(t, out) {
						t.Fatal("valid failure replay changed its result")
					}
					if operation == "report_replay" && botRuntimeStoredState(t, ctx, db, bot.ID) != before {
						t.Fatal("valid failure replay changed persisted state")
					}
				}
			})
		}
	}
}

func botRuntimeStoredState(t *testing.T, ctx context.Context, db *postgres.Store, id string) string {
	t.Helper()
	var state string
	if err := db.Pool.QueryRow(ctx, `SELECT jsonb_build_object('bot',to_jsonb(b),'sessions',(SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM task_sessions s WHERE s.bot_id=b.id),'workerPreferences',(SELECT COALESCE(jsonb_agg(to_jsonb(p)),'[]'::jsonb) FROM bot_worker_preferences p WHERE p.user_id=b.owner_user_id),'configurationPreferences',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.worker_id),'[]'::jsonb) FROM bot_configuration_preferences p WHERE p.user_id=b.owner_user_id))::text FROM bots b WHERE b.id=$1`, id).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func botRuntimeWait(t *testing.T, ctx context.Context, finished <-chan struct{}, check func() (bool, error)) {
	t.Helper()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		ok, err := check()
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			return
		}
		select {
		case <-finished:
			t.Fatal("Bot request finished before the required lock/expiry observation")
		case <-ctx.Done():
			t.Fatal("Bot lock/expiry observation timed out")
		case <-ticker.C:
		}
	}
}
