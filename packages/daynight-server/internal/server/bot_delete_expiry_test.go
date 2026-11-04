package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionrelay"
	"github.com/google/uuid"
)

func TestBotDeleteHTTPRejectsExpiryAfterAdmission(t *testing.T) {
	for _, kind := range []core.CredentialKind{core.PATCredential, core.SessionCredential} {
		for _, replay := range []bool{false, true} {
			phase := "intent"
			if replay {
				phase = "replay"
			}
			t.Run(string(kind)+"/"+phase, func(t *testing.T) {
				h := authTestHarness(t)
				cookie := h.login(t, "bot-delete-owner")
				pat := decodeResponse[api.CreatedPersonalAccessToken](t, h.request("POST", "/api/v1/me/tokens", `{"name":"bot-delete","expiresAt":null}`, []*http.Cookie{cookie}, nil, h.auth.origin), 201)
				principal, err := h.auth.identity.Authenticate(context.Background(), core.PATCredential, pat.Token)
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
				defer cancel()
				worker := uuid.NewString()
				if _, err = h.database.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now(),now(),'{}','{}')`, principal.UserID, worker); err != nil {
					t.Fatal(err)
				}
				bots := service.NewBots(h.database)
				configuration := core.BotConfiguration{WorkerID: worker, Cwd: "/workspace", Provider: "codex", Args: []string{}}
				bot, err := bots.Create(ctx, principal, service.CreateBot{ID: uuid.NewString(), Name: "Assistant", Overrides: core.BotOverrides{WorkerID: &worker}, ResolvedConfiguration: configuration})
				if err != nil {
					t.Fatal(err)
				}
				relay := sessionrelay.New(h.database)
				digest := sha256.Sum256([]byte("Use Daynight CLI."))
				bound, err := relay.RegisterBot(ctx, principal, worker, bot.ID, sessionrelay.BotRegistration{BotVersion: bot.Version, Configuration: configuration, RoleConfiguration: core.BotRoleConfiguration{Instructions: "Use Daynight CLI.", Revision: "1", Digest: hex.EncodeToString(digest[:])}, Registration: sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}})
				if err != nil {
					t.Fatal(err)
				}
				v := bound.Session
				if _, err = relay.GrantBot(ctx, principal, worker, bot.ID, sessionrelay.BotGrant{BotVersion: bound.Bot.Version, Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, ExecutionGeneration: v.ExecutionGeneration, Kind: "bootstrap"}}); err != nil {
					t.Fatal(err)
				}
				mux := http.NewServeMux()
				logger := slog.New(slog.NewTextHandler(io.Discard, nil))
				botsRoutes(mux, bots, relay, h.auth, logger)
				h.handler = RequestLogging(logger, mux)
				cookies, authorization, table := []*http.Cookie(nil), []string{"Bearer " + pat.Token}, "personal_access_tokens"
				if kind == core.SessionCredential {
					cookies, authorization, table = []*http.Cookie{cookie}, nil, "sessions"
					principal, err = h.auth.identity.Authenticate(ctx, kind, cookie.Value)
					if err != nil {
						t.Fatal(err)
					}
				}
				path := "/api/v1/me/bots/" + bot.ID
				body := jsonBody(t, map[string]any{"ifVersion": strconv.FormatInt(bound.Bot.Version, 10), "deletionId": uuid.NewString()})
				request := func() *httptest.ResponseRecorder {
					return h.request("DELETE", path, body, cookies, authorization, h.auth.origin)
				}
				if replay {
					decodeResponse[api.Bot](t, request(), 200)
				}
				state := func() string {
					t.Helper()
					var value string
					if err := h.database.Pool.QueryRow(ctx, `SELECT jsonb_build_object('bot',to_jsonb(b),'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM task_sessions s WHERE s.bot_id=b.id))::text FROM bots b WHERE b.id=$1`, bot.ID).Scan(&value); err != nil {
						t.Fatal(err)
					}
					return value
				}
				before := state()
				lock, err := h.database.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer lock.Rollback(context.Background())
				if _, err = lock.Exec(ctx, "SELECT id FROM bots WHERE id=$1 FOR UPDATE", bot.ID); err != nil {
					t.Fatal(err)
				}
				if _, err = h.database.Pool.Exec(ctx, "UPDATE "+table+" SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", principal.CredentialID); err != nil {
					t.Fatal(err)
				}
				result := make(chan *httptest.ResponseRecorder, 1)
				go func() { result <- request() }()
				ticker := time.NewTicker(5 * time.Millisecond)
				defer ticker.Stop()
				wait := func(query string, args ...any) {
					t.Helper()
					for {
						var ready bool
						if err := h.database.Pool.QueryRow(ctx, query, args...).Scan(&ready); err != nil {
							t.Fatal(err)
						}
						if ready {
							return
						}
						select {
						case <-ctx.Done():
							t.Fatal(ctx.Err())
						case <-ticker.C:
						}
					}
				}
				wait(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid)))`, int32(lock.Conn().PgConn().PID()))
				wait("SELECT expires_at<=clock_timestamp() FROM "+table+" WHERE id=$1", principal.CredentialID)
				if err = lock.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				select {
				case response := <-result:
					assertProjectError(t, response, 401, "unauthenticated")
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if state() != before {
					t.Fatal("expired HTTP deletion changed Bot or Session authorization")
				}
				if _, err = h.database.Pool.Exec(ctx, "UPDATE "+table+" SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1", principal.CredentialID); err != nil {
					t.Fatal(err)
				}
				deleted := decodeResponse[api.Bot](t, request(), 200)
				committed := state()
				repeated := decodeResponse[api.Bot](t, request(), 200)
				if repeated.Version != deleted.Version || state() != committed {
					t.Fatal("valid HTTP replay changed committed state")
				}
			})
		}
	}
}
